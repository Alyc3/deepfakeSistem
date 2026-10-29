"""Trabajos Celery que ejecutan inferencia fuera del proceso HTTP."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.celery_app import celery_app
from app.database import SessionLocal
from app.forensic_workflow import analyze_and_archive
from app.models_db import AnalysisJob, CustodyAuditLog, Evidence, ForensicCase, Perito, StoredArtifact


@celery_app.task(bind=True, name="certiface.analyze_evidence", acks_late=True)
def analyze_evidence_task(self, case_id: str, evidence_id: str, perito_id: str, job_id: str) -> dict:
    db = SessionLocal()
    try:
        case = db.query(ForensicCase).filter(ForensicCase.id == uuid.UUID(case_id)).one()
        evidence = db.query(Evidence).filter(Evidence.id == uuid.UUID(evidence_id), Evidence.case_id == case.id).one()
        perito = db.query(Perito).filter(Perito.id == uuid.UUID(perito_id)).one()
        job = db.query(AnalysisJob).filter(AnalysisJob.id == uuid.UUID(job_id), AnalysisJob.evidence_id == evidence.id,
                                            AnalysisJob.perito_id == perito.id).one()
        job.status = "PROCESSING"
        db.commit()
        self.update_state(state="PROCESSING", meta={"job_id": job_id})
        result, report, rows = analyze_and_archive(db, case, evidence, perito)
        job.status = "COMPLETED"
        job.report_id = report.id
        job.updated_at = datetime.now(timezone.utc)
        db.add(CustodyAuditLog(perito_id=perito.id, evidence_id=evidence.id, action="INFERENCE_ARCHIVED",
                               ip_address="worker", hash_verified=True,
                               details={"case_id": case_id, "report_id": str(report.id), "job_id": job_id}))
        db.commit()
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
