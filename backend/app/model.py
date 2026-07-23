import io
import logging
from statistics import median

import torch
from efficientnet_pytorch import EfficientNet
from PIL import Image
from torchvision import transforms

from app import diffusion_model, faceswap_model, scene_model
from app.preprocessing import crop_largest_face

logger = logging.getLogger("certiface.model")

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
model = EfficientNet.from_name('efficientnet-b0', num_classes=2)
model.load_state_dict(torch.load('models/Detector_De_Sintesis_GAN.pth', map_location=device))
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
    "La firma de generación aparece en el rostro pero no en el resto del "
    "encuadre (contraprueba de contexto negativa): patrón compatible con "
    "filtros de embellecimiento o procesado de cámara sobre video auténtico, "
    "no con video generado. Requiere revisión humana."
)

CAVEAT_CLOSEUP = (
    "Señal únicamente del detector de generación (difusión), y el rostro "
    "ocupa la mayor parte del encuadre, por lo que no es posible contrastar "
    "la firma contra el entorno. Los filtros de embellecimiento y el "
    "procesado de cámara pueden producir esta firma en material auténtico. "
    "Requiere revisión humana: valorar las métricas por familia."
)

# Zona gris: por debajo del umbral de condena (0.5) pero por encima del rango
# observado en material auténtico limpio (≤ ~0.2). Un generador moderno puede
# dejar una firma atenuada que cae justo aquí — verificado con un video 100 %
# generado que puntuó 0.34. En esta franja el sistema no certifica nada.
GRAY_LIMIT = 0.3

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
# modelo más caro del sistema (~27 s por imagen en CPU), así que solo se
# invoca para resolver ambigüedades, y sobre este número de fotogramas.
SCENE_PROBES = 2


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


def _resolve_reservation(label, gan_signal, swap_signal, context_images, min_eligible):
    """Resuelve una condena firmada solo por el detector de difusión.

    Un filtro de embellecimiento actúa sobre el rostro; la generación
    fabrica el encuadre completo. Cuando GAN y face swap están limpios, la
    sonda de escena examina encuadres enteros (solo si hay suficientes
    fotogramas donde el rostro no domina):

    - firma también fuera del rostro → generación global → condena plena;
    - firma solo en el rostro → patrón de filtro → "Suspect";
    - sin encuadres contrastables (primer plano) → "Suspect" prudente.

    Devuelve (label, caveat, mediana_de_escena | None).
    """
    diffusion_only = (
        label == "Fake"
        and gan_signal < CORROBORATION_LIMIT
        and swap_signal < CORROBORATION_LIMIT
    )
    if not diffusion_only:
        return label, None, None

    if len(context_images) >= min_eligible:
        ctx = _scene_probe(context_images)
        logger.info(
            "Sonda de escena (contraprueba): mediana=%.4f → %s",
            ctx,
            "generación global (condena plena)" if ctx > 0.5 else "firma localizada (reserva)",
        )
        if ctx > 0.5:
            return "Fake", None, ctx
        return "Suspect", CAVEAT_LOCALIZED, ctx

    logger.info(
        "Sonda de escena no aplicable: el rostro domina el encuadre en los "
        "fotogramas disponibles."
    )
    return "Suspect", CAVEAT_CLOSEUP, None


def _apply_gray_zone(label, confidence, generation_signal, probe_images):
    """Resuelve un "Real" cuya señal de generación cae en la zona gris.

    La sonda de escena decide: si el encuadre completo también delata
    generación (> 0.5), la firma débil del rostro queda corroborada y la
    condena es plena; si no, el resultado queda inconcluso ("Suspect") — el
    sistema no certifica autenticidad con una señal sin explicar.
    Devuelve (label, confidence, caveat, mediana_de_escena | None).
    """
    if label == "Real" and generation_signal >= GRAY_LIMIT:
        scene = _scene_probe(probe_images)
        if scene is not None:
            logger.info(
                "Sonda de escena (zona gris): mediana=%.4f → %s",
                scene,
                "generación corroborada (condena plena)" if scene > 0.5 else "inconcluso",
            )
            if scene > 0.5:
                return "Fake", round(scene * 100, 2), None, scene
        return "Suspect", round(generation_signal * 100, 2), CAVEAT_WEAK, scene
    return label, confidence, None, None


