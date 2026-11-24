import json
import base64
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from sqlalchemy import func, or_

from app.api_docs import AUTH_ERRORS, errors
from app.auth_service import get_current_perito, record_audit_event
from app.database import get_db
from app.forensic_storage import get_storage
from app.forensic_workflow import add_bundle, analyze_and_archive, descriptors, owned_case, preserve, read_upload, verified_working, with_plates
from app.celery_app import celery_app
from app import local_jobs
from app.tasks import analyze_evidence_task, run_analysis_job
from app.report_pdf import build_forensic_pdf
from app.identity import require_laboratory
from app.models_db import AnalysisJob, AnalysisReport, CustodyAuditLog, Evidence, ForensicCase, StoredArtifact
from app.schemas import (AnalysisResult, ArchiveReceipt, ArtifactItem, CaseCreated, CaseCreateSchema, CaseList, CaseSummary,
                         CustodyEvent, EvidenceItem, FinalizeReportSchema, IngestReceipt, JobQueued, JobStatus, StorageStatus)
from app.storage.ports import IntegrityError, StorageError
from app.storage.sealing import sha256
from app.validators import sha256_or_none

router = APIRouter(dependencies=[Depends(require_laboratory)], responses=errors(*AUTH_ERRORS))
CASES, ANALYSIS, JOBS, ARCHIVE = "Expedientes", "Evidencias y análisis", "Trabajos de análisis", "Archivo forense"
UPLOAD_ERRORS = (409, 413, 415, 422)
EVIDENCE_FILE = "Imagen o video (JPEG, PNG, WebP, BMP, GIF, MP4, MOV, AVI, MKV o WebM)."
EXPECTED_SHA256 = "Huella SHA-256 calculada en el cliente (64 caracteres hexadecimales). Si no coincide, se rechaza con 409."
EVIDENCE_ID = "Evidencia ya subida al expediente. Alternativa a `file`."
logger = logging.getLogger("certiface.forensics")


def receipt(case, evidence, report, rows):
    return {"case_id": str(case.id), "evidence_id": str(evidence.id), "report_id": str(report.id) if report else None,
        "objects": [{"id": str(row.id), "kind": row.kind, "sha256": row.sha256, "size_bytes": row.size_bytes} for row in rows],
        "retention_verified": all(row.retention.get("verified") is True for row in rows)}


async def audit(db, perito, request, action, evidence=None, details=None, verified=True):
    evidence_ref = evidence.id if evidence else (details or {}).get("evidence_id")
    return await record_audit_event(db=db, perito_id=perito.id, action=action, evidence_id=uuid.UUID(str(evidence_ref)) if evidence_ref else None,
        ip_address=request.client.host if request.client else "unknown", user_agent=request.headers.get("user-agent", "")[:500],
        hash_verified=verified, details={"endpoint": request.url.path, **(details or {})})


async def ingest(db, case, perito, request, file, expected_sha256=None):
    expected_sha256 = sha256_or_none(expected_sha256)
    data, mime = await read_upload(file)
    if expected_sha256 is not None and expected_sha256 != sha256(data):
        await audit(db, perito, request, "EVIDENCE_HASH_REJECTED", details={"case_id": str(case.id)}, verified=False)
        raise HTTPException(409, "La evidencia recibida no coincide con la huella declarada")
    try:
        evidence, rows = await run_in_threadpool(preserve, db, case, perito, data, mime, file.filename or "evidence")
    except StorageError as error:
        db.rollback()
        await audit(db, perito, request, "EVIDENCE_INGESTION_FAILED", details={"case_id": str(case.id), "reason": type(error).__name__}, verified=False)
        raise
    await audit(db, perito, request, "EVIDENCE_PRESERVED_AND_VERIFIED", evidence,
        {"case_id": str(case.id), "sha256": evidence.sha256_original, "artifact_ids": [str(row.id) for row in rows]})
    return evidence, rows


async def analyze(db, case, evidence, perito, request):
    await audit(db, perito, request, "EVIDENCE_ANALYSIS_STARTED", evidence, {"case_id": str(case.id), "verification": "pending"}, verified=False)
    try:
        result, report, rows = await run_in_threadpool(analyze_and_archive, db, case, evidence, perito)
    except IntegrityError:
        db.rollback()
        await audit(db, perito, request, "EVIDENCE_INTEGRITY_REJECTED", evidence, {"case_id": str(case.id)}, verified=False)
        raise
    except (StorageError, HTTPException) as error:
        db.rollback()
        await audit(db, perito, request, "ANALYSIS_NOT_COMPLETED", evidence, {"case_id": str(case.id), "reason": type(error).__name__}, verified=False)
        raise
    await audit(db, perito, request, "INFERENCE_ARCHIVED", evidence,
        {"case_id": str(case.id), "report_id": str(report.id), "verdict": report.verdict,
         "manifest_sha256": next(row.sha256 for row in rows if row.kind == "manifest")})
    result["archive"] = receipt(case, evidence, report, rows)
    return result


