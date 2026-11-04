"""Trabajos Celery que ejecutan inferencia fuera del proceso HTTP."""
from __future__ import annotations

import uuid
import logging
from datetime import datetime, timezone

from app.celery_app import celery_app
from app.database import SessionLocal
from app.forensic_workflow import analyze_and_archive
from app.models_db import AnalysisJob, CustodyAuditLog, Evidence, ForensicCase, Perito, StoredArtifact

logger = logging.getLogger("certiface.worker")


@celery_app.task(bind=True, name="certiface.analyze_evidence", acks_late=True)
def analyze_evidence_task(self, case_id: str, evidence_id: str, perito_id: str, job_id: str) -> dict:
    started = datetime.now(timezone.utc)
    logger.info("Inferencia iniciada job_id=%s case_id=%s evidence_id=%s task_id=%s",
                job_id, case_id, evidence_id, self.request.id)
    db = SessionLocal()
    progress_events = []

    def publish_progress(stage: str, message: str, current=None, total=None, event_id=None):
        event_id = event_id or f"{stage}-{len(progress_events) + 1}"
        if not progress_events or progress_events[-1]["id"] != event_id:
            progress_events.append({"id": event_id, "message": message, "timestamp": datetime.now(timezone.utc).isoformat()})
        else:
            progress_events[-1]["message"] = message
            progress_events[-1]["timestamp"] = datetime.now(timezone.utc).isoformat()
        meta = {"stage": stage, "message": message, "events": progress_events[-80:]}
        if current is not None:
            meta["current"] = current
        if total is not None:
            meta["total"] = total
        self.update_state(state="PROCESSING", meta=meta)

    try:
        case = db.query(ForensicCase).filter(ForensicCase.id == uuid.UUID(case_id)).one()
        evidence = db.query(Evidence).filter(Evidence.id == uuid.UUID(evidence_id), Evidence.case_id == case.id).one()
        perito = db.query(Perito).filter(Perito.id == uuid.UUID(perito_id)).one()
        job = db.query(AnalysisJob).filter(AnalysisJob.id == uuid.UUID(job_id), AnalysisJob.evidence_id == evidence.id,
                                            AnalysisJob.perito_id == perito.id).one()
        job.status = "PROCESSING"
        db.commit()
        publish_progress("verification", "Trabajo recibido; preparando la verificación forense")
        result, report, rows = analyze_and_archive(db, case, evidence, perito, progress_callback=publish_progress)
        job.status = "COMPLETED"
        job.report_id = report.id
        job.updated_at = datetime.now(timezone.utc)
        db.add(CustodyAuditLog(perito_id=perito.id, evidence_id=evidence.id, action="INFERENCE_ARCHIVED",
                               ip_address="worker", hash_verified=True,
                               details={"case_id": case_id, "report_id": str(report.id), "job_id": job_id}))
        db.commit()
        publish_progress("completed", f"Análisis terminado: {report.verdict}")
        elapsed = (datetime.now(timezone.utc) - started).total_seconds()
        logger.info("Inferencia completada job_id=%s case_id=%s evidence_id=%s report_id=%s duration_seconds=%.2f verdict=%s",
                    job_id, case_id, evidence_id, report.id, elapsed, report.verdict)
        result["archive"] = {
            "case_id": case_id,
            "evidence_id": evidence_id,
            "report_id": str(report.id),
            "objects": [{"id": str(row.id), "kind": row.kind, "sha256": row.sha256, "size_bytes": row.size_bytes}
                        for row in [*rows, *db.query(StoredArtifact).filter(StoredArtifact.evidence_id == evidence.id,
                                                                          StoredArtifact.report_id.is_(None)).all()]],
            "retention_verified": all(row.retention.get("verified") is True for row in rows),
        }
        return result
    except Exception:
        logger.exception("Inferencia fallida job_id=%s case_id=%s evidence_id=%s",
                         job_id, case_id, evidence_id)
        db.rollback()
        job = db.query(AnalysisJob).filter(AnalysisJob.id == uuid.UUID(job_id)).first()
        if job:
            job.status = "FAILED"
            job.error_detail = "La inferencia no pudo completarse."
            job.updated_at = datetime.now(timezone.utc)
            db.commit()
        raise
    finally:
        db.close()
