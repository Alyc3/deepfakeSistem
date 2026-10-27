import uuid
from datetime import datetime
from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship

from app.database import Base


class Perito(Base):
    __tablename__ = "peritos"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    external_auth_id = Column(String(255), unique=True, nullable=False, index=True)
    email = Column(String(255), nullable=False)
    first_name = Column(String(150), nullable=False)
    last_name = Column(String(150), nullable=False)
    identifier = Column(String(100), nullable=False)  # Cédula o Matrícula pericial
    role_name = Column(String(50), nullable=False)
    phone_number = Column(String(50), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    last_synced_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    cases = relationship("ForensicCase", back_populates="perito")
    audit_logs = relationship("CustodyAuditLog", back_populates="perito")
    reports = relationship("AnalysisReport", back_populates="perito")


class ForensicCase(Base):
    __tablename__ = "forensic_cases"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_number = Column(String(100), unique=True, nullable=False, index=True)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    perito_id = Column(UUID(as_uuid=True), ForeignKey("peritos.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    perito = relationship("Perito", back_populates="cases")
    evidences = relationship("Evidence", back_populates="case", cascade="all, delete-orphan")


class Evidence(Base):
    __tablename__ = "evidences"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_id = Column(UUID(as_uuid=True), ForeignKey("forensic_cases.id", ondelete="CASCADE"), nullable=False)
    file_name = Column(String(255), nullable=False)
    file_size_bytes = Column(BigInteger, nullable=False)
    mime_type = Column(String(100), nullable=False)
    sha256_original = Column(String(64), nullable=False, index=True)
    sha256_working_copy = Column(String(64), nullable=False)
    original_storage_uri = Column(Text, nullable=False)
    working_storage_uri = Column(Text, nullable=False)
    duration_seconds = Column(Numeric(8, 3), nullable=True)
    fps = Column(Numeric(6, 2), nullable=True)
    total_frames = Column(Integer, nullable=True)
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    uploaded_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    case = relationship("ForensicCase", back_populates="evidences")
    audit_logs = relationship("CustodyAuditLog", back_populates="evidence", cascade="all, delete-orphan")
    reports = relationship("AnalysisReport", back_populates="evidence", cascade="all, delete-orphan")


class CustodyAuditLog(Base):
    __tablename__ = "custody_audit_log"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    evidence_id = Column(UUID(as_uuid=True), ForeignKey("evidences.id", ondelete="CASCADE"), nullable=True, index=True)
    perito_id = Column(UUID(as_uuid=True), ForeignKey("peritos.id"), nullable=False, index=True)
    action = Column(String(100), nullable=False)
    ip_address = Column(String(45), nullable=False)
    user_agent = Column(Text, nullable=True)
    hash_verified = Column(Boolean, default=True, nullable=False)
    synced_to_central_audit = Column(Boolean, default=False)
    details = Column(JSONB, default=dict)
    timestamp = Column(DateTime(timezone=True), default=datetime.utcnow)

    evidence = relationship("Evidence", back_populates="audit_logs")
    perito = relationship("Perito", back_populates="audit_logs")


class AnalysisReport(Base):
    __tablename__ = "analysis_reports"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    evidence_id = Column(UUID(as_uuid=True), ForeignKey("evidences.id", ondelete="CASCADE"), nullable=False)
    perito_id = Column(UUID(as_uuid=True), ForeignKey("peritos.id"), nullable=False)
    status = Column(String(30), default="QUEUED", nullable=False)  # QUEUED, PROCESSING, COMPLETED, FAILED
    verdict = Column(String(30), nullable=True, index=True)  # MANIPULADO, SIN_MANIPULACION, ANTECEDENTES
    confidence_score = Column(Numeric(5, 2), nullable=True)
    caveat_notes = Column(Text, nullable=True)
    processing_time_seconds = Column(Numeric(8, 2), nullable=True)
    hardware_info = Column(String(255), nullable=True)
    frames_analyzed = Column(Integer, nullable=True)
    faces_detected = Column(Integer, nullable=True)
    models_metadata = Column(JSONB, default=dict)
    expert_conclusions = Column(Text, nullable=True)
    pdf_report_uri = Column(Text, nullable=True)
    pdf_sha256 = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    evidence = relationship("Evidence", back_populates="reports")
    perito = relationship("Perito", back_populates="reports")
    inconsistencies = relationship("TimecodeInconsistency", back_populates="report", cascade="all, delete-orphan")


class TimecodeInconsistency(Base):
    __tablename__ = "timecode_inconsistencies"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    report_id = Column(UUID(as_uuid=True), ForeignKey("analysis_reports.id", ondelete="CASCADE"), nullable=False, index=True)
    timecode_start = Column(String(12), nullable=False)  # "00:01:23.450"
    timecode_end = Column(String(12), nullable=False)    # "00:01:25.100"
    duration_seconds = Column(Numeric(6, 3), nullable=False)
    frame_start = Column(Integer, nullable=False)
    frame_end = Column(Integer, nullable=False)
    peak_timecode = Column(String(12), nullable=False)
    peak_frame = Column(Integer, nullable=False)
    peak_anomaly_score = Column(Numeric(5, 4), nullable=False)
    anomaly_family = Column(String(50), nullable=False)  # "FACE_SWAP", "DIFFUSION", "GAN"
    demonstrative_plate_uri = Column(Text, nullable=True)

    report = relationship("AnalysisReport", back_populates="inconsistencies")


class StoredArtifact(Base):
    """Índice append-only de objetos cifrados. No existen operaciones UPDATE/DELETE."""
    __tablename__ = "stored_artifacts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_id = Column(UUID(as_uuid=True), ForeignKey("forensic_cases.id"), nullable=False, index=True)
    evidence_id = Column(UUID(as_uuid=True), ForeignKey("evidences.id"), nullable=False, index=True)
    report_id = Column(UUID(as_uuid=True), ForeignKey("analysis_reports.id"), nullable=True, index=True)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("peritos.id"), nullable=False, index=True)
    kind = Column(String(30), nullable=False)
    storage_uri = Column(Text, nullable=False, unique=True)
    sha256 = Column(String(64), nullable=False)
    size_bytes = Column(BigInteger, nullable=False)
    content_type = Column(String(100), nullable=False)
    manifest_uri = Column(Text, nullable=False)
    manifest_sha256 = Column(String(64), nullable=False)
    manifest_size_bytes = Column(BigInteger, nullable=False)
    signing_key_id = Column(String(64), nullable=False)
    retention = Column(JSONB, nullable=False)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
