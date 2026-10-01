import logging
import os
import subprocess
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

# Descargar los pesos de los modelos si no existen (útil para la nube donde se ignoran por el .gitignore)
if not os.path.exists("models/Detector_De_Difusion_Facial/model.safetensors"):
    logging.info("Descargando modelos faltantes (esto puede tardar unos minutos en el primer arranque)...")
    try:
        subprocess.run(["python", "scripts/fetch_models.py"], check=True)
    except Exception as e:
        logging.warning("No se pudo ejecutar fetch_models.py automáticamente: %s", e)

from app.auth_service import get_current_perito, record_audit_event
from app.database import get_db
from app.forensic_storage import ForensicIntegrityError, ingest_evidence
from app.model import predict_image, predict_video
from app.models_db import AnalysisReport, CustodyAuditLog, Evidence, ForensicCase, Perito, TimecodeInconsistency
from app.preprocessing import extract_frames
from app.schemas import CaseCreateSchema, FinalizeReportSchema, PeritoSchema, VerdictEnum

logger = logging.getLogger("certiface.api")

app = FastAPI(
    title="CertiFace API — Plataforma de Peritaje Forense Digital",
    version="2.0.0",
    description="Sistema pericial forense para detección de deepfakes, preservación ISO/IEC 27037 y emisión de dictámenes.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_headers=["*"],
    allow_methods=["*"],
)


@app.get("/")
def health_check(db: Session = Depends(get_db)):
    """Verifica el estado del API y la conectividad con Neon PostgreSQL."""
    try:
        db.execute(text("SELECT 1"))
        db_status = "connected (Neon PostgreSQL 16)"
    except Exception as e:
        db_status = f"error: {str(e)}"
    return {
        "status": "ok",
        "service": "CertiFace Forensic API",
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


# ==========================================
# GESTIÓN DE EXPEDIENTES FORENSES
# ==========================================


@app.post("/api/v1/cases", status_code=status.HTTP_201_CREATED)
async def create_forensic_case(
    case_data: CaseCreateSchema,
    request: Request,
    perito: Perito = Depends(get_current_perito),
    db: Session = Depends(get_db),
):
    """Crea un nuevo expediente pericial formal."""
    existing = db.query(ForensicCase).filter(ForensicCase.case_number == case_data.case_number).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Ya existe un expediente con el número {case_data.case_number}",
        )

    new_case = ForensicCase(
        case_number=case_data.case_number,
        title=case_data.title,
        description=case_data.description,
        perito_id=perito.id,
    )
    db.add(new_case)
    db.commit()
    db.refresh(new_case)

    # Registrar evento de auditoría
    client_ip = request.client.host if request.client else "127.0.0.1"
    await record_audit_event(
        db=db,
        perito_id=perito.id,
        action="CASE_CREATED",
        ip_address=client_ip,
        details={"case_id": str(new_case.id), "case_number": new_case.case_number},
    )

    return {
        "id": str(new_case.id),
        "case_number": new_case.case_number,
        "title": new_case.title,
        "created_at": new_case.created_at.isoformat(),
    }


@app.get("/api/v1/cases")
async def list_forensic_cases(
    perito: Perito = Depends(get_current_perito),
    db: Session = Depends(get_db),
):
    """Lista todos los expedientes periciales registrados por el perito."""
    cases = db.query(ForensicCase).filter(ForensicCase.perito_id == perito.id).order_by(ForensicCase.created_at.desc()).all()
    return [
        {
            "id": str(c.id),
            "case_number": c.case_number,
            "title": c.title,
            "description": c.description,
            "created_at": c.created_at.isoformat(),
            "evidences_count": len(c.evidences),
        }
        for c in cases
    ]


# ==========================================
# INGESTA FORENSE Y CADENA DE CUSTODIA (ISO/IEC 27037)
# ==========================================


