"""Descarga y prepara los pesos grandes que no se versionan en git.

GitHub limita los archivos a 100 MB, así que los tres pesos de terceros
(re-descargables de sus fuentes oficiales) quedan fuera del repositorio y
este script los reconstruye con exactamente las mismas transformaciones que
se aplicaron al incorporarlos (ver backend/models/README.md, sección
"Enlaces De Origen").

Uso, desde backend/ y con el venv activado:

    python scripts/fetch_models.py

Es idempotente: lo que ya existe no se vuelve a descargar.
"""

import sys
import urllib.request
from pathlib import Path

MODELS = Path(__file__).resolve().parent.parent / "models"

FACESWAP_URL = (
    "https://github.com/selimsef/dfdc_deepfake_challenge/releases/download/0.0.1/"
    "final_888_DeepFakeClassifier_tf_efficientnet_b7_ns_0_40"
)


def fetch_faceswap():
    """Detector De Face Swap: checkpoint del ganador de DFDC → solo-tensores."""
    target = MODELS / "Detector_De_Face_Swap.pth"
    if target.exists():
        print(f"✓ {target.name} ya existe")
        return

    import torch

    tmp = target.with_suffix(".download")
    print(f"Descargando {target.name} (~267 MB)…")
    urllib.request.urlretrieve(FACESWAP_URL, tmp)

    # El checkpoint de 2020 trae metadatos numpy que el modo seguro de
    # torch.load rechaza; se confía en la fuente (release oficial, MIT) solo
    # para esta conversión única y se guarda un archivo de solo-tensores.
    ckpt = torch.load(tmp, map_location="cpu", weights_only=False)
    state = {k.removeprefix("module."): v for k, v in ckpt["state_dict"].items()}
    assert all(isinstance(v, torch.Tensor) for v in state.values())
    torch.save(state, target)
    tmp.unlink()
    print(f"✓ {target.name} convertido a solo-tensores")


def fetch_diffusion():
    """Detector De Difusión Facial: safetensors desde Hugging Face."""
    target = MODELS / "Detector_De_Difusion_Facial" / "model.safetensors"
    if target.exists():
        print(f"✓ {target.name} ya existe")
        return

    from huggingface_hub import hf_hub_download

    print("Descargando Detector De Difusión Facial (~355 MB)…")
    hf_hub_download(
        "prithivMLmods/deepfake-detector-model-v1",
        "model.safetensors",
        local_dir=target.parent,
    )
    print(f"✓ {target.name} descargado")


def fetch_scene():
    """Sonda De Escena Generada: checkpoint de Bombek1 → solo-tensores."""
    target = MODELS / "Sonda_De_Escena_Generada" / "weights.pth"
    if target.exists():
        print(f"✓ {target.name} ya existe")
        return

    import torch
    from huggingface_hub import hf_hub_download

    print("Descargando Sonda De Escena Generada (~2.1 GB)…")
    src = hf_hub_download(
        "Bombek1/ai-image-detector-siglip-dinov2", "pytorch_model.pt"
    )
    ckpt = torch.load(src, map_location="cpu", weights_only=False)
    state = ckpt["model_state_dict"]
    assert all(isinstance(v, torch.Tensor) for v in state.values())
    torch.save(state, target)
    print(f"✓ {target.name} convertido a solo-tensores")


if __name__ == "__main__":
    if not MODELS.is_dir():
        sys.exit(f"No existe {MODELS}; ejecuta desde el repositorio clonado.")
    fetch_faceswap()
    fetch_diffusion()
    fetch_scene()
    print("\nTodos los modelos listos.")
