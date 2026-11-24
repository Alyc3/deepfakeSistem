"""Esquemas de la API.

Los de entrada (`*Schema`) validan el cuerpo de las solicitudes. Los de salida
documentan las respuestas en ReDoc (se declaran con `responses=` y no filtran
lo que devuelve cada ruta).
"""
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.validators import CaseDescription, CaseNumber, CaseTitle, Conclusions

Prediction = Literal["Real", "Fake", "Suspect"]
Verdict = Literal["MANIPULADO", "SIN_MANIPULACION", "ANTECEDENTES"]


# --- Entrada -------------------------------------------------------------------

class CaseCreateSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")
    case_number: CaseNumber = Field(description="Número de expediente único. Letras sin tildes, números y `- / .`; se guarda en mayúsculas.",
                                    examples=["FGE-2026-0001"])
    title: CaseTitle = Field(description="Nombre descriptivo del caso (3 a 255 caracteres).", examples=["Video difundido en redes sociales"])
    description: CaseDescription = Field(None, description="Contexto del caso (opcional, hasta 10 000 caracteres).")


class FinalizeReportSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expert_conclusions: Conclusions = Field(description="Conclusiones del perito (10 a 20 000 caracteres). Se incorporan al informe PDF definitivo.",
                                            examples=["Tras revisar los fotogramas señalados, se concluye que el rostro fue sustituido."])


# --- Errores -------------------------------------------------------------------

class ErrorResponse(BaseModel):
    detail: str = Field(description="Mensaje en español, listo para mostrarse al usuario.", examples=["Expediente no encontrado"])


class ValidationErrorResponse(ErrorResponse):
    errors: list[str] = Field(description="Cada motivo de rechazo por separado.",
                              examples=[["Número de caso: escribe al menos 3 caracteres."]])


# --- Estado del servicio -------------------------------------------------------

class LiveStatus(BaseModel):
    status: str = Field(examples=["ok"])
    service: str = Field(examples=["CertiFace Forensic API"])
    models: str = Field(description="`loaded` cuando los pesos de los modelos ya están en memoria.", examples=["loaded"])


class StorageHealth(BaseModel):
    encrypted: bool
    retention_verified: bool = Field(description="El bucket mantiene activo el bloqueo de objetos (retención inmutable).")


class ReadyStatus(BaseModel):
    status: str = Field(examples=["ok"])
    service: str
    storage: StorageHealth
    database: str = Field(examples=["connected (Neon PostgreSQL 16)"])
    version: str = Field(examples=["2.0.0"])


class StorageStatus(BaseModel):
    ready: bool
    backend: Literal["local", "s3"] = Field(description="`s3` en producción (Cloudflare R2); `local` en desarrollo.")
    encrypted: bool
    signed_manifests: bool
    retention: dict[str, Any] = Field(description="Resultado de la comprobación de retención del almacén.")


# --- Autenticación -------------------------------------------------------------

class PeritoProfile(BaseModel):
    id: str = Field(description="Identificador interno del perito en CertiFace.")
    external_auth_id: str = Field(description="Identificador de la cuenta en el auth-service.")
    email: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    identifier: Optional[str] = Field(None, description="Cédula (10 dígitos) o RUC (13).")
    role_name: Optional[str] = None
    phone_number: Optional[str] = None
    is_active: bool


class LoginResponse(BaseModel):
    access_token: str = Field(description="Token para la cabecera `Authorization: Bearer`.")
    token_type: Literal["bearer"]
    user: dict[str, Any] = Field(description="Perfil de la cuenta tal como lo devuelve el auth-service (incluye `role`).")


# --- Expedientes ---------------------------------------------------------------

class CaseCreated(BaseModel):
    id: str
    case_number: str = Field(examples=["FGE-2026-0001"])
    title: str


class CaseListItem(BaseModel):
    id: str
    case_number: str
    title: str
    description: Optional[str] = Field(None, description="Primeros 160 caracteres de la descripción.")
    created_at: Optional[str] = Field(None, description="Fecha ISO 8601.")
    evidences: int = Field(description="Número de evidencias del expediente.")
    verdict: Optional[Verdict] = Field(None, description="Veredicto del análisis más reciente, si lo hay.")


class CaseList(BaseModel):
    items: list[CaseListItem]
    total: int = Field(description="Total de expedientes que coinciden con la búsqueda.")
    offset: int
    limit: int


# --- Evidencias, archivo y análisis -------------------------------------------

class ArchivedObject(BaseModel):
    id: str = Field(description="Identificador del artefacto (sirve para descargarlo).")
    kind: str = Field(description="`original`, `working`, `manifest`, `report`, `pdf` o `plate` (mapa de calor).")
    sha256: str
    size_bytes: int


class ArchiveReceipt(BaseModel):
    case_id: str
    evidence_id: str
    report_id: Optional[str] = None
    objects: list[ArchivedObject] = Field(description="Objetos cifrados y sellados en el almacén.")
    retention_verified: bool = Field(description="Todos los objetos quedaron bajo retención inmutable.")