@app.post("/api/v1/cases/{case_id}/ingest", status_code=status.HTTP_201_CREATED)
async def ingest_case_evidence(
    case_id: str,
    request: Request,
    file: UploadFile = File(...),
    perito: Perito = Depends(get_current_perito),
    db: Session = Depends(get_db),
):
    """Ingesta forense de video según ISO/IEC 27037.

    Guarda la Evidencia Original (Read-Only) y genera la Copia Forense de Trabajo,
    verificando que sus hashes SHA-256 coincidan con precisión matemática.
    """
    case = db.query(ForensicCase).filter(ForensicCase.id == case_id).first()
    if not case:
        raise HTTPException(status_code=404, detail="Expediente no encontrado.")

    contents = await file.read()
    file_size = len(contents)
    client_ip = request.client.host if request.client else "127.0.0.1"

    try:
        orig_hash, work_hash, orig_uri, work_uri = ingest_evidence(
            file_bytes=contents,
            file_name=file.filename or "evidence.mp4",
            case_id=str(case.id),
        )
    except ForensicIntegrityError as err:
        raise HTTPException(status_code=500, detail=str(err))

    evidence = Evidence(
        case_id=case.id,
        file_name=file.filename or "evidence.mp4",
        file_size_bytes=file_size,
        mime_type=file.content_type or "video/mp4",
        sha256_original=orig_hash,
        sha256_working_copy=work_hash,
        original_storage_uri=orig_uri,
        working_storage_uri=work_uri,
    )
    db.add(evidence)
    db.commit()
    db.refresh(evidence)

    # Registrar en cadena de custodia
    await record_audit_event(
        db=db,
        perito_id=perito.id,
        evidence_id=evidence.id,
        action="EVIDENCE_INGESTED_AND_VERIFIED",
        ip_address=client_ip,
        details={
            "sha256_original": orig_hash,
            "sha256_working_copy": work_hash,
            "file_size_bytes": file_size,
        },
    )

    return {
        "evidence_id": str(evidence.id),
        "case_id": str(case.id),
        "file_name": evidence.file_name,
        "sha256_original": orig_hash,
        "sha256_working_copy": work_hash,
        "status": "PRESERVED_AND_VERIFIED",
    }


# ==========================================
# ANÁLISIS E INFERENCIA FORENSE
# ==========================================


@app.post("/api/v1/cases/{case_id}/analyze")
async def analyze_case_evidence(
    case_id: str,
    request: Request,
    evidence_id: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    perito: Perito = Depends(get_current_perito),
    db: Session = Depends(get_db),
):
    """Ejecuta el análisis forense sobre la evidencia especificada o sobre un nuevo video subido."""
    case = db.query(ForensicCase).filter(ForensicCase.id == case_id).first()
    if not case:
        raise HTTPException(status_code=404, detail="Expediente no encontrado.")

    client_ip = request.client.host if request.client else "127.0.0.1"

    # Si se envía un archivo nuevo directamente en esta petición, se realiza la ingesta primero
    if file is not None:
        contents = await file.read()
        orig_hash, work_hash, orig_uri, work_uri = ingest_evidence(
            file_bytes=contents,
            file_name=file.filename or "evidence.mp4",
            case_id=str(case.id),
        )
        evidence = Evidence(
            case_id=case.id,
            file_name=file.filename or "evidence.mp4",
            file_size_bytes=len(contents),
            mime_type=file.content_type or "video/mp4",
            sha256_original=orig_hash,
            sha256_working_copy=work_hash,
            original_storage_uri=orig_uri,
            working_storage_uri=work_uri,
        )
        db.add(evidence)
        db.commit()
        db.refresh(evidence)
    elif evidence_id is not None:
        evidence = db.query(Evidence).filter(Evidence.id == evidence_id, Evidence.case_id == case.id).first()
        if not evidence:
            raise HTTPException(status_code=404, detail="Evidencia no encontrada en este expediente.")
        # Leer la copia de trabajo
        with open(evidence.working_storage_uri, "rb") as f:
            contents = f.read()
    else:
        raise HTTPException(status_code=400, detail="Debe proporcionar un archivo de video o un evidence_id existente.")

    # Registro de acceso para análisis
    await record_audit_event(
        db=db,
        perito_id=perito.id,
        evidence_id=evidence.id,
        action="EVIDENCE_ANALYSIS_STARTED",
        ip_address=client_ip,
        details={"sha256": evidence.sha256_working_copy},
    )

    started = time.perf_counter()

    if evidence.mime_type.startswith("video/"):
        frames = extract_frames(contents)
        if not frames:
            raise HTTPException(
                status_code=422,
                detail="No se pudo decodificar ningún fotograma del video con OpenCV.",
            )
        result = predict_video(frames)
    else:
        result = predict_image(contents)

    processing_time = round(time.perf_counter() - started, 2)

    # Mapeo a la taxonomía tripartita forense
    prediction_raw = result.get("prediction", "Real")
    if prediction_raw == "Fake":
        verdict = VerdictEnum.MANIPULADO.value
    elif result.get("caveat") or result.get("faces_detected", 1) == 0:
        verdict = VerdictEnum.ANTECEDENTES.value
    else:
        verdict = VerdictEnum.SIN_MANIPULACION.value

    # Guardar reporte en base de datos
    report = AnalysisReport(
        evidence_id=evidence.id,
        perito_id=perito.id,
        status="COMPLETED",
        verdict=verdict,
        confidence_score=result.get("confidence", 0.0),
        caveat_notes=result.get("caveat"),
        processing_time_seconds=processing_time,
        hardware_info="PyTorch Inference Engine",
        frames_analyzed=result.get("frames_analyzed", len(frames) if "frames" in locals() else 1),
        faces_detected=result.get("faces_detected", 1),
        models_metadata=result.get("models", {}),
    )
    db.add(report)
    db.commit()
    db.refresh(report)

    # Registrar marcas de tiempo de inconsistencias
    suspects = result.get("suspicious_seconds") or []
    for s in suspects:
        sec = s.get("second", 0.0)
        tc = f"00:00:{sec:06.3f}"
        inconsistency = TimecodeInconsistency(
            report_id=report.id,
            timecode_start=tc,
            timecode_end=tc,
            duration_seconds=0.5,
            frame_start=0,
            frame_end=0,
            peak_timecode=tc,
            peak_frame=0,
            peak_anomaly_score=s.get("score", 0.0),
            anomaly_family="FACE_SWAP",
        )
        db.add(inconsistency)
    db.commit()

    # Registro final de auditoría
    await record_audit_event(
        db=db,
        perito_id=perito.id,
        evidence_id=evidence.id,
        action="INFERENCE_COMPLETED",
        ip_address=client_ip,
        details={
            "report_id": str(report.id),
            "verdict": verdict,
            "processing_time": processing_time,
        },
    )

    result["report_id"] = str(report.id)
    result["verdict_forensic"] = verdict
    result["processing_time_seconds"] = processing_time
    return result