INTERRUPTED_DETAIL = "El análisis se interrumpió porque el servidor se reinició. Vuelve a iniciarlo."


def use_worker(db) -> bool:
    """¿Analiza un worker de Celery o esta misma API? (INFERENCE_MODE; ver app/local_jobs.py)."""
    mode = local_jobs.inference_mode()
    if mode != "auto":
        return mode == "worker"
    if local_jobs.worker_responds():
        return True
    # Sin respuesta: o no hay worker, o está ocupado con un trabajo que le entregamos hace poco.
    sent = [uuid.UUID(job_id) for job_id in local_jobs.recently_dispatched()]
    return bool(sent) and local_jobs.broker_reachable() and db.query(AnalysisJob).filter(
        AnalysisJob.id.in_(sent), AnalysisJob.status.in_(["QUEUED", "PROCESSING"])).first() is not None


async def queue_analysis(db, case, evidence, perito, request):
    """Crea el trabajo en estado QUEUED y lo entrega al worker o, si no hay, al hilo de inferencia de la API."""
    job_id = uuid.uuid4()
    queued = AnalysisJob(id=job_id, case_id=case.id, evidence_id=evidence.id, perito_id=perito.id, status="QUEUED")
    db.add(queued)
    db.commit()
    arguments = [str(case.id), str(evidence.id), str(perito.id), str(job_id)]
    if await run_in_threadpool(use_worker, db):
        mode = "worker"
        try:
            analyze_evidence_task.apply_async(args=arguments, task_id=str(job_id))
        except Exception:
            queued.status = "FAILED"
            queued.error_detail = "El broker de inferencia no está disponible."
            db.commit()
            raise HTTPException(503, "El servicio de inferencia asíncrona no está disponible.") from None
        local_jobs.note_dispatched(str(job_id))
    else:
        mode = "local"
        local_jobs.submit(str(job_id), lambda report: run_analysis_job(*arguments, report_progress=report, origin="api-local"))
    await audit(db, perito, request, "EVIDENCE_ANALYSIS_QUEUED", evidence,
                {"case_id": str(case.id), "job_id": str(job_id), "mode": mode}, verified=False)
    return {"status": "queued", "job_id": str(job_id), "case_id": str(case.id), "evidence_id": str(evidence.id),
            "poll_after_ms": 2000, "mode": mode}


@router.post("/api/v1/cases", status_code=201, tags=[CASES], summary="Crear expediente",
             responses={201: {"model": CaseCreated, "description": "Expediente creado."}, **errors(409, 422)})
async def create_case(case_data: CaseCreateSchema, request: Request, perito=Depends(get_current_perito), db=Depends(get_db)):
    """Abre un expediente a nombre del perito autenticado y lo registra en la bitácora de custodia.
    Devuelve `409` si el número de expediente ya existe.
    """
    if db.query(ForensicCase).filter(ForensicCase.case_number == case_data.case_number).first():
        raise HTTPException(409, "El número de expediente ya existe")
    case = ForensicCase(id=uuid.uuid4(), case_number=case_data.case_number, title=case_data.title, description=case_data.description, perito_id=perito.id)
    db.add(case)
    await audit(db, perito, request, "CASE_CREATED", details={"case_id": str(case.id), "case_number": case.case_number})
    return {"id": str(case.id), "case_number": case.case_number, "title": case.title}


def _like(term: str) -> str:
    """Patrón LIKE literal: el texto buscado no puede usar % ni _ como comodines."""
    return "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@router.get("/api/v1/cases", tags=[CASES], summary="Listar expedientes",
            responses={200: {"model": CaseList, "description": "Página de expedientes, del más reciente al más antiguo."}, **errors(422)})
