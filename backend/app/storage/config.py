import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv
from app.storage.ports import IntegrityError

BACKEND = Path(__file__).resolve().parents[2]
load_dotenv(BACKEND / ".env")


def private_path(value: str) -> Path:
    path = Path(value)
    return (path if path.is_absolute() else BACKEND / path).resolve()


@dataclass(frozen=True)
class StorageConfig:
    local: bool
    root: Path
    prefix: str
    require_retention: bool
    endpoint: str
    bucket: str
    region: str
    access_key: str
    secret_key: str
    max_upload: int
    max_object: int

    @classmethod
    def from_env(cls):
        local = os.getenv("USE_LOCAL_STORAGE", "false").lower() == "true"
        prefix = os.getenv("FORENSIC_STORAGE_PREFIX", "certiface/v1").strip("/")
        if not re.fullmatch(r"[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*", prefix):
            raise ValueError("FORENSIC_STORAGE_PREFIX inválido")
        endpoint = os.getenv("S3_ENDPOINT_URL", "")
        parsed = urlsplit(endpoint)
        if not local and (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
            raise ValueError("S3_ENDPOINT_URL debe ser un origen HTTPS")
        bucket = os.getenv("S3_BUCKET_NAME", "")
        if not local and not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
            raise ValueError("S3_BUCKET_NAME inválido")
        if not local and (not os.getenv("S3_ACCESS_KEY") or not os.getenv("S3_SECRET_KEY")):
            raise ValueError("Faltan credenciales S3 privadas")
        return cls(local, private_path(os.getenv("LOCAL_STORAGE_PATH", "./uploads")), prefix,
                   os.getenv("FORENSIC_REQUIRE_RETENTION", "true").lower() == "true",
                   endpoint, bucket, os.getenv("S3_REGION", "auto"), os.getenv("S3_ACCESS_KEY", ""), os.getenv("S3_SECRET_KEY", ""),
                   int(os.getenv("FORENSIC_MAX_UPLOAD_BYTES", "10485760")), 64 * 1024 * 1024)


def validate_key(key: str, prefix: str) -> str:
    if not key.startswith(prefix + "/") or not re.fullmatch(r"[a-zA-Z0-9_./-]+", key) or any(part in ("", ".", "..") for part in key.split("/")):
        raise IntegrityError("Referencia de almacenamiento no permitida")
    return key