class IngestReceipt(ArchiveReceipt):
    sha256_original: str = Field(description="Huella del archivo recibido.")
    sha256_working_copy: str = Field(description="Huella de la copia de trabajo; debe coincidir con la del original.")
    status: Literal["PRESERVED_AND_VERIFIED"]


class AnalysisResult(BaseModel):
    """Resultado del análisis. Los campos principales son estables; puede incluir otros de diagnóstico."""
    model_config = ConfigDict(extra="allow")
    prediction: Prediction
    verdict_forensic: Verdict
    confidence: Optional[float] = Field(None, description="Confianza del veredicto entre 0 y 1.")
    caveat: Optional[str] = Field(None, description="Advertencia para el perito cuando el resultado requiere revisión humana.")
    report_id: str
    frames_analyzed: Optional[int] = None
    faces_detected: Optional[int] = None
    processing_time_seconds: Optional[float] = None
    models: Optional[dict[str, Any]] = Field(None, description="Puntuación de cada detector (GAN, face swap, difusión, escena).")
    decisive_models: Optional[list[str]] = Field(None, description="Detectores que deciden el veredicto en video; el resto es orientativo.")
    suspicious_seconds: Optional[list[dict[str, Any]]] = Field(None, description="Segundos del video con señal de manipulación (`second`, `score`).")
    explanation: Optional[dict[str, Any]] = Field(None, description="Mapas de calor (referencias a láminas selladas).")
    archive: Optional[ArchiveReceipt] = None


class JobProgress(BaseModel):
    stage: str = Field(description="`queued`, `verification`, `extracting`, `inference`, `scene`, `heatmaps`, `archive` o `completed`.")
    message: str = Field(examples=["Fotograma 12/48 · 3.5 s · rostro detectado · face swap 4.1%"])
    current: Optional[int] = None
    total: Optional[int] = None
    events: Optional[list[dict[str, Any]]] = Field(None, description="Últimos eventos del trabajo (`id`, `message`, `timestamp`).")


class JobQueued(BaseModel):
    status: Literal["queued"]
    job_id: str = Field(description="Se consulta en `GET /api/v1/jobs/{job_id}`.")
    case_id: str
    evidence_id: str
    poll_after_ms: int = Field(description="Espera recomendada antes de consultar el estado.", examples=[2000])
    mode: Literal["worker", "local"] = Field(description="`worker` si lo ejecuta Celery; `local` si lo ejecuta la propia API.")
    archive: Optional[ArchiveReceipt] = Field(None, description="Solo en `POST /predict`: recibo de la evidencia preservada.")


class JobStatus(BaseModel):
    status: Literal["queued", "processing", "completed", "failed"]
    job_id: str
    poll_after_ms: Optional[int] = Field(None, description="Presente mientras el trabajo sigue en curso.")
    progress: Optional[JobProgress] = None
    result: Optional[AnalysisResult] = Field(None, description="Presente cuando `status` es `completed`.")
    detail: Optional[str] = Field(None, description="Motivo del fallo cuando `status` es `failed`.")


class EvidenceItem(BaseModel):
    id: str
    file_name: str
    sha256: str
    size_bytes: int
    uploaded_at: str


class ArtifactItem(BaseModel):
    id: str
    evidence_id: str
    report_id: Optional[str] = None
    kind: str
    sha256: str
    size_bytes: int
    created_at: str


class Heatmap(BaseModel):
    image: str = Field(description="Imagen JPEG en `data:` URI.")
    second: Optional[float] = Field(None, description="Segundo del video (solo en videos).")
    signal: Optional[float] = Field(None, description="Intensidad de la señal de manipulación en ese fotograma.")


class ReportSummary(BaseModel):
    id: str
    verdict: Verdict
    confidence: Optional[float] = None
    prediction: Optional[Prediction] = None
    processing_time_seconds: Optional[float] = None
    frames_analyzed: Optional[int] = None
    faces_detected: Optional[int] = None
    created_at: str
    completed_at: Optional[str] = None
    expert_conclusions: Optional[str] = None
    pdf_artifact_id: Optional[str] = Field(None, description="Artefacto del PDF más reciente, para descargarlo.")
    heatmaps: list[Heatmap]
    artifact_issue: Optional[str] = Field(None, description="Aviso si el almacén no respondió; los datos salen entonces de PostgreSQL.")
    models: Optional[dict[str, Any]] = None


class EvidenceSummary(BaseModel):
    id: str
    file_name: str
    mime_type: str
    sha256: str
    size_bytes: int
    uploaded_at: str
    report: Optional[ReportSummary] = Field(None, description="Último análisis completado; `null` si aún no se analizó.")


class AuditEntry(BaseModel):
    action: str = Field(examples=["EVIDENCE_PRESERVED_AND_VERIFIED"])
    timestamp: str
    actor: str
    hash_verified: bool


class CaseSummary(BaseModel):
    id: str
    case_number: str
    title: str
    created_at: str
    evidences: list[EvidenceSummary]
    audit: list[AuditEntry] = Field(description="Cadena de custodia en orden cronológico.")


class CustodyEvent(BaseModel):
    id: int
    action: str
    hash_verified: bool
    details: dict[str, Any]
    timestamp: str