def predict_image(image_bytes: bytes):
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    face, found = crop_largest_face(image)
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
    label, caveat, ctx = _resolve_reservation(
        label, p_gan, p_swap, context_images, min_eligible=1
    )
    if not caveat and ctx is None:
        label, confidence, caveat, ctx = _apply_gray_zone(
            label, confidence, p_diff, [image]
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
    return result


SUSPECT_THRESHOLD = 0.6  # umbral para señalar un fotograma al perito


def predict_video(frames):
    gan_scores = []
    swap_scores = []
    diff_scores = []
    context_candidates = []  # encuadres completos donde el rostro no domina
    suspects = []
    faces_found = 0

    for i, (frame, timestamp) in enumerate(frames):
        face, found = crop_largest_face(frame)
        faces_found += int(found)
        p_gan = _fake_probability(face)
        p_swap = faceswap_model.fake_probability(face)
        p_diff = diffusion_model.fake_probability(face)
        gan_scores.append(p_gan)
        swap_scores.append(p_swap)
        diff_scores.append(p_diff)
        if found:
            face_fraction = (face.width * face.height) / (frame.width * frame.height)
            if face_fraction <= CONTEXT_FACE_MAX_FRACTION:
                context_candidates.append(frame)
        # Solo el detector de face swap alimenta la lista de sospechosos: el
        # B0 está fuera de su dominio en fotogramas de video "salvajes" y sus
        # picos aislados ahí son ruido (verificado con video auténtico), no
        # indicios revisables. La generación por difusión afecta a todo el
        # video por igual, así que tampoco tiene "momentos" que señalar.
        if p_swap > SUSPECT_THRESHOLD and timestamp is not None:
            suspects.append({"second": timestamp, "score": round(p_swap, 4)})
        logger.info(
            "Fotograma %d/%d (t=%ss): rostro=%s p_gan=%.4f p_swap=%.4f p_diff=%.4f",
            i + 1, len(frames), timestamp, "sí" if found else "no (fotograma completo)",
            p_gan, p_swap, p_diff,
        )

    # GAN y difusión: mediana. La generación afecta a todos los fotogramas
    # por igual, así que el valor central es el representativo; la mediana
    # resiste la minoría de fotogramas atípicos en ambas direcciones (picos
    # de ruido en video auténtico, valles por caras pequeñas o desenfoque en
    # video generado), cosa que la media no hacía. Face swap: segundo máximo,
    # porque sus artefactos son intermitentes y exigimos dos detecciones
    # independientes.
    med_gan = median(gan_scores)
    agg_swap = faceswap_model.aggregate_video(swap_scores)
    med_diff = median(diff_scores)
    p_fake = max(med_gan, agg_swap, med_diff)
    label, confidence = _verdict(p_fake)
    label, caveat, ctx = _resolve_reservation(
        label, med_gan, agg_swap, context_candidates, min_eligible=CONTEXT_MIN_FRAMES
    )
    if not caveat and ctx is None:
        # Para la zona gris se prefieren encuadres donde el rostro no domina;
        # si no los hay (primer plano), se sondea el encuadre tal cual.
        probe_images = context_candidates or [frame for frame, _ts in frames]
        label, confidence, caveat, ctx = _apply_gray_zone(
            label, confidence, med_diff, probe_images
        )

    logger.info(
        "Video: %d fotogramas, %d con rostro | GAN mediana=%.4f | "
        "swap 2º máx=%.4f (máx=%.4f) | difusión mediana=%.4f | "
        "%d sospechosos → %s (%.2f%%)%s",
        len(frames), faces_found, med_gan, agg_swap, max(swap_scores),
        med_diff, len(suspects), label, confidence,
        " [con reserva]" if caveat else "",
    )
    if faces_found == 0:
        logger.warning(
            "Ningún fotograma tenía rostro detectable: el veredicto se emitió "
            "sobre fotogramas completos y pierde fiabilidad."
        )

    result = {
        "prediction": label,
        "confidence": confidence,
        "frames_analyzed": len(frames),
        "faces_detected": faces_found,
        "frame_scores": [
            round(max(g, s, d), 4)
            for g, s, d in zip(gan_scores, swap_scores, diff_scores)
        ],
        "suspicious_seconds": suspects,
        "models": {
            "synthesis_gan": round(med_gan, 4),
            "faceswap_dfdc": round(agg_swap, 4),
            "diffusion_modern": round(med_diff, 4),
        },
    }
    if ctx is not None:
        result["models"]["scene_generated"] = round(ctx, 4)
    if caveat:
        result["caveat"] = caveat
    return result
