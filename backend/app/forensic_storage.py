import hashlib
import logging
import os
import shutil
from pathlib import Path
from typing import Tuple

logger = logging.getLogger("certiface.storage")

BASE_STORAGE = Path(os.getenv("STORAGE_DIR", "storage_evidence")).resolve()
MASTER_DIR = BASE_STORAGE / "master"
WORKING_DIR = BASE_STORAGE / "working"
PLATES_DIR = BASE_STORAGE / "plates"
REPORTS_DIR = BASE_STORAGE / "reports"

for d in (MASTER_DIR, WORKING_DIR, PLATES_DIR, REPORTS_DIR):
    d.mkdir(parents=True, exist_ok=True)


class ForensicIntegrityError(Exception):
    """Excepción al detectar disparidad de hash entre el original y la copia de trabajo."""
    pass


def calculate_sha256(data: bytes) -> str:
    """Calcula la huella criptográfica SHA-256 de un bloque de bytes."""
    return hashlib.sha256(data).hexdigest()


def ingest_evidence(
    file_bytes: bytes,
    file_name: str,
    case_id: str,
) -> Tuple[str, str, str, str]:
    """Preservación de evidencia digital conforme a ISO/IEC 27037.

    1. Calcula el hash SHA-256 de la evidencia cruda.
    2. Guarda la Evidencia Original (Master Copy) con permisos de sólo lectura (0o400).
    3. Genera la Copia Forense de Trabajo (Working Copy).
    4. Verifica que el hash de la copia de trabajo sea idéntico al original.

    Devuelve: (sha256_original, sha256_working, original_path, working_path)
    """
    case_master_dir = MASTER_DIR / str(case_id)
    case_working_dir = WORKING_DIR / str(case_id)
    case_master_dir.mkdir(parents=True, exist_ok=True)
    case_working_dir.mkdir(parents=True, exist_ok=True)

    original_sha256 = calculate_sha256(file_bytes)

    # 1. Guardar Evidencia Original
    original_path = case_master_dir / file_name
    # Si el archivo ya existía con 0o400, restablecer permiso temporal para escribir
    if original_path.exists():
        os.chmod(original_path, 0o600)
    with open(original_path, "wb") as f:
        f.write(file_bytes)
    # Marcar inmediatamente como sólo lectura (protección contra escritura)
    try:
        os.chmod(original_path, 0o400)
    except OSError:
        pass

    # 2. Generar Copia Forense de Trabajo
    working_name = f"work_{file_name}"
    working_path = case_working_dir / working_name
    shutil.copyfile(original_path, working_path)

    # 3. Verificar correspondencia criptográfica exacta
    with open(working_path, "rb") as f:
        working_bytes = f.read()
    working_sha256 = calculate_sha256(working_bytes)

    if original_sha256 != working_sha256:
        logger.critical(
            "Fallo de integridad forense: SHA256 original (%s) != copia (%s)",
            original_sha256, working_sha256,
        )
        raise ForensicIntegrityError(
            f"Fallo de integridad en la copia de trabajo para el expediente {case_id}."
        )

    logger.info(
        "Evidencia preservada exitosamente [ISO/IEC 27037] - SHA-256: %s",
        original_sha256,
    )
    return (
        original_sha256,
        working_sha256,
        str(original_path),
        str(working_path),
    )