async def list_cases(q: Optional[str] = Query(None, max_length=100, description="Texto a buscar en el número o el nombre del expediente."), offset: int = Query(0, ge=0, le=100_000, description="Expedientes que se saltan (paginación)."),
                     limit: int = Query(10, ge=1, le=50, description="Expedientes por página (1 a 50)."), perito=Depends(get_current_perito), db=Depends(get_db)):
    """Expedientes del perito, paginados, con el número de evidencias y el último veredicto de cada uno.

    - `q`: busca en el número y el nombre del expediente (sin distinguir mayúsculas).
    - `offset` y `limit`: paginación (máximo 50 por página).
    """
    def load():
        query = db.query(ForensicCase).filter(ForensicCase.perito_id == perito.id)
        term = (q or "").strip()
        if term:
            pattern = _like(term)
            query = query.filter(or_(ForensicCase.case_number.ilike(pattern, escape="\\"), ForensicCase.title.ilike(pattern, escape="\\")))
        total = query.count()
        cases = query.order_by(ForensicCase.created_at.desc(), ForensicCase.id).offset(offset).limit(limit).all()
        ids = [case.id for case in cases]
        evidences, verdicts = {}, {}
        if ids:
            evidences = dict(db.query(Evidence.case_id, func.count(Evidence.id)).filter(Evidence.case_id.in_(ids)).group_by(Evidence.case_id).all())
            reports = (db.query(Evidence.case_id, AnalysisReport.verdict).join(AnalysisReport, AnalysisReport.evidence_id == Evidence.id)
                       .filter(Evidence.case_id.in_(ids), AnalysisReport.verdict.isnot(None))
                       .order_by(AnalysisReport.completed_at.desc().nullslast()).all())
            for case_id, verdict in reports:
                verdicts.setdefault(case_id, verdict)  # el primero es el más reciente
        items = [{"id": str(case.id), "case_number": case.case_number, "title": case.title,
                  "description": (case.description or "")[:160] or None,
                  "created_at": case.created_at.isoformat() if case.created_at else None,
                  "evidences": int(evidences.get(case.id, 0)), "verdict": verdicts.get(case.id)} for case in cases]
        return {"items": items, "total": total, "offset": offset, "limit": limit}
    return await run_in_threadpool(load)


@router.post("/api/v1/cases/{case_id}/ingest", status_code=201, tags=[ANALYSIS], summary="Subir evidencia",
             responses={201: {"model": IngestReceipt, "description": "Evidencia preservada y verificada."}, **errors(404, *UPLOAD_ERRORS)})
async def ingest_case(case_id: uuid.UUID, request: Request, file: UploadFile = File(..., description=EVIDENCE_FILE), expected_sha256: Optional[str] = Form(None, description=EXPECTED_SHA256), perito=Depends(get_current_perito), db=Depends(get_db)):
    """Recibe una imagen o un video (`multipart/form-data`) y lo preserva: cifra y sella el original y una
    copia de trabajo, comprueba que ambas huellas coincidan y lo anota en la bitácora.

    Si se envía `expected_sha256` (la huella calculada en el cliente), la API rechaza con `409` un archivo que
    no coincida, lo que demuestra que no se alteró en el camino. No analiza: para eso está `analyze-async`.
    """
    case = await run_in_threadpool(owned_case, db, case_id, perito)
    evidence, rows = await ingest(db, case, perito, request, file, expected_sha256)
    return {**receipt(case, evidence, None, rows), "sha256_original": evidence.sha256_original, "sha256_working_copy": evidence.sha256_working_copy, "status": "PRESERVED_AND_VERIFIED"}


@router.post("/api/v1/cases/{case_id}/analyze", tags=[ANALYSIS], summary="Analizar y esperar el resultado",
             responses={200: {"model": AnalysisResult, "description": "Análisis completado y archivado."}, **errors(400, 404, *UPLOAD_ERRORS)})
async def analyze_case(case_id: uuid.UUID, request: Request, evidence_id: Optional[uuid.UUID] = Form(None, description=EVIDENCE_ID), file: Optional[UploadFile] = File(None, description=EVIDENCE_FILE), expected_sha256: Optional[str] = Form(None, description=EXPECTED_SHA256), perito=Depends(get_current_perito), db=Depends(get_db)):
    """Analiza una evidencia y espera el resultado en la misma solicitud (en video puede tardar varios minutos).
    Envía `evidence_id` para una evidencia ya subida o `file` para subirla y analizarla a la vez.
    Para clientes interactivos es preferible `analyze-async`.
    """
    case = await run_in_threadpool(owned_case, db, case_id, perito)
    if file is not None:
        evidence, _ = await ingest(db, case, perito, request, file, expected_sha256)
    elif evidence_id is not None:
        evidence = db.query(Evidence).filter(Evidence.id == evidence_id, Evidence.case_id == case.id).first()
        if not evidence:
            raise HTTPException(404, "Evidencia no encontrada")
    else:
        raise HTTPException(400, "Proporciona una evidencia o archivo")
    return await analyze(db, case, evidence, perito, request)


