"""Casos de preservación: originales, copias y reportes cifrados y sellados."""
import base64
import copy
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from functools import lru_cache

from app.storage.adapters import LocalObjectStore, S3ObjectStore
from app.storage.config import StorageConfig
from app.storage.ports import Artifact, IntegrityError, ObjectStore, StorageError
from app.storage.retention import RetentionGuard
from app.storage.sealing import Sealer, canonical_json, sha256

ForensicIntegrityError = IntegrityError
calculate_sha256 = sha256


def identifier(value) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise StorageError("Identificador forense inválido") from None


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class PreservedBundle:
    artifacts: tuple[Artifact, ...]
    manifest: Artifact
    signing_key_id: str
    retention: dict


class ForensicStorage:
    def __init__(self, config: StorageConfig, store: ObjectStore, sealer: Sealer, retention=None):
        self.config, self.store, self.sealer = config, store, sealer
        self.retention = retention or RetentionGuard(config)

    def _write(self, kind: str, key: str, data: bytes, content_type: str) -> Artifact:
        if len(data) > self.config.max_object:
            raise StorageError("Objeto demasiado grande para el almacén")
        digest = sha256(data)
        uri = self.store.put_once(key, self.sealer.encrypt(data, key))
        artifact = Artifact(kind, uri, digest, len(data), content_type)
        self.read(artifact)  # verificación desde los bytes realmente persistidos
        return artifact

    def read(self, artifact: Artifact) -> bytes:
        key, encrypted = self.store.read(artifact.uri)
        data = self.sealer.decrypt(encrypted, key, artifact.sha256)
        if len(data) != artifact.size:
            raise IntegrityError("El tamaño de la evidencia no coincide")
        return data

    def _seal(self, root: str, artifacts: list[Artifact], context: dict, retention: dict) -> PreservedBundle:
        payload = {"schema": "certiface-custody-v1", "created_at": now(), **context,
                   "retention": retention, "artifacts": [asdict(artifact) for artifact in artifacts]}
        signed = self.sealer.sign_manifest(payload)
        manifest = self._write("manifest", f"{root}/manifests/seal.json.enc", signed, "application/json")
        self.sealer.verify_manifest(self.read(manifest))
        return PreservedBundle(tuple(artifacts), manifest, self.sealer.signing_id, retention)

    def verify(self, artifact: Artifact, manifest: Artifact, case_id: str, evidence_id: str, owner_id: str, report_id: str | None = None) -> dict:
        payload = self.sealer.verify_manifest(self.read(manifest))
        expected = {"case_id": identifier(case_id), "evidence_id": identifier(evidence_id), "owner_id": str(owner_id)}
        if report_id is not None:
            expected["report_id"] = identifier(report_id)
        if any(payload.get(key) != value for key, value in expected.items()):
            raise IntegrityError("El manifiesto no corresponde al expediente y propietario")
        if artifact != manifest and asdict(artifact) not in payload.get("artifacts", []):
            raise IntegrityError("El objeto no forma parte del manifiesto firmado")
        return payload

    def ingest(self, data: bytes, file_name: str, content_type: str, case_id: str, evidence_id: str, owner_id: str, actor_id: str) -> PreservedBundle:
        if not data or len(data) > self.config.max_upload:
            raise StorageError("El archivo está vacío o supera el límite de ingesta")
        retention = self.retention.check()  # antes de cualquier escritura
        case_id, evidence_id = identifier(case_id), identifier(evidence_id)
        root = f"{self.config.prefix}/cases/{case_id}/evidence/{evidence_id}"
        digest = sha256(data)
        original = self._write("original", f"{root}/original/evidence.bin.enc", data, content_type)
        recovered = self.read(original)
        working = self._write("working", f"{root}/working/copy.bin.enc", recovered, content_type)
        if original.sha256 != working.sha256:
            raise IntegrityError("La copia de trabajo no coincide con el original")
        return self._seal(root, [original, working], {"event": "EVIDENCE_PRESERVED", "case_id": case_id,
            "evidence_id": evidence_id, "owner_id": str(owner_id), "actor_id": str(actor_id),
            "received_filename": str(file_name)[:255]}, retention)

    def archive_report(self, result: dict, case_id: str, evidence_id: str, report_id: str, owner_id: str, actor_id: str,
                       evidence_manifest: Artifact, evidence_original: Artifact, provenance: dict, previous: dict | None = None) -> PreservedBundle:
        retention = self.retention.check()
        case_id, evidence_id, report_id = identifier(case_id), identifier(evidence_id), identifier(report_id)
        self.verify(evidence_original, evidence_manifest, case_id, evidence_id, owner_id)
        revision_id = str(uuid.uuid4())
        root = f"{self.config.prefix}/cases/{case_id}/evidence/{evidence_id}/reports/{report_id}/{revision_id}"
        archived = copy.deepcopy(result)
        artifacts = []
        explanation = archived.get("explanation")
        if isinstance(explanation, dict):
            images = [explanation, *explanation.get("frames", [])]
            for index, item in enumerate(images):
                value = item.pop("image", None)
                if value is None:
                    continue
                if not isinstance(value, str) or not value.startswith("data:image/jpeg;base64,"):
                    raise IntegrityError("Formato inesperado de lámina explicativa")
                try:
                    image = base64.b64decode(value.split(",", 1)[1], validate=True)
                except ValueError:
                    raise IntegrityError("Lámina explicativa inválida") from None
                if not image.startswith(b"\xff\xd8\xff"):
                    raise IntegrityError("La lámina no es un JPEG")
                plate = self._write("plate", f"{root}/plates/{index:03d}.jpg.enc", image, "image/jpeg")
                item["artifact"] = asdict(plate)
                artifacts.append(plate)
        document = {"schema": "certiface-report-v1", "report_id": report_id, "revision_id": revision_id,
            "case_id": case_id, "evidence_id": evidence_id, "owner_id": str(owner_id), "actor_id": str(actor_id),
            "created_at": now(), "original_sha256": evidence_original.sha256, "evidence_manifest": asdict(evidence_manifest),
            "provenance": provenance, "previous_revision": previous, "result": archived}
        encoded = canonical_json(document)
        report = self._write("report", f"{root}/report.json.enc", encoded, "application/json")
        artifacts.append(report)
        return self._seal(root, artifacts, {"event": "REPORT_ARCHIVED", "case_id": case_id, "evidence_id": evidence_id,
            "report_id": report_id, "revision_id": revision_id, "owner_id": str(owner_id), "actor_id": str(actor_id),
            "original_sha256": evidence_original.sha256, "evidence_manifest": asdict(evidence_manifest), "previous_revision": previous}, retention)


@lru_cache(maxsize=1)
def get_storage() -> ForensicStorage:
    config = StorageConfig.from_env()
    store = LocalObjectStore(config) if config.local else S3ObjectStore(config)
    return ForensicStorage(config, store, Sealer.from_env())
