from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class VerdictEnum(str, Enum):
    MANIPULADO = "MANIPULADO"
    SIN_MANIPULACION = "SIN_MANIPULACION"
    ANTECEDENTES = "ANTECEDENTES"


class RoleSchema(BaseModel):
    id: str
    name: str
    description: Optional[str] = None


class PeritoSchema(BaseModel):
    id: str
    email: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    identifier: Optional[str] = None
    phone_number: Optional[str] = None
    role: Optional[RoleSchema] = None
    status: Optional[str] = None


class TimecodeInconsistencySchema(BaseModel):
    inconsistency_id: Optional[str] = None
    timecode_start: str = Field(..., description="Formato hh:mm:ss.mmm")
    timecode_end: str = Field(..., description="Formato hh:mm:ss.mmm")
    duration_seconds: float
    frame_start: int
    frame_end: int
    peak_timecode: str
    peak_frame: int
    peak_anomaly_score: float
    anomaly_family: str
    demonstrative_plate_uri: Optional[str] = None


class AuditEventSchema(BaseModel):
    user_id: str
    action: str
    endpoint: Optional[str] = None
    ip_address: Optional[str] = None
    details: Optional[Dict[str, Any]] = None


class CaseCreateSchema(BaseModel):
    case_number: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=10000)


class FinalizeReportSchema(BaseModel):
    expert_conclusions: str = Field(min_length=1, max_length=20000)
