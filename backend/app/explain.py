"""Mapa de calor explicativo: EigenCAM fusionado de todos los peritos.

El perito necesita respaldar el dictamen: ver *dónde* miró cada detector y
con cuánta fuerza. Cada modelo aporta su mapa de atención (EigenCAM: primer
componente principal de las activaciones de su última capa convolucional o
de sus tokens de parche — sin gradientes ni dependencias externas), y los
mapas se fusionan por MÁXIMO ponderado por la señal de cada detector en ese
fotograma:

    fusionado(x) = maxᵢ( wᵢ · camᵢ(x) )

de modo que cada punto muestra la evidencia del detector más fuerte en él,
sin que un promedio la diluya. El valor resultante es probabilidad absoluta
y es lo que colorea la escala de riesgo (verde → amarillo → naranja → rojo):
un material auténtico produce zonas verdes y uno manipulado, núcleos rojos.
Los mapas de los tres peritos faciales se reubican en la caja del rostro
dentro del fotograma completo; el de la sonda de escena (cuando corrió y su
lectura fue decisiva) cubre el encuadre entero.

En video se produce **un mapa por cada fotograma analizado**, no solo del más
incriminatorio: el perito recorre los 24 y ve cómo evoluciona la atención de
los detectores a lo largo del video. Para que eso no cueste una segunda
pasada de inferencia, las activaciones se capturan al vuelo durante el
análisis (ver FacialCapture).

Un fallo en cualquier punto de este módulo degrada a "sin mapa": jamás debe
afectar al veredicto.
"""

import base64
import logging
import math

import cv2
import numpy as np
import torch
from PIL import Image

from app import diffusion_model, faceswap_model, scene_model

logger = logging.getLogger("certiface.explain")

MAX_SIDE = 720          # lado mayor del mapa destacado
JPEG_QUALITY = 82
# Los mapas de la tira (uno por fotograma) van algo más pequeños: 24 imágenes
# viajan en la misma respuesta y el detalle sigue siendo suficiente para
# recorrerlos y compararlos.
FRAME_MAX_SIDE = 640
FRAME_JPEG_QUALITY = 80

# El CAM de la sonda de escena solo entra al mapa cuando su lectura fue
# relevante para el veredicto (confirmó o levantó sospecha, ≥ 0.5). Una
# lectura que la decisión descartó como ruido no debe pintar el encuadre:
# el mapa explica lo que decidió, no lo que se descartó.
SCENE_CAM_MIN_WEIGHT = 0.5

# Presentación: la evidencia va en escala de grises y el color queda
# reservado en exclusiva para la señal. El color codifica la INTENSIDAD
# ABSOLUTA con la escala clásica de riesgo (verde → amarillo → naranja →
# rojo): en material auténtico las zonas de atención salen verdes (riesgo
# bajo); en manipulado, con núcleos rojos. Se muestran TODAS las zonas de
# atención en degradado continuo, sin contornos duros.
#
# El mapa se pinta SIEMPRE que haya atención, por débil que sea la señal: un
# fotograma auténtico debe verse en verde suave, no en gris. (Un suelo alto
# dejaba el fotograma sin una sola mancha de color y parecía que el mapa no
# funcionaba.) DRAW_FLOOR queda como último filtro de ruido numérico.
GRAY_DIM = 0.8          # atenuación del fondo gris (resalta el color)
DRAW_FLOOR = 0.01       # pico absoluto mínimo para pintar algo
ZONE_LEVEL = 0.25       # fracción del pico que define una zona de atención
MIN_ZONE_AREA = 0.004   # área mínima de una zona (fracción del encuadre)
SMOOTH_FRACTION = 0.02  # suavizado del CAM, en fracción del lado mayor
ALPHA_MIN = 0.3         # opacidad de las zonas más débiles (verdes)
ALPHA_MAX = 0.72        # opacidad de los núcleos más intensos (rojos)
# Intensidad a partir de la cual la opacidad ya es máxima. Con la señal
# absoluta como referencia, un perito al 60 % ya pinta con toda su fuerza.
ALPHA_FULL_AT = 0.6

