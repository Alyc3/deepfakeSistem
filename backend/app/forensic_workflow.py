"""Aplicación: persistencia de ingesta y análisis, sin exponer URLs públicas."""
import hashlib
import importlib.metadata
import threading
import time
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

from fastapi import HTTPException, UploadFile

from app.forensic_storage import PreservedBundle, get_storage
from app.models_db import AnalysisReport, Evidence, ForensicCase, StoredArtifact, TimecodeInconsistency
from app.storage.config import BACKEND, StorageConfig
from app.storage.ports import Artifact, IntegrityError
from app.storage.sealing import sha256

_inference_lock = threading.Lock()
ALLOWED_MIMES = {"image/jpeg", "image/png", "image/webp", "image/bmp", "image/gif", "video/mp4", "video/quicktime", "video/x-msvideo", "video/x-matroska", "video/webm"}


def owned_case(db, case_id, perito):
    case = db.query(ForensicCase).filter(ForensicCase.id == case_id, ForensicCase.perito_id == perito.id).first()
    if not case:
        raise HTTPException(404, "Expediente no encontrado")
    return case


async def read_upload(file: UploadFile) -> tuple[bytes, str]:
    try:
        mime = (file.content_type or "").lower()
        if mime not in ALLOWED_MIMES:
            raise HTTPException(415, "Formato de imagen o video no permitido")
        limit = StorageConfig.from_env().max_upload
        contents = bytearray()
        while chunk := await file.read(1024 * 1024):
            if len(contents) + len(chunk) > limit:
                raise HTTPException(413, "La evidencia supera el tamaño máximo permitido")
            contents.extend(chunk)
        if not contents:
            raise HTTPException(422, "El archivo está vacío")
        return bytes(contents), mime
    finally:
        await file.close()


def descriptors(row: StoredArtifact) -> tuple[Artifact, Artifact]:
    return (Artifact(row.kind, row.storage_uri, row.sha256, row.size_bytes, row.content_type),
            Artifact("manifest", row.manifest_uri, row.manifest_sha256, row.manifest_size_bytes, "application/json"))


def add_bundle(db, bundle: PreservedBundle, case, evidence, perito, report=None) -> list[StoredArtifact]:
    rows = []
    for artifact in [*bundle.artifacts, bundle.manifest]:
        row = StoredArtifact(id=uuid.uuid4(), case_id=case.id, evidence_id=evidence.id,
            report_id=report.id if report else None, owner_id=perito.id, kind=artifact.kind,
            storage_uri=artifact.uri, sha256=artifact.sha256, size_bytes=artifact.size,
            content_type=artifact.content_type, manifest_uri=bundle.manifest.uri,
            manifest_sha256=bundle.manifest.sha256, manifest_size_bytes=bundle.manifest.size,
            signing_key_id=bundle.signing_key_id, retention=bundle.retention)
        db.add(row)
        rows.append(row)
    return rows


def preserve(db, case, perito, data: bytes, mime: str, name: str):
    evidence_id = uuid.uuid4()
    storage = get_storage()
    bundle = storage.ingest(data, name, mime, str(case.id), str(evidence_id), str(perito.id), perito.external_auth_id)
    original, working = bundle.artifacts
    evidence = Evidence(id=evidence_id, case_id=case.id, file_name=name[:255], file_size_bytes=len(data), mime_type=mime,
        sha256_original=original.sha256, sha256_working_copy=working.sha256,
        original_storage_uri=original.uri, working_storage_uri=working.uri)
    db.add(evidence)
    rows = add_bundle(db, bundle, case, evidence, perito)
    db.flush()
    return evidence, rows