@router.post("/api/v1/cases/{case_id}/analyze-async", status_code=202, tags=[ANALYSIS], summary="Encolar análisis",
             responses={202: {"model": JobQueued, "description": "Análisis encolado."}, **errors(400, 404, *UPLOAD_ERRORS)})
async def analyze_case_async(case_id: uuid.UUID, request: Request, evidence_id: Optional[uuid.UUID] = Form(None, description=EVIDENCE_ID), file: Optional[UploadFile] = File(None, description=EVIDENCE_FILE), expected_sha256: Optional[str] = Form(None, description=EXPECTED_SHA256), perito=Depends(get_current_perito), db=Depends(get_db)):
    """Encola el análisis y responde de inmediato con un `job_id`. Envía `evidence_id` para una evidencia ya
    subida o `file` (con `expected_sha256` opcional) para subirla y analizarla a la vez.

    Lo ejecuta el worker de Celery o, si no hay ninguno, la propia API (`mode`). Al terminar quedan archivados
    el resultado JSON, los mapas de calor y un informe PDF preliminar.
    """
    case = await run_in_threadpool(owned_case, db, case_id, perito)
    if file is not None:
        evidence, _ = await ingest(db, case, perito, request, file, expected_sha256)
    elif evidence_id is not None:
        evidence = db.query(Evidence).filter(Evidence.id == evidence_id, Evidence.case_id == case.id).first()
        if not evidence:
            raise HTTPException(404, "Evidencia no encontrada")
    else:
        raise HTTPException(400, "Proporciona una evidencia o archivo")
    return await queue_analysis(db, case, evidence, perito, request)


@router.post("/predict", tags=[ANALYSIS], summary="Análisis rápido sin expediente previo",
             responses={200: {"model": JobQueued, "description": "Evidencia preservada y análisis encolado."}, **errors(*UPLOAD_ERRORS)})
async def preserved_prediction(request: Request, file: UploadFile = File(..., description=EVIDENCE_FILE), expected_sha256: Optional[str] = Form(None, description=EXPECTED_SHA256), perito=Depends(get_current_perito), db=Depends(get_db)):
    """Atajo del laboratorio de la web: crea un expediente automático (`CF-<fecha>-<id>`), preserva el
    archivo y encola su análisis en un solo paso. El resultado se consulta igual que en `analyze-async`.
    """
    expected_sha256 = sha256_or_none(expected_sha256)  # antes de crear el expediente
    get_storage().retention.check()
    case_id = uuid.uuid4()
    case = ForensicCase(id=case_id, case_number=f"CF-{datetime.now(timezone.utc):%Y%m%d}-{case_id.hex}", title=(file.filename or "Análisis de evidencia")[:255], perito_id=perito.id)
    db.add(case)
    await audit(db, perito, request, "CASE_CREATED", details={"case_id": str(case.id), "source": "laboratory"})
    evidence, evidence_rows = await ingest(db, case, perito, request, file, expected_sha256)
    queued = await queue_analysis(db, case, evidence, perito, request)
    queued["archive"] = receipt(case, evidence, None, evidence_rows)
    return queued


@router.get("/api/v1/jobs/{job_id}", tags=[JOBS], summary="Estado de un análisis",
            responses={200: {"model": JobStatus, "description": "Estado actual del trabajo."}, **errors(404)})
