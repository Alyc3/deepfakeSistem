"""Tercer perito: detector de síntesis moderna (difusión).

Los otros dos peritos tienen dominios de otra época: el B0 conoce StyleGAN
(2019) y el B7 el face swap de DFDC (2020). Un video generado íntegramente
por un modelo de difusión actual (Sora, Kling, Runway…) pasa por delante de
ambos sin inmutarlos — verificado empíricamente. Este modelo cubre ese hueco:
SigLIP2 afinado sobre rostros deepfake de generación moderna
(prithivMLmods/deepfake-detector-model-v1, Apache 2.0, 94,4 % de accuracy
reportada sobre 20k imágenes).

Los pesos se sirven desde disco local
(backend/models/Detector_De_Difusion_Facial); no hay descarga en tiempo de
ejecución.
"""

import logging
from pathlib import Path

import torch
from PIL import Image
from transformers import AutoImageProcessor, SiglipForImageClassification

logger = logging.getLogger("certiface.diffusion")

_MODEL_DIR = Path(__file__).resolve().parent.parent / "models" / "Detector_De_Difusion_Facial"

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

_processor = AutoImageProcessor.from_pretrained(_MODEL_DIR)
model = SiglipForImageClassification.from_pretrained(_MODEL_DIR).to(device)
model.eval()

# El config.json declara id2label {0: Fake, 1: Real}; se resuelve por nombre
# para no depender del orden.
_FAKE_INDEX = int(model.config.label2id["Fake"])
logger.info("Detector de síntesis moderna (SigLIP2) cargado en %s", device)


def fake_probability(pil_image: Image.Image) -> float:
    """Probabilidad [0, 1] de que la imagen sea generada por IA."""
    inputs = _processor(images=pil_image, return_tensors="pt").to(device)
    with torch.no_grad():
        logits = model(**inputs).logits
    return torch.softmax(logits, dim=1)[0, _FAKE_INDEX].item()
