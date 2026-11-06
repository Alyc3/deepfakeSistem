"""Publica backend/ en un Hugging Face Space de tipo Docker.

Uso, desde backend/ (con `hf auth login` hecho antes, o HF_TOKEN definido):

    python deploy/huggingface/deploy.py <usuario>/<nombre-del-space>

Sube el código y los pesos versionados (GAN propio, YuNet, configs); los
pesos de terceros NO se suben: el Dockerfile los descarga en el build. Los
secretos (.env, .secrets/) quedan excluidos explícitamente.
"""

import sys
from pathlib import Path

from huggingface_hub import HfApi
try:
    from huggingface_hub.errors import RepositoryNotFoundError
except ImportError:  # huggingface_hub < 0.23
    from huggingface_hub.utils import RepositoryNotFoundError

BACKEND = Path(__file__).resolve().parents[2]
CARD = Path(__file__).with_name("README.md")

# Patrones fnmatch sobre la ruta relativa a backend/ ("*" cruza carpetas).
IGNORE = [
    ".env", ".env.*", ".secrets/*", "uploads/*", "storage_evidence/*", "logs/*",
    ".runtime-tmp/*", ".venv/*", "venv/*", "*__pycache__*", "*.pyc", ".pytest_cache/*",
    "models/Detector_De_Face_Swap.pth",
    "models/Detector_De_Difusion_Facial/model.safetensors",
    "models/Sonda_De_Escena_Generada/weights.pth",
    "tests/*", "deploy/*", "start.ps1", "pip",
]


def main():
    if len(sys.argv) != 2 or "/" not in sys.argv[1]:
        sys.exit("Uso: python deploy/huggingface/deploy.py <usuario>/<nombre-del-space>")
    space = sys.argv[1]
    api = HfApi()

    try:
        info = api.space_info(space)
    except RepositoryNotFoundError:
        sys.exit(f"No existe el Space {space} (o tu token no tiene acceso). Créalo primero en huggingface.co/new-space con SDK Docker.")
    if getattr(info, "private", False):
        print("ADVERTENCIA: el Space es privado. Un Space privado exige un token de Hugging Face en la "
              "cabecera Authorization, que choca con el JWT del perito; la web no podrá llamar a la API.")

    secret_leaks = [p for p in (BACKEND / ".env", BACKEND / ".secrets") if p.exists()]
    if secret_leaks:
        print("Excluyendo del envío:", ", ".join(p.name for p in secret_leaks))

    api.upload_file(path_or_fileobj=CARD, path_in_repo="README.md", repo_id=space,
                    repo_type="space", commit_message="Ficha del Space")
    api.upload_folder(folder_path=BACKEND, repo_id=space, repo_type="space",
                      ignore_patterns=IGNORE, commit_message="Despliegue del backend CertiFace")

    print(f"\nListo. El build empieza solo (15-30 min la primera vez):")
    print(f"  Logs:  https://huggingface.co/spaces/{space}?logs=build")
    host = space.replace("/", "-").replace("_", "-").replace(".", "-").lower()
    print(f"  API:   https://{host}.hf.space/health/live")


if __name__ == "__main__":
    main()
