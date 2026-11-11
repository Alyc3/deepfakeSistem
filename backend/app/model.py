from pathlib import Path
import io
import logging
from statistics import median

import torch
from efficientnet_pytorch import EfficientNet
from PIL import Image
from torchvision import transforms

from app import diffusion_model, explain, faceswap_model, scene_model
from app.preprocessing import crop_largest_face
from app.video_rule import (
    DECISIVE_VIDEO_DETECTORS,
    SCENE_PROBES,
    SCENE_REAL_LIMIT,
    SWAP_SUSTAIN_FRAMES,
    sustained_level,
    video_verdict,
)

logger = logging.getLogger("certiface.model")

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
model = EfficientNet.from_name('efficientnet-b0', num_classes=2)
model.load_state_dict(torch.load(Path(__file__).resolve().parent.parent / 'models' / 'Detector_De_Sintesis_GAN.pth', map_location=device, weights_only=True))
model = model.to(device)
model.eval()
logger.info("Modelo cargado en %s", device)

transform = transforms.Compose([
    transforms.Resize((224, 224)),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])

# Convención de clases del entrenamiento: índice 0 = Fake, índice 1 = Real.


def _fake_probability(pil_image: Image.Image) -> float:
    """Probabilidad de la clase Fake para una imagen ya recortada."""
    tensor = transform(pil_image).unsqueeze(0).to(device)
    with torch.no_grad():
        probabilities = torch.softmax(model(tensor), dim=1)
    return probabilities[0][0].item()


# Tres peritos por muestra, cada uno especialista en una familia de
# manipulación: el B0 propio en síntesis GAN clásica (StyleGAN), el B7 de
# DFDC en face swap, y el SigLIP2 en generación moderna por difusión. El
# veredicto final lo da el que más alarma levante: basta con que una familia
# esté presente.


# Por debajo de este nivel, un perito se considera "limpio" y no corrobora.
CORROBORATION_LIMIT = 0.3

# Contraprueba de contexto: solo tiene sentido si el rostro NO domina el
# encuadre (si lo ocupa casi todo, rostro y encuadre son lo mismo y no se
# puede separar filtro de generación).
CONTEXT_FACE_MAX_FRACTION = 0.5
CONTEXT_MIN_FRAMES = 6

CAVEAT_LOCALIZED = (
    "Firma de generación fuerte en el rostro pero no en el resto del "
    "encuadre. Este patrón tiene dos explicaciones incompatibles que las "
    "métricas no pueden separar: filtros de embellecimiento intensos sobre "
    "video auténtico, o un face swap de generación moderna (rostro generado "
    "insertado en escena real). Requiere revisión humana: examinar bordes "
    "del rostro, transiciones y coherencia de identidad."
)

CAVEAT_FILTERED = (
    "Se detectó señal de generación en el rostro, pero el patrón completo la "
    "atribuye a filtros o procesado de cámara sobre material auténtico: la "
    "señal facial es moderada, el entorno está limpio (sonda de escena) y ni "
    "GAN ni face swap corroboran. Si el caso lo exige, verificar visualmente "
    "la presencia de filtros."
)

# Barreras de la atribución a filtro, calibradas con casos reales de ambas
# clases: señal facial moderada (< 0.7 — el real filtrado observado da 0.55;
# los generados y el filtro extremo dan ≥ 0.88) y entorno claramente limpio
# (< 0.3 — el real observado da 0.29). Con señal facial fuerte, la decisión
# es siempre del perito humano aunque el entorno esté limpio.
STRONG_FACE_LIMIT = 0.7
SCENE_CLEAN_LIMIT = 0.3

CAVEAT_CLOSEUP = (
    "Señal únicamente del detector de generación (difusión), y el rostro "
    "ocupa la mayor parte del encuadre, por lo que no es posible contrastar "
    "la firma contra el entorno. Los filtros de embellecimiento y el "
    "procesado de cámara pueden producir esta firma en material auténtico. "
    "Requiere revisión humana: valorar las métricas por familia."
)

# Zona gris: por debajo del umbral de condena (0.5) pero por encima del rango
# observado en material auténtico limpio. Calibrado con casos reales de ambas
# clases: el video auténtico más alto observado da mediana de difusión 0.19,
# mientras que videos 100 % generados con motores recientes han puntuado 0.34
# (1.mp4) y 0.27 (Gemini) — el límite en 0.25 deja margen a ambos lados. En
# esta franja el sistema no certifica nada: decide la sonda de escena.
GRAY_LIMIT = 0.25