# BGR de --hot-orange (#eb4604), el color de manipulación de la interfaz.
_BBOX_COLOR = (4, 70, 235)


def _risk_lut() -> np.ndarray:
    """LUT 256×3 BGR verde→amarillo→naranja→rojo (escala de riesgo)."""
    stops = [
        (0.00, (0, 170, 0)),      # verde
        (0.40, (0, 220, 255)),    # amarillo
        (0.70, (0, 140, 255)),    # naranja
        (1.00, (0, 0, 230)),      # rojo
    ]
    lut = np.zeros((256, 1, 3), dtype=np.uint8)
    for i in range(256):
        t = i / 255.0
        for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
            if t0 <= t <= t1:
                f = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
                lut[i, 0] = [round(a + (b - a) * f) for a, b in zip(c0, c1)]
                break
    return lut


_RISK_LUT = _risk_lut()


def _eigencam(activations: torch.Tensor):
    """Primer componente principal de las activaciones → mapa [H, W] en 0-1.

    EigenCAM no usa gradientes: proyecta las activaciones [C, H, W] sobre su
    primera dirección principal (SVD), lo que resalta las regiones que más
    excitan a la capa. El signo del SVD es arbitrario: se voltea para que
    domine la magnitud positiva antes del ReLU.
    """
    a = activations.detach().float().cpu().numpy()
    channels = a.shape[0]
    height, width = a.shape[1], a.shape[2]

    flat = a.reshape(channels, -1).T          # [H·W, C]
    flat = flat - flat.mean(axis=0, keepdims=True)
    try:
        _, _, vt = np.linalg.svd(flat, full_matrices=False)
    except np.linalg.LinAlgError:
        return None

    proj = flat @ vt[0]                       # [H·W]
    if abs(proj.min()) > abs(proj.max()):
        proj = -proj
    proj = np.maximum(proj, 0)
    peak = proj.max()
    if peak < 1e-8:
        return np.zeros((height, width), dtype=np.float32)
    return (proj / peak).reshape(height, width).astype(np.float32)


def _normalized(cam):
    """Renormaliza un mapa a 0-1 (tras recortes el máximo puede haber caído)."""
    if cam is None:
        return None
    peak = cam.max()
    if peak < 1e-8:
        return np.zeros_like(cam, dtype=np.float32)
    return (cam / peak).astype(np.float32)


def _gan_cam(face: Image.Image):
    """Detector De Síntesis GAN (B0): extract_features → [1280, 7, 7]."""
    # Import perezoso: app.model importa este módulo, y en tiempo de llamada
    # ya está completamente cargado — así se evita el ciclo de imports.
    from app import model as gan_module

    tensor = gan_module.transform(face).unsqueeze(0).to(gan_module.device)
    with torch.no_grad():
        feats = gan_module.model.extract_features(tensor)
    return _eigencam(feats[0])


def _undo_letterbox(cam, face_size):
    """Recorta el CAM del B7 a la región válida de su entrada con letterbox.

    La entrada del B7 lleva resize isotrópico + relleno negro centrado; el
    CAM se recorta con las mismas fórmulas de _to_tensor y se renormaliza,
    para que el mapa corresponda al rostro y no al relleno.
    """
    if cam is None:
        return None
    size = faceswap_model.INPUT_SIZE
    w, h = face_size
    scale = size / max(w, h)
    rw, rh = max(int(w * scale), 1), max(int(h * scale), 1)
    ox, oy = (size - rw) // 2, (size - rh) // 2

    cam_full = cv2.resize(cam, (size, size), interpolation=cv2.INTER_LINEAR)
    return _normalized(cam_full[oy:oy + rh, ox:ox + rw])


def _faceswap_cam(face: Image.Image):
    """Detector De Face Swap (B7): hook en encoder.bn2 → [2560, 12, 12]."""
    captured = {}
    handle = faceswap_model.model.encoder.bn2.register_forward_hook(
        lambda _m, _i, output: captured.update(a=output)
    )
    try:
        with torch.no_grad():
            faceswap_model.model(faceswap_model._to_tensor(face))
    finally:
        handle.remove()

    if "a" not in captured:
        return None
    return _undo_letterbox(_eigencam(captured["a"][0]), face.size)


