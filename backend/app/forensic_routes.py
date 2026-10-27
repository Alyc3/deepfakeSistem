import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from sqlalchemy import or_

from app.auth_service import get_current_perito, record_audit_event
from app.database import get_db
from app.forensic_storage import get_storage
from app.forensic_workflow import add_bundle, analyze_and_archive, descriptors, owned_case, preserve, read_upload, verified_working
from app.identity import require_laboratory
from app.models_db import AnalysisReport, CustodyAuditLog, Evidence, ForensicCase, StoredArtifact
from app.schemas import CaseCreateSchema, FinalizeReportSchema
from app.storage.ports import IntegrityError, StorageError
from app.storage.sealing import sha256

router = APIRouter(dependencies=[Depends(require_laboratory)], tags=["Custodia y archivo forense"])


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
    data, mime = await read_upload(file)
    if expected_sha256 is not None and expected_sha256.lower() != sha256(data):
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


@router.post("/api/v1/cases", status_code=201)
async def create_case(case_data: CaseCreateSchema, request: Request, perito=Depends(get_current_perito), db=Depends(get_db)):
    if db.query(ForensicCase).filter(ForensicCase.case_number == case_data.case_number).first():
        raise HTTPException(409, "El número de expediente ya existe")
    case = ForensicCase(id=uuid.uuid4(), case_number=case_data.case_number, title=case_data.title, description=case_data.description, perito_id=perito.id)
    db.add(case)
    await audit(db, perito, request, "CASE_CREATED", details={"case_id": str(case.id), "case_number": case.case_number})
    return {"id": str(case.id), "case_number": case.case_number, "title": case.title}


@router.get("/api/v1/cases")
async def list_cases(perito=Depends(get_current_perito), db=Depends(get_db)):
    cases = db.query(ForensicCase).filter(ForensicCase.perito_id == perito.id).order_by(ForensicCase.created_at.desc()).limit(200).all()
    return [{"id": str(case.id), "case_number": case.case_number, "title": case.title, "created_at": case.created_at.isoformat()} for case in cases]


@router.post("/api/v1/cases/{case_id}/ingest", status_code=201)
async def ingest_case(case_id: uuid.UUID, request: Request, file: UploadFile = File(...), expected_sha256: Optional[str] = Form(None), perito=Depends(get_current_perito), db=Depends(get_db)):
    case = await run_in_threadpool(owned_case, db, case_id, perito)
    evidence, rows = await ingest(db, case, perito, request, file, expected_sha256)
    return {**receipt(case, evidence, None, rows), "sha256_original": evidence.sha256_original, "sha256_working_copy": evidence.sha256_working_copy, "status": "PRESERVED_AND_VERIFIED"}


@router.post("/api/v1/cases/{case_id}/analyze")
async def analyze_case(case_id: uuid.UUID, request: Request, evidence_id: Optional[uuid.UUID] = Form(None), file: Optional[UploadFile] = File(None), expected_sha256: Optional[str] = Form(None), perito=Depends(get_current_perito), db=Depends(get_db)):
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


@router.post("/predict")
async def preserved_prediction(request: Request, file: UploadFile = File(...), expected_sha256: Optional[str] = Form(None), perito=Depends(get_current_perito), db=Depends(get_db)):
    """Compatibilidad con la web: ahora también crea expediente y preserva todo."""
    get_storage().retention.check()
    case_id = uuid.uuid4()
    case = ForensicCase(id=case_id, case_number=f"CF-{datetime.now(timezone.utc):%Y%m%d}-{case_id.hex}", title=(file.filename or "Análisis de evidencia")[:255], perito_id=perito.id)
    db.add(case)
    await audit(db, perito, request, "CASE_CREATED", details={"case_id": str(case.id), "source": "laboratory"})
    evidence, evidence_rows = await ingest(db, case, perito, request, file, expected_sha256)
    result = await analyze(db, case, evidence, perito, request)
    result["archive"]["objects"].extend(receipt(case, evidence, None, evidence_rows)["objects"])
    return result