async def analysis_job(job_id: uuid.UUID, perito=Depends(get_current_perito), db=Depends(get_db)):
    """Devuelve `queued` o `processing` con el progreso por etapas mientras el análisis avanza, `completed`
    con el resultado o `failed` con el motivo. Consulta de nuevo tras `poll_after_ms` milisegundos.

    Si el servidor se reinició a mitad de un análisis, el trabajo pasa a `failed` y hay que volver a encolarlo.
    """
    job = db.query(AnalysisJob).filter(AnalysisJob.id == job_id, AnalysisJob.perito_id == perito.id).first()
    if not job:
        raise HTTPException(404, "Trabajo no encontrado")
    # 1) Trabajo que corre (o corrió hace poco) dentro de esta API.
    local = local_jobs.status(str(job_id))
    if local is not None:
        if local["state"] == "COMPLETED":
            return {"status": "completed", "job_id": str(job_id), "result": local["result"]}
        if local["state"] == "FAILED":
            return {"status": "failed", "job_id": str(job_id), "detail": job.error_detail or "La inferencia no pudo completarse."}
        return {"status": local["state"].lower(), "job_id": str(job_id), "poll_after_ms": 2000, "progress": local["progress"]}
    # 2) Trabajo de un worker: su estado está en Redis. Solo se consulta si Redis responde
    #    (con el broker caído, Celery reintenta durante muchos segundos en cada consulta).
    result, state = None, "UNAVAILABLE"
    if await run_in_threadpool(local_jobs.broker_reachable):
        try:
            result = celery_app.AsyncResult(str(job_id))
            state = result.state
        except Exception:
            result, state = None, "UNAVAILABLE"
    if result is None and job.status in ("QUEUED", "PROCESSING"):
        if local_jobs.inference_mode() == "worker":
            raise HTTPException(503, "El backend de resultados de inferencia no está disponible.")
        # Ni esta API lo conoce ni hay worker alcanzable: lo ejecutaba un proceso que ya no existe.
        job.status, job.error_detail, job.updated_at = "FAILED", INTERRUPTED_DETAIL, datetime.now(timezone.utc)
        db.commit()
        return {"status": "failed", "job_id": str(job_id), "detail": INTERRUPTED_DETAIL}
    if job.status == "COMPLETED":
        if result is not None and result.successful():
            return {"status": "completed", "job_id": str(job_id), "result": result.result}
        report = db.query(AnalysisReport).filter(AnalysisReport.id == job.report_id).first() if job.report_id else None
        if report:
            prediction = "Fake" if report.verdict == "MANIPULADO" else "Real" if report.verdict == "SIN_MANIPULACION" else "Suspect"
            return {"status": "completed", "job_id": str(job_id), "result": {
                "report_id": str(report.id), "prediction": prediction, "verdict_forensic": report.verdict,
                "confidence": float(report.confidence_score) if report.confidence_score is not None else None,
                "frames_analyzed": report.frames_analyzed, "faces_detected": report.faces_detected,
                "processing_time_seconds": float(report.processing_time_seconds) if report.processing_time_seconds is not None else None,
                "result_recovered_from_database": True,
            }}
        raise HTTPException(503, "El análisis figura completado, pero no se encontró su reporte en PostgreSQL.")
    if job.status == "FAILED" or state == "FAILURE" or (result is not None and result.failed()):
        return {"status": "failed", "job_id": str(job_id), "detail": job.error_detail or "La inferencia no pudo completarse."}
    progress = result.info if result is not None and isinstance(result.info, dict) else None
    return {"status": job.status.lower(), "job_id": str(job_id), "poll_after_ms": 2000, "progress": progress}


@router.get("/api/v1/cases/{case_id}/evidences", tags=[CASES], summary="Evidencias del expediente",
            responses={200: {"model": list[EvidenceItem], "description": "Hasta 200 evidencias, de la más reciente a la más antigua."}, **errors(404)})
async def list_evidence(case_id: uuid.UUID, perito=Depends(get_current_perito), db=Depends(get_db)):
    """Lista las evidencias subidas al expediente con su huella SHA-256 y su tamaño."""
    case = await run_in_threadpool(owned_case, db, case_id, perito)
    evidence = db.query(Evidence).filter(Evidence.case_id == case.id).order_by(Evidence.uploaded_at.desc()).limit(200).all()
    return [{"id": str(item.id), "file_name": item.file_name, "sha256": item.sha256_original, "size_bytes": item.file_size_bytes, "uploaded_at": item.uploaded_at.isoformat()} for item in evidence]


@router.get("/api/v1/cases/{case_id}/artifacts", tags=[ARCHIVE], summary="Objetos archivados del expediente",
            responses={200: {"model": list[ArtifactItem], "description": "Hasta 500 objetos, del más reciente al más antiguo."}, **errors(404)})
async def list_artifacts(case_id: uuid.UUID, perito=Depends(get_current_perito), db=Depends(get_db)):
    """Lista los objetos cifrados del expediente (originales, copias de trabajo, resultados JSON, informes
    PDF y mapas de calor) con su huella SHA-256. Cada `id` se descarga con `.../artifacts/{artifact_id}/download`.
    """
    case = await run_in_threadpool(owned_case, db, case_id, perito)
    artifacts = db.query(StoredArtifact).filter(StoredArtifact.case_id == case.id, StoredArtifact.owner_id == perito.id).order_by(StoredArtifact.created_at.desc()).limit(500).all()
    return [{"id": str(row.id), "evidence_id": str(row.evidence_id), "report_id": str(row.report_id) if row.report_id else None,
             "kind": row.kind, "sha256": row.sha256, "size_bytes": row.size_bytes, "created_at": row.created_at.isoformat()} for row in artifacts]


@router.get("/api/v1/cases/{case_id}/summary", tags=[CASES], summary="Resumen completo del expediente",
            responses={200: {"model": CaseSummary, "description": "Expediente con evidencias, dictámenes y custodia."}, **errors(404)})