def _tokens_to_grid(tokens: torch.Tensor):
    """[N, hidden] de un ViT sin CLS → activaciones [hidden, g, g] o None."""
    n = tokens.shape[0]
    g = int(math.isqrt(n))
    if g * g != n:
        logger.warning("Rejilla de parches no cuadrada (%d tokens); se omite el CAM.", n)
        return None
    return tokens.reshape(g, g, -1).permute(2, 0, 1)


def _diffusion_cam(face: Image.Image):
    """Detector De Difusión Facial (SigLIP): tokens 14×14 vía post_layernorm."""
    captured = {}
    handle = diffusion_model.model.vision_model.post_layernorm.register_forward_hook(
        lambda _m, _i, output: captured.update(a=output)
    )
    try:
        inputs = diffusion_model._processor(images=face, return_tensors="pt").to(
            diffusion_model.device
        )
        with torch.no_grad():
            diffusion_model.model(**inputs)
    finally:
        handle.remove()

    if "a" not in captured:
        return None
    grid = _tokens_to_grid(captured["a"][0])
    return _eigencam(grid) if grid is not None else None


class FacialCapture:
    """Recoge los CAM de los tres peritos faciales durante la inferencia.

    Calcular el mapa de los 24 fotogramas re-ejecutando los modelos costaría
    una segunda pasada completa por video. En su lugar se enganchan las capas
    de interés una sola vez y, tras puntuar cada fotograma, se congela su
    EigenCAM — una rejilla diminuta (7×7, 12×12 o 14×14). El coste añadido es
    la SVD de cada fotograma, del orden de milisegundos.

    Cualquier fallo aquí degrada a "sin mapa para ese detector": nunca puede
    afectar al veredicto.
    """

    def __init__(self):
        self._activations = {}
        self._handles = []

    def _remember(self, key):
        def hook(_module, _inputs, output):
            self._activations[key] = output
        return hook

    def __enter__(self):
        # Import perezoso: app.model importa este módulo (evita el ciclo).
        from app import model as gan_module

        anchors = (
            ("synthesis_gan", getattr(gan_module.model, "_bn1", None)),
            ("faceswap_dfdc", faceswap_model.model.encoder.bn2),
            ("diffusion_modern", diffusion_model.model.vision_model.post_layernorm),
        )
        for key, module in anchors:
            if module is None:
                continue
            try:
                self._handles.append(module.register_forward_hook(self._remember(key)))
            except Exception:
                logger.exception("No se pudo enganchar %s; su mapa se omitirá.", key)
        return self

    def __exit__(self, *_exc):
        for handle in self._handles:
            handle.remove()
        self._handles = []
        self._activations = {}
        return False

    def snapshot(self, face_size):
        """CAM del último fotograma puntuado, en el espacio del recorte facial."""
        activations = self._activations
        self._activations = {}
        cams = {}
        try:
            head = activations.get("synthesis_gan")
            if head is not None:
                # extract_features aplica swish tras _bn1: se replica para que
                # el CAM salga del mismo tensor que alimenta al clasificador.
                a = head[0]
                cams["synthesis_gan"] = _eigencam(a * torch.sigmoid(a))

            swap = activations.get("faceswap_dfdc")
            if swap is not None:
                cams["faceswap_dfdc"] = _undo_letterbox(_eigencam(swap[0]), face_size)

            diff = activations.get("diffusion_modern")
            if diff is not None:
                grid = _tokens_to_grid(diff[0])
                if grid is not None:
                    cams["diffusion_modern"] = _eigencam(grid)
        except Exception:
            logger.exception("Fallo al congelar los CAM del fotograma; se omiten.")
            return {}
        return {key: cam for key, cam in cams.items() if cam is not None}


def capture_facial_cams():
    """Contexto que captura los CAM faciales de cada fotograma puntuado."""
    return FacialCapture()