# Umbrales de la Sonda De Escena, calibrados con las lecturas acumuladas
# sobre material auténtico: 0.246, 0.286, 0.467 y 0.482 — su ruido sobre
# video real llega casi a 0.5, así que ningún umbral de esa zona es seguro.
#
# - SUSPECT (0.55): por encima, el entorno es no concluyente → "Suspect".
# - SOLO (0.75): condena EN SOLITARIO (peritos faciales en silencio); exige
#   un margen amplio sobre el ruido real porque no hay corroboración.
# - CONFIRM (0.6): confirma una condena facial ya existente (ruta de
#   reserva); el listón es menor porque hay dos señales coincidentes.
#
# Pendiente de contraste: aún no hay lecturas de escena sobre video generado
# — cuando existan, estos tres valores deben revisarse con ellas.
SCENE_SUSPECT_LIMIT = 0.55
SCENE_SOLO_LIMIT = 0.75
SCENE_CONFIRM_LIMIT = 0.6

CAVEAT_WEAK = (
    "Señal débil de generación: por debajo del umbral de condena, pero por "
    "encima del rango observado en material auténtico limpio. Los generadores "
    "más recientes pueden dejar firmas atenuadas en esta franja. El resultado "
    "es inconcluso — no se certifica autenticidad. Requiere revisión humana."
)


def _verdict(p_fake: float):
    label = "Fake" if p_fake > 0.5 else "Real"
    confidence = p_fake if label == "Fake" else 1 - p_fake
    return label, round(confidence * 100, 2)


# La sonda de escena (SigLIP2+DINOv2 sobre el encuadre completo) es el
# modelo más caro del sistema (~20-27 s por imagen en CPU). SCENE_PROBES
# (app.video_rule) fija cuántos encuadres se sondean como máximo.


def _scene_probe(images):
    """Mediana de la sonda de escena sobre hasta SCENE_PROBES imágenes
    repartidas. None si no hay imágenes."""
    if not images:
        return None
    if len(images) > SCENE_PROBES:
        step = len(images) // SCENE_PROBES
        images = images[::step][:SCENE_PROBES]
    scores = [scene_model.fake_probability(img) for img in images]
    return median(scores)


def _resolve_reservation(
    label, gan_signal, swap_signal, face_signal, context_images, min_eligible
):
    """Resuelve una condena firmada solo por el detector de difusión.

    Un filtro de embellecimiento actúa sobre el rostro; la generación
    fabrica el encuadre completo. Cuando GAN y face swap están limpios, la
    sonda de escena examina encuadres enteros (solo si hay suficientes
    fotogramas donde el rostro no domina):

    - firma también fuera del rostro → generación global → condena plena;
    - señal facial moderada y entorno claramente limpio → patrón de filtro
      sobre material auténtico → "Real" con nota de atribución;
    - señal facial fuerte, o entorno no concluyente → "Suspect": decide el
      perito (con señal ≥ 0.7 conviven el filtro extremo y el video
      generado, indistinguibles sin revisión humana);
    - sin encuadres contrastables (primer plano) → "Suspect" prudente.

    Devuelve (label, caveat, mediana_de_escena | None, confianza | None).
    """
    diffusion_only = (
        label == "Fake"
        and gan_signal < CORROBORATION_LIMIT
        and swap_signal < CORROBORATION_LIMIT
    )
    if not diffusion_only:
        return label, None, None, None

    if len(context_images) >= min_eligible:
        ctx = _scene_probe(context_images)
        if ctx > SCENE_CONFIRM_LIMIT:
            outcome = "generación global (condena plena)"
        elif ctx < SCENE_CLEAN_LIMIT and face_signal < STRONG_FACE_LIMIT:
            outcome = "señal facial moderada con entorno limpio (filtro; Real con nota)"
        else:
            outcome = "firma localizada o señal fuerte (reserva)"
        logger.info("Sonda de escena (contraprueba): mediana=%.4f → %s", ctx, outcome)

        if ctx > SCENE_CONFIRM_LIMIT:
            return "Fake", None, ctx, None
        if ctx < SCENE_CLEAN_LIMIT and face_signal < STRONG_FACE_LIMIT:
            # La confianza se apoya en la evidencia no contaminada: el
            # entorno. (La señal facial queda explicada por el filtro.)
            return "Real", CAVEAT_FILTERED, ctx, round((1 - ctx) * 100, 2)
        return "Suspect", CAVEAT_LOCALIZED, ctx, None

    logger.info(
        "Sonda de escena no aplicable: el rostro domina el encuadre en los "
        "fotogramas disponibles."
    )
    return "Suspect", CAVEAT_CLOSEUP, None, None