@router.get("/api/v1/cases/{case_id}/evidences")
async def list_evidence(case_id: uuid.UUID, perito=Depends(get_current_perito), db=Depends(get_db)):
    case = await run_in_threadpool(owned_case, db, case_id, perito)
    evidence = db.query(Evidence).filter(Evidence.case_id == case.id).order_by(Evidence.uploaded_at.desc()).limit(200).all()
    return [{"id": str(item.id), "file_name": item.file_name, "sha256": item.sha256_original, "size_bytes": item.file_size_bytes, "uploaded_at": item.uploaded_at.isoformat()} for item in evidence]


@router.get("/api/v1/cases/{case_id}/artifacts")
async def list_artifacts(case_id: uuid.UUID, perito=Depends(get_current_perito), db=Depends(get_db)):
    case = await run_in_threadpool(owned_case, db, case_id, perito)
    artifacts = db.query(StoredArtifact).filter(StoredArtifact.case_id == case.id, StoredArtifact.owner_id == perito.id).order_by(StoredArtifact.created_at.desc()).limit(500).all()
    return [{"id": str(row.id), "evidence_id": str(row.evidence_id), "report_id": str(row.report_id) if row.report_id else None,
             "kind": row.kind, "sha256": row.sha256, "size_bytes": row.size_bytes, "created_at": row.created_at.isoformat()} for row in artifacts]


@router.get("/api/v1/cases/{case_id}/artifacts/{artifact_id}/download")
async def download_artifact(case_id: uuid.UUID, artifact_id: uuid.UUID, request: Request, perito=Depends(get_current_perito), db=Depends(get_db)):
    case = await run_in_threadpool(owned_case, db, case_id, perito)
    row = db.query(StoredArtifact).filter(StoredArtifact.id == artifact_id, StoredArtifact.case_id == case.id, StoredArtifact.owner_id == perito.id).first()
    if not row:
        raise HTTPException(404, "Objeto no encontrado")
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


@router.post("/api/v1/cases/{case_id}/reports/{report_id}/finalize", status_code=201)
async def finalize_report(case_id: uuid.UUID, report_id: uuid.UUID, body: FinalizeReportSchema, request: Request, perito=Depends(get_current_perito), db=Depends(get_db)):
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
    bundle = await run_in_threadpool(storage.archive_report, result, str(case.id), str(evidence.id), str(report.id), str(perito.id), perito.external_auth_id,
        evidence_manifest, original, previous_document["provenance"], {"artifact_id": str(row.id), "uri": row.storage_uri, "sha256": row.sha256})
    rows = await run_in_threadpool(add_bundle, db, bundle, case, evidence, perito, report)
    await audit(db, perito, request, "EXPERT_REPORT_REVISION_ARCHIVED", evidence, {"report_id": str(report_id), "previous_artifact_id": str(row.id)})
    return receipt(case, evidence, report, rows)


@router.get("/api/v1/cases/{case_id}/custody-log")
async def custody_log(case_id: uuid.UUID, perito=Depends(get_current_perito), db=Depends(get_db)):
    case = await run_in_threadpool(owned_case, db, case_id, perito)
    ids = [item.id for item in db.query(Evidence).filter(Evidence.case_id == case.id).all()]
    logs = db.query(CustodyAuditLog).filter(CustodyAuditLog.perito_id == perito.id, or_(CustodyAuditLog.evidence_id.in_(ids), CustodyAuditLog.details["case_id"].astext == str(case.id))).order_by(CustodyAuditLog.timestamp.desc()).limit(500).all()
    return [{"id": row.id, "action": row.action, "hash_verified": row.hash_verified, "details": row.details, "timestamp": row.timestamp.isoformat()} for row in logs]


@router.get("/api/v1/storage/status")
async def storage_status():
    storage = get_storage()
    await run_in_threadpool(storage.store.check)
    retention = await run_in_threadpool(storage.retention.check)
    return {"ready": True, "backend": "local" if storage.config.local else "s3", "encrypted": True, "signed_manifests": True, "retention": retention}