def _scene_cam(frame: Image.Image):
    """Sonda De Escena Generada: torre SigLIP del ensemble, encuadre entero."""
    tower = scene_model.model.siglip
    layernorm = getattr(tower, "post_layernorm", None)
    if layernorm is None:
        layernorm = tower.vision_model.post_layernorm

    captured = {}
    handle = layernorm.register_forward_hook(
        lambda _m, _i, output: captured.update(a=output)
    )
    try:
        if frame.mode != "RGB":
            frame = frame.convert("RGB")
        siglip_pixels = scene_model._siglip_processor(images=frame, return_tensors="pt")[
            "pixel_values"
        ].to(scene_model.device)
        dinov2_pixels = scene_model._dinov2_transform(frame).unsqueeze(0).to(
            scene_model.device
        )
        with torch.no_grad():
            scene_model.model(siglip_pixels, dinov2_pixels)
    finally:
        handle.remove()

    if "a" not in captured:
        return None
    grid = _tokens_to_grid(captured["a"][0])
    return _eigencam(grid) if grid is not None else None


def _attention_zones(fused: np.ndarray, width: int, height: int):
    """Aísla TODAS las zonas de atención del mapa fusionado.

    1) Suavizado gaussiano (~2 % del lado): funde el CAM en manchas
       orgánicas de mapa de calor, sin escalones.
    2) Componentes conexas sobre ZONE_LEVEL (relativo a la estructura del
       mapa): toda zona con área mínima sobrevive — solo se descarta el
       ruido puntual demasiado pequeño para ser una región.
    3) La máscara de zonas se difumina para que el color muera en degradado.

    Devuelve `(valor, presencia)`: el mapa de intensidad ABSOLUTA (0-1, lo
    que colorea la escala de riesgo) y la máscara suavizada de pertenencia
    (0-1, lo que decide cuánto se ve). Separarlos es lo que permite que una
    señal débil se pinte igual de nítida, solo que en verde. `(None, None)`
    si no hay ninguna zona.
    """
    k = max(int(max(width, height) * SMOOTH_FRACTION) | 1, 5)  # kernel impar
    smooth = cv2.GaussianBlur(fused, (k, k), 0)
    top = float(smooth.max())
    if top < 1e-8:
        return None, None
    structure = smooth / top

    mask = (structure >= ZONE_LEVEL).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    min_area = MIN_ZONE_AREA * width * height
    keep = [i for i in range(1, count) if stats[i, cv2.CC_STAT_AREA] >= min_area]
    if not keep:
        return None, None

    zone_mask = np.isin(labels, keep).astype(np.float32)
    soft = cv2.GaussianBlur(zone_mask, (k, k), 0)
    # La presencia combina la pertenencia a la zona con la estructura interna
    # del mapa: el color es pleno en el núcleo y se apaga hacia el borde.
    presence = np.clip(soft * structure, 0.0, 1.0).astype(np.float32)
    return smooth.astype(np.float32), presence


# Extractores faciales en el orden de las claves del contrato de la API.
_FACIAL_EXTRACTORS = {
    "synthesis_gan": _gan_cam,
    "faceswap_dfdc": _faceswap_cam,
    "diffusion_modern": _diffusion_cam,
}