def _verify_real(label, confidence, generation_signal, probe_images):
    """Verificación final de todo veredicto "Real" con la sonda de escena.

    Motivo, verificado empíricamente: los generadores más recientes pueden
    dejar el rostro casi limpio (mediana facial 0.13 en un video 100 %
    generado, por debajo del real más alto observado), de modo que la única
    evidencia disponible es el encuadre completo. La sonda actúa como
    segunda opinión sistemática antes de certificar:

    - escena > SCENE_SOLO_LIMIT (0.75) → generación global → condena plena
      (el listón alto es deliberado: aquí la sonda condena EN SOLITARIO,
      con los peritos faciales en silencio, y su ruido sobre material real
      llega casi a 0.5);
    - escena ≥ SCENE_SUSPECT_LIMIT (0.55), o señal facial en zona gris
      (≥ 0.25) → "Suspect";
    - escena limpia y señal facial baja → "Real" verificado (la lectura de
      escena queda registrada en la respuesta como evidencia positiva).

    Devuelve (label, confidence, caveat, mediana_de_escena | None).
    """
    if label != "Real":
        return label, confidence, None, None

    scene = _scene_probe(probe_images) if probe_images else None

    if scene is not None:
        if scene > SCENE_SOLO_LIMIT:
            outcome = "generación global (condena plena)"
        elif scene >= SCENE_SUSPECT_LIMIT or generation_signal >= GRAY_LIMIT:
            outcome = "no concluyente (inconcluso)"
        else:
            outcome = "entorno limpio (Real verificado)"
        logger.info(
            "Sonda de escena (verificación de Real): mediana=%.4f → %s",
            scene, outcome,
        )
        if scene > SCENE_SOLO_LIMIT:
            return "Fake", round(scene * 100, 2), None, scene
        if scene >= SCENE_SUSPECT_LIMIT or generation_signal >= GRAY_LIMIT:
            signal = max(scene, generation_signal)
            return "Suspect", round(signal * 100, 2), CAVEAT_WEAK, scene
        return "Real", confidence, None, scene

    # Sin encuadres sondeables (primer plano): solo la señal facial decide
    # si el resultado es certificable o queda inconcluso.
    if generation_signal >= GRAY_LIMIT:
        return "Suspect", round(generation_signal * 100, 2), CAVEAT_WEAK, None
    return "Real", confidence, None, None


def predict_image(image_bytes: bytes):
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    face, found, bbox = crop_largest_face(image)
    if not found:
        logger.warning(
            "Imagen %dx%d: no se detectó rostro; se analiza la imagen completa "
            "(el veredicto pierde fiabilidad)", image.width, image.height,
        )

    p_gan = _fake_probability(face)
    p_swap = faceswap_model.fake_probability(face)
    p_diff = diffusion_model.fake_probability(face)
    p_fake = max(p_gan, p_swap, p_diff)
    label, confidence = _verdict(p_fake)

    face_fraction = (face.width * face.height) / (image.width * image.height)
    context_images = (
        [image] if found and face_fraction <= CONTEXT_FACE_MAX_FRACTION else []
    )
    label, caveat, ctx, conf_override = _resolve_reservation(
        label, p_gan, p_swap, p_diff, context_images, min_eligible=1
    )
    if conf_override is not None:
        confidence = conf_override
    if not caveat and ctx is None:
        # La señal de generación combina ambos detectores de esa familia:
        # GAN y difusión delatan lo mismo (contenido fabricado) por vías
        # distintas, y un generador moderno puede rozar en una y no en otra.
        # Si el rostro domina la imagen, la sonda examina la imagen tal
        # cual: no distingue entorno, pero es la opinión de un modelo
        # independiente entrenado en otra distribución.
        label, confidence, caveat, ctx = _verify_real(
            label, confidence, max(p_diff, p_gan), context_images or [image]
        )
    logger.info(
        "Imagen %dx%d: rostro=%s p_gan=%.4f p_swap=%.4f p_diff=%.4f → %s (%.2f%%)%s",
        image.width, image.height, "sí" if found else "no",
        p_gan, p_swap, p_diff, label, confidence,
        " [con reserva]" if caveat else "",
    )

    result = {
        "prediction": label,
        "confidence": confidence,
        "faces_detected": int(found),
        "models": {
            "synthesis_gan": round(p_gan, 4),
            "faceswap_dfdc": round(p_swap, 4),
            "diffusion_modern": round(p_diff, 4),
        },
    }
    if ctx is not None:
        result["models"]["scene_generated"] = round(ctx, 4)
    if caveat:
        result["caveat"] = caveat

    # Mapa de calor explicativo: fusiona los CAM de todos los peritos que
    # participaron. Un fallo aquí nunca afecta al veredicto.
    weights = {"synthesis_gan": p_gan, "faceswap_dfdc": p_swap, "diffusion_modern": p_diff}
    if ctx is not None:
        weights["scene_generated"] = ctx
    try:
        explanation = explain.build_explanation(image, bbox, weights)
        if explanation:
            result["explanation"] = explanation
    except Exception:
        logger.exception("No se pudo generar el mapa de calor; el dictamen se emite sin él.")
    return result