def verified_working(db, case, evidence, perito):
    rows = db.query(StoredArtifact).filter(StoredArtifact.evidence_id == evidence.id, StoredArtifact.report_id.is_(None), StoredArtifact.kind.in_(["original", "working"])).all()
    by_kind = {row.kind: row for row in rows}
    if set(by_kind) != {"original", "working"}:
        raise IntegrityError("La evidencia no tiene un manifiesto forense verificable; requiere migración controlada")
    original, manifest = descriptors(by_kind["original"])
    working, work_manifest = descriptors(by_kind["working"])
    if (original.uri != evidence.original_storage_uri or working.uri != evidence.working_storage_uri or
        original.sha256 != evidence.sha256_original or working.sha256 != evidence.sha256_working_copy or
        original.sha256 != working.sha256 or manifest != work_manifest):
        raise IntegrityError("El expediente no coincide con las referencias de custodia")
    storage = get_storage()
    for artifact in [original, working]:
        storage.verify(artifact, manifest, str(case.id), str(evidence.id), str(perito.id))
    # También se recupera el original para verificar la correspondencia vigente,
    # pero únicamente los bytes recuperados de la copia entran al decodificador.
    storage.read(original)
    data = storage.read(working)
    return data, original, manifest


@lru_cache(maxsize=32)
def fingerprint(path: str, size: int, modified: int) -> str:
    with open(path, "rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def provenance() -> dict:
    sources = [*sorted((BACKEND / "app").glob("*.py")), *sorted((BACKEND / "app" / "storage").glob("*.py"))]
    weights = [path for path in (BACKEND / "models").rglob("*") if path.is_file() and path.suffix in (".pth", ".safetensors", ".onnx", ".json")]
    inventory = {}
    for path in [*sources, *weights]:
        stat = path.stat()
        inventory[str(path.relative_to(BACKEND)).replace("\\", "/")] = fingerprint(str(path), stat.st_size, stat.st_mtime_ns)
    return {"files_sha256": inventory, "packages": {name: importlib.metadata.version(name) for name in ["torch", "torchvision", "transformers", "timm", "cryptography"]}}


def run_inference(data: bytes, mime: str) -> dict:
    # YuNet y las capturas de activaciones son compartidos: no mezclar solicitudes.
    with _inference_lock:
        from app.model import predict_image, predict_video
        from app.preprocessing import extract_frames
        if mime.startswith("video/"):
            frames = extract_frames(data)
            if not frames:
                raise HTTPException(422, "No se pudo decodificar el video preservado")
            return predict_video(frames)
        return predict_image(data)


def analyze_and_archive(db, case, evidence, perito):
    storage = get_storage()
    storage.retention.check()
    data, original, evidence_manifest = verified_working(db, case, evidence, perito)
    started = time.perf_counter()
    try:
        result = run_inference(data, evidence.mime_type)
    except (OSError, ValueError):
        raise HTTPException(422, "No se pudo interpretar la evidencia preservada") from None
    processing_time = round(time.perf_counter() - started, 2)
    prediction = result.get("prediction")
    if prediction == "Fake":
        verdict = "MANIPULADO"
    elif prediction != "Real" or result.get("caveat") or result.get("faces_detected", 0) == 0:
        verdict = "ANTECEDENTES"
    else:
        verdict = "SIN_MANIPULACION"
    report_id = uuid.uuid4()
    result.update(report_id=str(report_id), verdict_forensic=verdict, processing_time_seconds=processing_time)
    bundle = storage.archive_report(result, str(case.id), str(evidence.id), str(report_id), str(perito.id), perito.external_auth_id,
        evidence_manifest, original, provenance())
    report = AnalysisReport(id=report_id, evidence_id=evidence.id, perito_id=perito.id, status="COMPLETED", verdict=verdict,
        confidence_score=result.get("confidence"), caveat_notes=result.get("caveat"), processing_time_seconds=processing_time,
        hardware_info="PyTorch", frames_analyzed=result.get("frames_analyzed", 1), faces_detected=result.get("faces_detected", 0),
        models_metadata=result.get("models", {}), completed_at=datetime.now(timezone.utc))
    db.add(report)
    rows = add_bundle(db, bundle, case, evidence, perito, report)
    for suspect in result.get("suspicious_seconds", []):
        seconds = float(suspect["second"])
        hours, remainder = divmod(seconds, 3600)
        minutes, second = divmod(remainder, 60)
        timecode = f"{int(hours):02d}:{int(minutes):02d}:{second:06.3f}"
        db.add(TimecodeInconsistency(report_id=report.id, timecode_start=timecode, timecode_end=timecode,
            duration_seconds=0, frame_start=0, frame_end=0, peak_timecode=timecode, peak_frame=0,
            peak_anomaly_score=suspect["score"], anomaly_family="FACE_SWAP"))
    db.flush()
    return result, report, rows