async def case_summary(case_id: uuid.UUID, perito=Depends(get_current_perito), db=Depends(get_db)):
    """Reúne en una sola respuesta cada evidencia con su último dictamen (veredicto, confianza, mapas de
    calor y PDF) y la cadena de custodia del expediente. Antes de mostrar cada objeto verifica su firma. Si el
    almacén no responde, devuelve los datos de PostgreSQL y lo indica en `artifact_issue`.
    """
    case = await run_in_threadpool(owned_case, db, case_id, perito)
    evidence_rows = db.query(Evidence).filter(Evidence.case_id == case.id).order_by(Evidence.uploaded_at.desc()).limit(200).all()
    output = []
    try:
        storage = get_storage()
        storage_issue = None
    except StorageError as error:
        storage = None
        storage_issue = "No se pudo inicializar el almacén de artefactos."
        logger.warning("No se pudo inicializar el almacén para el resumen de casos: %s", str(error))
    for evidence in evidence_rows:
        report = db.query(AnalysisReport).filter(
            AnalysisReport.evidence_id == evidence.id,
            AnalysisReport.status == "COMPLETED",
        ).order_by(AnalysisReport.created_at.desc()).first()
        report_artifacts = db.query(StoredArtifact).filter(
            StoredArtifact.evidence_id == evidence.id,
            StoredArtifact.report_id == (report.id if report else uuid.UUID(int=0)),
            StoredArtifact.owner_id == perito.id,
        ).order_by(StoredArtifact.created_at.desc()).all() if report else []
        json_artifact = next((item for item in report_artifacts if item.kind == "report"), None)
        pdf_artifact = next((item for item in report_artifacts if item.kind == "pdf"), None)
        result = {}
        artifact_issue = storage_issue
        if json_artifact and storage is not None:
            try:
                artifact, manifest = descriptors(json_artifact)
                await run_in_threadpool(storage.verify, artifact, manifest, str(case.id), str(evidence.id), str(perito.id), str(report.id))
                document = json.loads(await run_in_threadpool(storage.read, artifact))
                result = document.get("result") or {}
            except (StorageError, ValueError, TypeError) as error:
                # El resumen debe seguir disponible desde PostgreSQL aunque
                # el almacén remoto esté temporalmente caído o falte un objeto.
                logger.warning("No se pudo recuperar el reporte cifrado de la evidencia %s: %s", evidence.id, str(error))
                artifact_issue = "No se pudo acceder al almacén de artefactos; el resumen usa los datos registrados en PostgreSQL."
        explanation = result.get("explanation") or {}
        frames = explanation.get("frames") or []
        heatmaps = []
        if json_artifact and storage is not None and not artifact_issue:
            plates = {item.storage_uri: item for item in report_artifacts if item.kind == "plate"}
            visual_items = frames if frames else ([explanation] if explanation.get("artifact") else [])
            for visual in visual_items:
                plate_data = visual.get("artifact")
                plate_row = plates.get(plate_data.get("uri")) if isinstance(plate_data, dict) else None
                if not plate_row:
                    continue
                try:
                    plate, manifest = descriptors(plate_row)
                    await run_in_threadpool(storage.verify, plate, manifest, str(case.id), str(evidence.id), str(perito.id), str(report.id))
                    raw = await run_in_threadpool(storage.read, plate)
                    heatmaps.append({"image": "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii"),
                                     "second": visual.get("second"), "signal": visual.get("signal")})
                except StorageError as error:
                    logger.warning("No se pudo recuperar una lámina de %s: %s", evidence.id, str(error))
                    artifact_issue = "Uno o más fotogramas no están disponibles desde el almacén de artefactos."
                    break
        output.append({
            "id": str(evidence.id), "file_name": evidence.file_name, "mime_type": evidence.mime_type,
            "sha256": evidence.sha256_original, "size_bytes": evidence.file_size_bytes,
            "uploaded_at": evidence.uploaded_at.isoformat(),
            "report": ({"id": str(report.id), "verdict": report.verdict, "confidence": float(report.confidence_score) if report.confidence_score is not None else None,
                        "processing_time_seconds": float(report.processing_time_seconds) if report.processing_time_seconds is not None else None,
                        "frames_analyzed": report.frames_analyzed, "faces_detected": report.faces_detected,
                        "created_at": report.created_at.isoformat(), "completed_at": report.completed_at.isoformat() if report.completed_at else None,
                        "expert_conclusions": result.get("expert_conclusions") or report.expert_conclusions, "pdf_artifact_id": str(pdf_artifact.id) if pdf_artifact else None,
                        "heatmaps": heatmaps, "artifact_issue": artifact_issue,
                        "prediction": result.get("prediction"), "models": report.models_metadata} if report else None),
        })
    logs = db.query(CustodyAuditLog).filter(
        CustodyAuditLog.perito_id == perito.id,
        or_(CustodyAuditLog.evidence_id.in_([item.id for item in evidence_rows]) if evidence_rows else CustodyAuditLog.evidence_id.is_(None),
            CustodyAuditLog.details["case_id"].astext == str(case.id)),
    ).order_by(CustodyAuditLog.timestamp.asc()).limit(500).all()
    return {"id": str(case.id), "case_number": case.case_number, "title": case.title, "created_at": case.created_at.isoformat(),
            "evidences": output, "audit": [{"action": row.action, "timestamp": row.timestamp.isoformat(), "actor": perito.external_auth_id,
                                             "hash_verified": row.hash_verified} for row in logs]}


