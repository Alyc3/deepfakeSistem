import logging
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

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

from app.api_docs import API_DESCRIPTION, AUTH_ERRORS, TAGS, errors
from app.auth_service import get_current_perito
from app.identity_routes import router as identity_router
from app.database import get_db
from app.forensic_routes import router as forensic_router
from app.forensic_storage import get_storage
from app.storage.ports import StorageError, IntegrityError, WriteConflict
from app import model as _inference_models  # noqa: F401 — precarga los modelos antes de aceptar solicitudes
from app.models_db import Perito
from app.schemas import LiveStatus, PeritoProfile, ReadyStatus
from app.validators import install_validation_handler

logger = logging.getLogger("certiface.api")
API_VERSION = "2.0.0"

app = FastAPI(
    title="CertiFace API",
    version=API_VERSION,
    summary="Motor forense para detectar deepfakes con cadena de custodia y dictamen pericial firmado.",
    description=API_DESCRIPTION,
    openapi_tags=TAGS,
    # Documentación con ReDoc en /docs; Swagger UI desactivado.
    docs_url=None,
    redoc_url="/docs",
)


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    """Registra cada interacción HTTP sin incluir cuerpos, tokens ni query strings."""
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        logger.exception("Solicitud HTTP fallida request_id=%s method=%s path=%s duration_ms=%d",
                         request_id, request.method, request.url.path,
                         round((time.perf_counter() - started) * 1000))
        raise
    duration_ms = round((time.perf_counter() - started) * 1000)
    response.headers["X-Request-ID"] = request_id
    message = "Solicitud HTTP completada" if response.status_code < 400 else "Solicitud HTTP con error"
    log = logger.info if response.status_code < 400 else logger.warning
    log("%s request_id=%s method=%s path=%s status=%d duration_ms=%d",
        message, request_id, request.method, request.url.path, response.status_code, duration_ms)
    return response

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
    logger.warning("Operación de almacenamiento rechazada: %s", str(error))
    code = 409 if isinstance(error, (IntegrityError, WriteConflict)) else 503
    return JSONResponse({"detail": str(error)}, status_code=code, headers={"Cache-Control": "no-store"})


install_validation_handler(app)


@app.exception_handler(SQLAlchemyError)
async def database_error_handler(request: Request, error: SQLAlchemyError):
    logger.error("Operación PostgreSQL rechazada: %s", type(error).__name__)
    return JSONResponse({"detail": "La base de datos no está disponible; no se confirmó la operación."}, status_code=503, headers={"Cache-Control": "no-store"})


@app.get("/health/live", tags=["Estado del servicio"], summary="El proceso está vivo",
         responses={200: {"model": LiveStatus, "description": "La API está en marcha y los modelos cargados."}})
def liveness_check():
    """Responde en cuanto la API arrancó y cargó los modelos. No consulta servicios externos,
    así que es la comprobación adecuada para el healthcheck de Docker y para el pipeline de despliegue."""
    return {"status": "ok", "service": "CertiFace Forensic API", "models": "loaded"}


@app.get("/health/ready", tags=["Estado del servicio"], summary="La API puede atender solicitudes",
         responses={200: {"model": ReadyStatus, "description": "PostgreSQL y el almacén forense responden."}, **errors(409, 503)})
@app.get("/", include_in_schema=False)
def health_check(db: Session = Depends(get_db)):
    """Comprueba la conexión con PostgreSQL, el acceso al almacén de objetos y que la retención
    inmutable siga activa. Devuelve `503` si alguno falla."""
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
        "version": API_VERSION,
    }


@app.get("/api/v1/auth/profile", tags=["Autenticación"], summary="Perfil del perito autenticado",
         responses={200: {"model": PeritoProfile, "description": "Perfil sincronizado."}, **errors(*AUTH_ERRORS)})
async def get_perito_profile(perito: Perito = Depends(get_current_perito)):
    """Valida el token en el auth-service, sincroniza la cuenta en la tabla local de peritos
    y devuelve el perfil. Es el registro al que se asocian expedientes y bitácora de custodia."""
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