@app.get("/api/v1/cases/{case_id}/custody-log")
async def get_case_custody_log(
    case_id: str,
    perito: Perito = Depends(get_current_perito),
    db: Session = Depends(get_db),
):
    """Consulta la bitácora completa de cadena de custodia y auditoría para un expediente."""
    case = db.query(ForensicCase).filter(ForensicCase.id == case_id).first()
    if not case:
        raise HTTPException(status_code=404, detail="Expediente no encontrado.")

    ev_ids = [e.id for e in case.evidences]
    logs = (
        db.query(CustodyAuditLog)
        .filter(CustodyAuditLog.evidence_id.in_(ev_ids))
        .order_by(CustodyAuditLog.timestamp.desc())
        .all()
    )

    return [
        {
            "id": log.id,
            "evidence_id": str(log.evidence_id) if log.evidence_id else None,
            "action": log.action,
            "ip_address": log.ip_address,
            "hash_verified": log.hash_verified,
            "synced_to_central_audit": log.synced_to_central_audit,
            "details": log.details,
            "timestamp": log.timestamp.isoformat(),
        }
        for log in logs
    ]


# ==========================================
# RUTA /PREDICT DE RETROCOMPATIBILIDAD
# ==========================================


@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    """Endpoint legado para compatibilidad con pruebas síncronas existentes."""
    contents = await file.read()
    started = time.perf_counter()
    logger.info(
        "Petición /predict: %s (%s, %d bytes)",
        file.filename,
        file.content_type,
        len(contents),
    )

    if file.content_type and file.content_type.startswith("video/"):
        frames = extract_frames(contents)
        if not frames:
            raise HTTPException(
                status_code=422,
                detail=(
                    "No se pudo decodificar ningún fotograma del video. "
                    "Códec o contenedor no soportado por OpenCV; "
                    "prueba a recodificarlo como MP4 (H.264)."
                ),
            )
        result = predict_video(frames)
    else:
        result = predict_image(contents)

    loggable = {k: v for k, v in result.items() if k != "explanation"}
    if "explanation" in result:
        exp = result["explanation"]
        strip = exp.get("frames") or []
        detail = f", {len(strip)} fotogramas ilustrados" if strip else ""
        loggable["explanation"] = (
            f"<mapa de calor {exp['width']}x{exp['height']}, "
            f"t={exp['second']}{detail}>"
        )
    logger.info(
        "Respuesta /predict en %.2f s: %s",
        time.perf_counter() - started,
        loggable,
    )
    return result
