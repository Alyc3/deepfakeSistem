"""Cuarto perito: detector de escena generada.

Los tres peritos anteriores examinan el rostro recortado. Un video generado
íntegramente por IA se delata también —y a veces únicamente— en el resto del
encuadre: fondo, ropa, iluminación, texturas. Esta sonda analiza el fotograma
completo con un ensemble SigLIP2-SO400M + DINOv2-L afinado con LoRA sobre
OpenFake (~100k imágenes generales, 25+ generadores modernos incluidos Flux,
DALL·E 3 y Midjourney), de Bombek1/ai-image-detector-siglip-dinov2 (MIT,
AUC 0.9997, 97 % cross-dataset).

La arquitectura replica exactamente el model.py del autor (auditado); los
pesos se cargan en modo seguro desde un archivo de solo-tensores convertido
una única vez, y la construcción no descarga nada: los configs del backbone
también están en disco (backend/models/Sonda_De_Escena_Generada/).

Nota de coste: es el modelo más pesado del sistema (~740M parámetros), así
que en video se sondea un subconjunto de fotogramas, no los 24.
"""

import json
import logging
import math
import os
from pathlib import Path

import timm
import torch

# El ensemble es intensivo en CPU; usar todos los núcleos disponibles.
torch.set_num_threads(os.cpu_count() or 4)
import torch.nn as nn
from peft import LoraConfig, get_peft_model
from PIL import Image
from torchvision import transforms
from transformers import AutoImageProcessor, SiglipVisionConfig, SiglipVisionModel

logger = logging.getLogger("certiface.scene")

_DIR = Path(__file__).resolve().parent.parent / "models" / "Sonda_De_Escena_Generada"

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

with open(_DIR / "config.json") as f:
    _CFG = json.load(f)


class LoRALinear(nn.Module):
    """Réplica del LoRA del autor para las capas QKV de DINOv2."""

    def __init__(self, original: nn.Linear, rank: int, alpha: float, dropout: float = 0.1):
        super().__init__()
        self.original = original
        self.scaling = alpha / rank
        self.lora_A = nn.Linear(original.in_features, rank, bias=False)
        self.lora_B = nn.Linear(rank, original.out_features, bias=False)
        self.dropout = nn.Dropout(dropout)
        nn.init.kaiming_uniform_(self.lora_A.weight, a=math.sqrt(5))
        nn.init.zeros_(self.lora_B.weight)

    def forward(self, x):
        return self.original(x) + self.lora_B(self.lora_A(self.dropout(x))) * self.scaling


class ClassificationHead(nn.Module):
    def __init__(self, input_dim: int, hidden_dim: int = 512, dropout: float = 0.3):
        super().__init__()
        self.head = nn.Sequential(
            nn.LayerNorm(input_dim),
            nn.Linear(input_dim, hidden_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim // 2, 1),
        )

    def forward(self, x):
        return self.head(x).squeeze(-1)


class EnsembleAIDetector(nn.Module):
    def __init__(self):
        super().__init__()
        # Backbones construidos desde config local: sin descargas.
        siglip_cfg = SiglipVisionConfig.from_pretrained(_DIR / "siglip")
        self.siglip = SiglipVisionModel(siglip_cfg)
        self.dinov2 = timm.create_model(
            _CFG["dinov2_model"],
            pretrained=False,
            num_classes=0,
            img_size=_CFG["image_size"],
        )
        self.classifier = ClassificationHead(
            self.siglip.config.hidden_size + self.dinov2.num_features
        )

    def forward(self, siglip_pixels, dinov2_pixels):
        siglip_features = self.siglip(pixel_values=siglip_pixels).pooler_output
        dinov2_features = self.dinov2(dinov2_pixels)
        combined = torch.cat([siglip_features.float(), dinov2_features], dim=-1)
        return self.classifier(combined)


def _build() -> EnsembleAIDetector:
    model = EnsembleAIDetector()

    lora_config = LoraConfig(
        r=_CFG["lora_rank"],
        lora_alpha=_CFG["lora_alpha"],
        target_modules=["q_proj", "v_proj"],
        lora_dropout=_CFG["lora_dropout"],
        bias="none",
    )
    model.siglip = get_peft_model(model.siglip, lora_config)

    for _name, module in model.dinov2.named_modules():
        if hasattr(module, "qkv") and isinstance(module.qkv, nn.Linear):
            module.qkv = LoRALinear(
                module.qkv, _CFG["lora_rank"], _CFG["lora_alpha"], _CFG["lora_dropout"]
            )

    state = torch.load(_DIR / "weights.pth", map_location="cpu")
    # El checkpoint se guardó con transformers 4.x, donde SiglipVisionModel
    # anidaba sus pesos bajo "vision_model."; transformers 5 aplanó ese
    # nivel. Se remapea al cargar.
    state = {k.replace(".model.vision_model.", ".model."): v for k, v in state.items()}
    # strict=True: cualquier desajuste de arquitectura debe fallar en el
    # arranque, no degradar silenciosamente la precisión.
    model.load_state_dict(state, strict=True)

    # Fusión de los LoRA en los pesos base: matemáticamente equivalente en
    # inferencia y algo más rápida. (Se probó además cuantización dinámica
    # int8: aceleraba ~30 %, pero degradaba el resultado hasta invalidarlo,
    # así que quedó descartada.)
    model.siglip = model.siglip.merge_and_unload()
    for _name, module in model.dinov2.named_modules():
        if hasattr(module, "qkv") and isinstance(module.qkv, LoRALinear):
            lora = module.qkv
            with torch.no_grad():
                lora.original.weight += (
                    lora.lora_B.weight @ lora.lora_A.weight
                ) * lora.scaling
            module.qkv = lora.original
    return model


model = _build().to(device)
model.eval()
logger.info("Detector de escena generada (SigLIP2+DINOv2) cargado en %s", device)

_siglip_processor = AutoImageProcessor.from_pretrained(_DIR / "siglip")
_dinov2_transform = transforms.Compose([
    transforms.Resize(
        (_CFG["image_size"], _CFG["image_size"]),
        interpolation=transforms.InterpolationMode.BICUBIC,
    ),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])


def fake_probability(pil_image: Image.Image) -> float:
    """Probabilidad [0, 1] de que el encuadre completo sea generado por IA."""
    if pil_image.mode != "RGB":
        pil_image = pil_image.convert("RGB")
    siglip_pixels = _siglip_processor(images=pil_image, return_tensors="pt")[
        "pixel_values"
    ].to(device)
    dinov2_pixels = _dinov2_transform(pil_image).unsqueeze(0).to(device)
    with torch.no_grad():
        logits = model(siglip_pixels, dinov2_pixels)
    return torch.sigmoid(logits)[0].item()