def build_explanation(
    frame: Image.Image,
    bbox,
    weights: dict,
    second=None,
    facial_cams=None,
    with_scene=True,
    max_side=MAX_SIDE,
    quality=JPEG_QUALITY,
):
    """Construye el mapa de calor fusionado sobre el fotograma completo.

    frame: fotograma (o imagen) original. bbox: caja facial (x0, y0, x1, y1)
    en píxeles del fotograma. weights: señal por detector (claves del campo
    "models" de la respuesta). facial_cams: rejillas ya capturadas durante la
    inferencia (ver FacialCapture); si no se pasan, se recalculan con una
    pasada extra por cada modelo. Devuelve el dict del campo "explanation" o
    None si ningún mapa pudo calcularse.
    """
    if frame.mode != "RGB":
        frame = frame.convert("RGB")
    width, height = frame.size
    x0, y0, x1, y1 = (int(v) for v in bbox)
    face = frame.crop((x0, y0, x1, y1))

    cams = {}
    for key, extractor in _FACIAL_EXTRACTORS.items():
        if key not in weights:
            continue
        if facial_cams is not None:
            cam = facial_cams.get(key)
        else:
            try:
                cam = extractor(face)
            except Exception:
                logger.exception("Fallo el CAM del detector %s; se omite.", key)
                cam = None
        if cam is None:
            continue
        canvas = np.zeros((height, width), dtype=np.float32)
        canvas[y0:y1, x0:x1] = cv2.resize(
            cam, (x1 - x0, y1 - y0), interpolation=cv2.INTER_CUBIC
        )
        cams[key] = canvas

    scene_weight = weights.get("scene_generated") if with_scene else None
    if scene_weight is not None and scene_weight >= SCENE_CAM_MIN_WEIGHT:
        try:
            cam = _scene_cam(frame)
        except Exception:
            logger.exception("Fallo el CAM de la sonda de escena; se omite.")
            cam = None
        if cam is not None:
            scene_canvas = cv2.resize(
                cam, (width, height), interpolation=cv2.INTER_CUBIC
            )
            # El CAM de la sonda tiende al moteado en fondos texturados; un
            # difuminado agresivo lo lava a una veladura difusa (su pico cae
            # y no se renormaliza: el ruido pierde intensidad por diseño).
            k = max(int(max(width, height) * 0.07) | 1, 9)
            cams["scene_generated"] = cv2.GaussianBlur(scene_canvas, (k, k), 0)

    if not cams:
        return None

    # Fusión por MÁXIMO ponderado por píxel: cada punto muestra la evidencia
    # del detector más fuerte en ese punto (wᵢ · camᵢ), sin que el promedio
    # diluya la intensidad — un perito al 95 % pinta rojo aunque los demás
    # callen. El valor resultante es probabilidad absoluta (0-1): es lo que
    # colorea la escala de riesgo.
    fused = np.zeros((height, width), dtype=np.float32)
    for k in cams:
        fused = np.maximum(fused, np.clip(weights[k], 0.0, 1.0) * cams[k])

    # Limitar tamaño de salida.
    rgb = np.array(frame)
    if max(width, height) > max_side:
        s = max_side / max(width, height)
        out_w, out_h = int(width * s), int(height * s)
        rgb = cv2.resize(rgb, (out_w, out_h), interpolation=cv2.INTER_AREA)
        fused = cv2.resize(fused, (out_w, out_h), interpolation=cv2.INTER_LINEAR)
        x0, y0, x1, y1 = (int(v * s) for v in (x0, y0, x1, y1))
        width, height = out_w, out_h

    # --- Presentación forense: gris para la evidencia, color para la señal ---
    # 1) Fondo en escala de grises atenuada: cualquier color que se vea es
    #    señal de los detectores, nunca color propio de la imagen.
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    base = cv2.cvtColor((gray * GRAY_DIM).astype(np.uint8), cv2.COLOR_GRAY2BGR)
    out = base.copy()

    peak = float(fused.max())
    if peak >= DRAW_FLOOR:
        value, presence = _attention_zones(fused, width, height)
        if value is not None:
            # El color codifica la intensidad ABSOLUTA con la escala de
            # riesgo verde→amarillo→naranja→rojo: en un video auténtico las
            # zonas de atención salen verdes; en uno manipulado, rojas.
            index = (np.clip(value, 0.0, 1.0) * 255).astype(np.uint8)
            heat = cv2.applyColorMap(index, _RISK_LUT)
            # La zona se ve igual de nítida sea cual sea la señal —lo que
            # cambia es su color—, con el degradado en el borde y algo más
            # de cuerpo en los núcleos intensos.
            strength = ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * np.clip(
                value / ALPHA_FULL_AT, 0.0, 1.0
            )
            alpha = (presence * strength)[..., None]
            out = (base * (1 - alpha) + heat * alpha).astype(np.uint8)

    # Recuadro facial, solo cuando hay una caja real (no el encuadre entero).
    if (x1 - x0) < width or (y1 - y0) < height:
        cv2.rectangle(out, (x0, y0), (x1, y1), _BBOX_COLOR, 2)

    ok, buffer = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        return None

    return {
        "image": "data:image/jpeg;base64," + base64.b64encode(buffer).decode("ascii"),
        "second": second,
        "weights": {k: round(float(weights[k]), 4) for k in cams},
        "width": width,
        "height": height,
    }
