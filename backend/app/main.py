import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")
from app.storage.runtime import configure_private_temp, UploadSizeLimit
configure_private_temp()
# Las descargas son opcionales y siempre usan el mismo intérprete del entorno.
_REQUIRED_WEIGHTS = [
    "Detector_De_Sintesis_GAN.pth", "Detector_De_Face_Swap.pth",
    "Detector_De_Difusion_Facial/model.safetensors", "Sonda_De_Escena_Generada/weights.pth",
    "Detector_Facial_YuNet.onnx",
]
_missing_weights = [name for name in _REQUIRED_WEIGHTS if not (BACKEND_DIR / "models" / name).is_file()]
if _missing_weights and os.getenv("AUTO_DOWNLOAD_MODELS", "false").lower() == "true":
    subprocess.run([sys.executable, str(BACKEND_DIR / "scripts" / "fetch_models.py")], check=True, cwd=BACKEND_DIR)
elif _missing_weights:
    raise RuntimeError("Faltan pesos de inferencia. Ejecuta: python scripts/fetch_models.py")

from app.auth_service import get_current_perito
from app.identity_routes import router as identity_router
from app.database import get_db
from app.forensic_routes import router as forensic_router
from app.forensic_storage import get_storage
from app.storage.ports import StorageError, IntegrityError, WriteConflict
from app import model as _inference_models  # precarga los modelos antes de aceptar solicitudes
from app.models_db import Perito

logger = logging.getLogger("certiface.api")

app = FastAPI(
    title="CertiFace API — Plataforma de Peritaje Forense Digital",
    version="2.0.0",
    description="Sistema pericial forense para detección de deepfakes, preservación ISO/IEC 27037 y emisión de dictámenes.",
)

app.include_router(identity_router)
app.include_router(forensic_router)
app.add_middleware(UploadSizeLimit, max_bytes=int(os.getenv("FORENSIC_MAX_UPLOAD_BYTES", "10485760")) + 1024 * 1024)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "").split(",") if origin.strip()],
    allow_headers=["*"],
    allow_methods=["*"],
)



@app.exception_handler(StorageError)
async def storage_error_handler(request: Request, error: StorageError):
    logger.warning("Operación de almacenamiento rechazada: %s", type(error).__name__)
    code = 409 if isinstance(error, (IntegrityError, WriteConflict)) else 503
    return JSONResponse({"detail": str(error)}, status_code=code, headers={"Cache-Control": "no-store"})


@app.exception_handler(SQLAlchemyError)
async def database_error_handler(request: Request, error: SQLAlchemyError):
    logger.error("Operación PostgreSQL rechazada: %s", type(error).__name__)
    return JSONResponse({"detail": "La base de datos no está disponible; no se confirmó la operación."}, status_code=503, headers={"Cache-Control": "no-store"})


@app.get("/health/live")
def liveness_check():
    return {"status": "ok", "service": "CertiFace Forensic API", "models": "loaded"}


@app.get("/health/ready")
@app.get("/")
def health_check(db: Session = Depends(get_db)):
    """Verifica el estado del API y la conectividad con Neon PostgreSQL."""
    try:
        db.execute(text("SELECT 1"))
        db_status = "connected (Neon PostgreSQL 16)"
    except Exception:
        logger.exception("Falló la comprobación de PostgreSQL")
        raise HTTPException(503, "La base de datos no está disponible.")
    storage = get_storage()
    storage.store.check()
    retention = storage.retention.check()
    return {
        "status": "ok",
        "service": "CertiFace Forensic API",
        "storage": {"encrypted": True, "retention_verified": retention["verified"]},
        "database": db_status,
        "version": "2.0.0",
    }


# ==========================================
# RUTAS DE AUTENTICACIÓN Y PERFIL DE PERITO
# ==========================================


@app.get("/api/v1/auth/profile", response_model=Dict[str, Any])
async def get_perito_profile(
    perito: Perito = Depends(get_current_perito),
):
    """Devuelve los datos del perito autenticado a través del microservicio de autenticación central."""
    return {
        "id": str(perito.id),
        "external_auth_id": perito.external_auth_id,
        "email": perito.email,
        "first_name": perito.first_name,
        "last_name": perito.last_name,
        "identifier": perito.identifier,
        "role_name": perito.role_name,
        "phone_number": perito.phone_number,
        "is_active": perito.is_active,
    }