@router.get("/api/v1/cases/{case_id}/artifacts/{artifact_id}/download", tags=[ARCHIVE], summary="Descargar un objeto archivado",
            responses={200: {"description": "El archivo descifrado. La cabecera `X-Content-SHA256` lleva su huella.",
                             "content": {"application/pdf": {}, "application/json": {}, "image/jpeg": {}, "video/mp4": {}}},
                       **errors(404, 409)})
async def download_artifact(case_id: uuid.UUID, artifact_id: uuid.UUID, request: Request, perito=Depends(get_current_perito), db=Depends(get_db)):
    """Verifica la firma y la huella del objeto, lo descifra y lo entrega como adjunto. Cada descarga queda
    en la bitácora de custodia. Responde `409` si el objeto no supera la verificación de integridad.

    La evidencia original (`kind = original`) solo la pueden descargar los roles de administración.
    """
    case = await run_in_threadpool(owned_case, db, case_id, perito)
    row = db.query(StoredArtifact).filter(StoredArtifact.id == artifact_id, StoredArtifact.case_id == case.id, StoredArtifact.owner_id == perito.id).first()
    if not row:
        raise HTTPException(404, "Objeto no encontrado")
    if row.kind == "original" and perito.role_name.strip().upper() not in {"ADMIN", "ADMINISTRADOR", "GERENTE_GENERAL"}:
        await audit(db, perito, request, "ORIGINAL_DOWNLOAD_DENIED", details={"artifact_id": str(row.id), "case_id": str(case.id)}, verified=False)
        raise HTTPException(403, "La descarga del original requiere autorización administrativa.")
    artifact, manifest = descriptors(row)
    storage = get_storage()
    try:
        await run_in_threadpool(storage.verify, artifact, manifest, str(case.id), str(row.evidence_id), str(perito.id), str(row.report_id) if row.report_id else None)
        contents = await run_in_threadpool(storage.read, artifact)
    except IntegrityError:
        await audit(db, perito, request, "ARTIFACT_INTEGRITY_REJECTED", details={"artifact_id": str(row.id), "case_id": str(case.id), "evidence_id": str(row.evidence_id)}, verified=False)
        raise
    await audit(db, perito, request, "ARTIFACT_VERIFIED_AND_DELIVERED", details={"artifact_id": str(row.id), "sha256": row.sha256, "case_id": str(case.id), "evidence_id": str(row.evidence_id)})
    extension = {"application/json": "json", "image/jpeg": "jpg", "video/mp4": "mp4", "image/png": "png", "application/pdf": "pdf"}.get(row.content_type, "bin")
    return Response(contents, media_type=row.content_type, headers={"Content-Disposition": f'attachment; filename="{row.kind}-{row.id}.{extension}"',
        "Cache-Control": "no-store, private", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'", "X-Content-SHA256": row.sha256})


@router.post("/api/v1/cases/{case_id}/reports/{report_id}/finalize", status_code=201, tags=[ARCHIVE], summary="Emitir el informe definitivo",
             responses={201: {"model": ArchiveReceipt, "description": "Nueva versión del informe archivada."}, **errors(404, 409, 422)})
async def finalize_report(case_id: uuid.UUID, report_id: uuid.UUID, body: FinalizeReportSchema, request: Request, perito=Depends(get_current_perito), db=Depends(get_db)):
    """Añade las conclusiones del perito al dictamen y genera un nuevo informe PDF con los mapas de calor y
    la cadena de custodia. La versión anterior no se borra: la nueva queda sellada y enlazada a ella, y el
    `pdf_artifact_id` del resumen pasa a apuntar al PDF nuevo.
    """
    case = await run_in_threadpool(owned_case, db, case_id, perito)
    report = db.query(AnalysisReport).filter(AnalysisReport.id == report_id, AnalysisReport.perito_id == perito.id).first()
    row = db.query(StoredArtifact).filter(StoredArtifact.case_id == case.id, StoredArtifact.report_id == report_id, StoredArtifact.kind == "report").order_by(StoredArtifact.created_at.desc()).first()
    if not report or not row:
        raise HTTPException(404, "Reporte no encontrado")
    artifact, manifest = descriptors(row)
    storage = get_storage()
    await run_in_threadpool(storage.verify, artifact, manifest, str(case.id), str(row.evidence_id), str(perito.id), str(report_id))
    previous_document = json.loads(await run_in_threadpool(storage.read, artifact))
    evidence = db.query(Evidence).filter(Evidence.id == row.evidence_id, Evidence.case_id == case.id).first()
    _, original, evidence_manifest = await run_in_threadpool(verified_working, db, case, evidence, perito)
    result = previous_document["result"]
    result["expert_conclusions"] = body.expert_conclusions
    audit_rows = db.query(CustodyAuditLog).filter(
        CustodyAuditLog.perito_id == perito.id,
        or_(CustodyAuditLog.evidence_id == evidence.id,
            CustodyAuditLog.details["case_id"].astext == str(case.id)),
    ).order_by(CustodyAuditLog.timestamp.asc()).limit(500).all()
    audit_events = [{"timestamp": item.timestamp.isoformat(), "actor": perito.external_auth_id,
                     "action": item.action} for item in audit_rows]
    # El PDF lleva los mapas de calor descifrados; el resultado archivado mantiene solo sus referencias selladas.
    pdf_result = await run_in_threadpool(with_plates, storage, db, case, evidence, perito, report.id, result)
    pdf_bytes = await run_in_threadpool(build_forensic_pdf, case=case, evidence=evidence, report_id=str(report.id), result=pdf_result,
        original_sha256=original.sha256, working_sha256=evidence.sha256_working_copy,
        expert_conclusions=body.expert_conclusions, audit_events=audit_events, perito=perito)
    bundle = await run_in_threadpool(storage.archive_report, result, str(case.id), str(evidence.id), str(report.id), str(perito.id), perito.external_auth_id,
        evidence_manifest, original, previous_document["provenance"], {"artifact_id": str(row.id), "uri": row.storage_uri, "sha256": row.sha256}, pdf_bytes)
    rows = await run_in_threadpool(add_bundle, db, bundle, case, evidence, perito, report)
    await audit(db, perito, request, "EXPERT_REPORT_REVISION_ARCHIVED", evidence, {"report_id": str(report_id), "previous_artifact_id": str(row.id)})
    return receipt(case, evidence, report, rows)


@router.get("/api/v1/cases/{case_id}/custody-log", tags=[ARCHIVE], summary="Bitácora de custodia",
            responses={200: {"model": list[CustodyEvent], "description": "Hasta 500 eventos, del más reciente al más antiguo."}, **errors(404)})
async def custody_log(case_id: uuid.UUID, perito=Depends(get_current_perito), db=Depends(get_db)):
    """Registro de cada acción sobre el expediente y sus evidencias (creación, ingesta, análisis, descargas e
    informes) con la verificación de huella y los detalles de cada evento.
    """
    case = await run_in_threadpool(owned_case, db, case_id, perito)
    ids = [item.id for item in db.query(Evidence).filter(Evidence.case_id == case.id).all()]
    logs = db.query(CustodyAuditLog).filter(CustodyAuditLog.perito_id == perito.id, or_(CustodyAuditLog.evidence_id.in_(ids), CustodyAuditLog.details["case_id"].astext == str(case.id))).order_by(CustodyAuditLog.timestamp.desc()).limit(500).all()
    return [{"id": row.id, "action": row.action, "hash_verified": row.hash_verified, "details": row.details, "timestamp": row.timestamp.isoformat()} for row in logs]


@router.get("/api/v1/storage/status", tags=[ARCHIVE], summary="Estado del almacén forense",
            responses={200: {"model": StorageStatus, "description": "El almacén responde y la retención está activa."}})
async def storage_status():
    """Comprueba que el almacén de objetos responde y que la retención inmutable sigue activa."""
    storage = get_storage()
    await run_in_threadpool(storage.store.check)
    retention = await run_in_threadpool(storage.retention.check)
    return {"ready": True, "backend": "local" if storage.config.local else "s3", "encrypted": True, "signed_manifests": True, "retention": retention}