SUSPECT_THRESHOLD = 0.6  # umbral para señalar un fotograma al perito

def _video_scene_probes(frames, pool, scene_callback=None):
    """Sonda de escena sobre SCENE_PROBES fotogramas repartidos de `pool`.

    pool: índices de fotogramas candidatos. Mismo muestreo que _scene_probe.
    Devuelve [(índice, puntuación)]; una sonda que falla se omite.
    """
    picks = list(pool)
    if len(picks) > SCENE_PROBES:
        picks = picks[::len(picks) // SCENE_PROBES][:SCENE_PROBES]
    readings = []
    for number, index in enumerate(picks, 1):
        if scene_callback:
            scene_callback(number, len(picks))
        try:
            readings.append((index, scene_model.fake_probability(frames[index][0])))
        except Exception:
            logger.exception("Falló la sonda de escena en el fotograma %d; se omite.", index + 1)
    return readings


def predict_video(frames, progress_callback=None, scene_callback=None):
    gan_scores = []
    swap_scores = []
    diff_scores = []
    found_flags = []
    context_indices = []  # fotogramas donde el rostro no domina el encuadre
    suspects = []
    bboxes = []       # caja facial de cada fotograma (para su mapa de calor)
    frame_cams = []   # CAM de cada fotograma, capturados durante la inferencia

    # Los CAM se congelan al vuelo mientras los peritos puntúan: así el mapa
    # de los 24 fotogramas no cuesta una segunda pasada de inferencia.
    with explain.capture_facial_cams() as capture:
        for i, (frame, timestamp) in enumerate(frames):
            face, found, bbox = crop_largest_face(frame)
            p_gan = _fake_probability(face)
            p_swap = faceswap_model.fake_probability(face)
            p_diff = diffusion_model.fake_probability(face)
            gan_scores.append(p_gan)
            swap_scores.append(p_swap)
            diff_scores.append(p_diff)
            found_flags.append(found)
            bboxes.append(bbox)
            frame_cams.append(capture.snapshot(face.size))
            if found:
                face_fraction = (face.width * face.height) / (frame.width * frame.height)
                if face_fraction <= CONTEXT_FACE_MAX_FRACTION:
                    context_indices.append(i)
            # Solo el face swap señala momentos, y solo con rostro: sin rostro
            # el B7 mira el fotograma entero (rótulos, cortinillas) y su
            # lectura no es un indicio revisable.
            if found and p_swap > SUSPECT_THRESHOLD and timestamp is not None:
                suspects.append({"second": timestamp, "score": round(p_swap, 4)})
            logger.info(
                "Fotograma %d/%d (t=%ss): rostro=%s p_gan=%.4f p_swap=%.4f p_diff=%.4f",
                i + 1, len(frames), timestamp,
                "sí" if found else "no (fotograma completo)",
                p_gan, p_swap, p_diff,
            )
            if progress_callback:
                progress_callback(i + 1, len(frames), timestamp, found,
                                  p_swap if found else 0.0)

    faces_found = sum(found_flags)
    # Face swap: continuidad sobre los fotogramas CON rostro, en orden.
    face_swaps = [s for s, f in zip(swap_scores, found_flags) if f]
    swap_sustained = sustained_level(face_swaps, SWAP_SUSTAIN_FRAMES)
    swap_pair = sustained_level(face_swaps, 2)

    # Escena: se prefieren encuadres donde el rostro no domina; en un primer
    # plano se sondea el fotograma tal cual (no distingue entorno, pero es la
    # opinión de un modelo independiente).
    readings = _video_scene_probes(frames, context_indices or range(len(frames)), scene_callback)
    scene = median([score for _, score in readings]) if readings else None

    # GAN y difusión: mediana sobre los fotogramas con rostro. No condenan
    # (ver la calibración junto a SWAP_FRAME_LIMIT); la GAN solo actúa como
    # salvaguarda contra certificar autenticidad.
    gan_faces = [g for g, f in zip(gan_scores, found_flags) if f] or gan_scores
    diff_faces = [d for d, f in zip(diff_scores, found_flags) if f] or diff_scores
    med_gan = median(gan_faces)
    med_diff = median(diff_faces)

    label, confidence, caveat = video_verdict(scene, swap_sustained, swap_pair, med_gan)

    logger.info(
        "Video: %d fotogramas, %d con rostro | face swap sostenido=%.4f "
        "(pareja=%.4f) | escena mediana=%s en %d sondas | orientativos: "
        "GAN=%.4f difusión=%.4f → %s (%.2f%%)%s",
        len(frames), faces_found, swap_sustained, swap_pair,
        "—" if scene is None else f"{scene:.4f}", len(readings),
        med_gan, med_diff, label, confidence,
        " [con reserva]" if caveat else "",
    )
    if faces_found == 0:
        logger.warning(
            "Ningún fotograma tenía rostro detectable: el veredicto se emitió "
            "solo con la sonda de escena y pierde fiabilidad."
        )

    # Señal por fotograma = la del detector que decide fotograma a fotograma.
    frame_signal = [s if f else 0.0 for s, f in zip(swap_scores, found_flags)]
    models = {
        "synthesis_gan": round(med_gan, 4),
        "faceswap_dfdc": round(swap_sustained, 4),
        "diffusion_modern": round(med_diff, 4),
    }
    if scene is not None:
        models["scene_generated"] = round(scene, 4)
    result = {
        "prediction": label,
        "confidence": confidence,
        "frames_analyzed": len(frames),
        "faces_detected": faces_found,
        "frame_scores": [round(v, 4) for v in frame_signal],
        "suspicious_seconds": suspects,
        "models": models,
        "decisive_models": [k for k in DECISIVE_VIDEO_DETECTORS if k in models],
        "scene_probes": [{"index": i, "second": frames[i][1], "score": round(s, 4)} for i, s in readings],
    }
    if caveat:
        result["caveat"] = caveat

    # Fotograma destacado: el que mejor ilustra lo que decidió. Con condena
    # (o duda) por escena, la sonda más alta; si no, el mayor disparo de face
    # swap con rostro.
    scene_led = scene is not None and scene >= max(swap_sustained, SCENE_REAL_LIMIT)
    if scene_led and readings:
        best_index, featured_scene = max(readings, key=lambda item: item[1])
    else:
        best_index = max(range(len(frames)), key=lambda i: frame_signal[i])
        featured_scene = scene

    # Mapa de calor explicativo: uno por cada fotograma analizado más el
    # destacado. Un fallo aquí nunca afecta al veredicto.
    try:
        explanation = _video_explanation(
            frames, bboxes, frame_cams, frame_signal, found_flags, best_index,
            featured_scene,
        )
        if explanation:
            result["explanation"] = explanation
            logger.info(
                "Mapa de calor: %d fotogramas ilustrados, destacado t=%ss",
                len(explanation.get("frames", [])), explanation.get("second"),
            )
    except Exception:
        logger.exception(
            "No se pudo generar el mapa de calor; el dictamen se emite sin él."
        )
    return result


def _video_explanation(frames, bboxes, frame_cams, frame_signal, found_flags,
                       best_index, scene):
    """Mapas de calor del video: uno por fotograma, más el destacado.

    Cada fotograma se colorea con el detector que decide fotograma a
    fotograma (face swap) y con su propia puntuación, así que la tira muestra
    dónde y cuándo se sostiene el intercambio. GAN y difusión no pintan: en
    la calibración teñían de rojo el 97 % de los videos auténticos. La sonda
    de escena es una lectura de encuadre completo y solo entra en el
    destacado.
    """
    strip = []
    for i, (frame, timestamp) in enumerate(frames):
        try:
            entry = explain.build_explanation(
                frame, bboxes[i], {"faceswap_dfdc": frame_signal[i]},
                second=timestamp, facial_cams=frame_cams[i], with_scene=False,
                max_side=explain.FRAME_MAX_SIDE,
                quality=explain.FRAME_JPEG_QUALITY,
            )
        except Exception:
            logger.exception("No se pudo generar el mapa del fotograma %d.", i + 1)
            continue
        if entry is None:
            continue
        entry["index"] = i
        entry["signal"] = round(frame_signal[i], 4)
        strip.append(entry)

    featured_weights = {"faceswap_dfdc": frame_signal[best_index]}
    if scene is not None:
        featured_weights["scene_generated"] = scene
    featured = explain.build_explanation(
        frames[best_index][0], bboxes[best_index], featured_weights,
        second=frames[best_index][1], facial_cams=frame_cams[best_index],
    )
    if featured is None:
        return None

    featured["featured_index"] = best_index
    featured["frames"] = strip
    return featured
