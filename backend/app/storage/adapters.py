import base64
import hashlib
import os
from pathlib import Path
from urllib.parse import urlsplit

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.storage.config import StorageConfig, validate_key
from app.storage.ports import IntegrityError, StorageError, WriteConflict


class S3ObjectStore:
    def __init__(self, config: StorageConfig, client=None):
        self.config = config
        self.client = client or boto3.client("s3", endpoint_url=config.endpoint, region_name=config.region,
            aws_access_key_id=config.access_key, aws_secret_access_key=config.secret_key,
            config=Config(signature_version="s3v4", connect_timeout=10, read_timeout=60,
                          retries={"mode": "standard", "max_attempts": 2}, s3={"addressing_style": "path"},
                          request_checksum_calculation="when_required", response_checksum_validation="when_required"))

    def check(self):
        try:
            self.client.head_bucket(Bucket=self.config.bucket)
        except (BotoCoreError, ClientError):
            raise StorageError("No se pudo acceder al bucket privado configurado") from None

    def put_once(self, key: str, data: bytes) -> str:
        validate_key(key, self.config.prefix)
        if len(data) > self.config.max_object + 4096:
            raise StorageError("Objeto demasiado grande")
        try:
            self.client.put_object(Bucket=self.config.bucket, Key=key, Body=data, IfNoneMatch="*",
                ContentType="application/octet-stream", CacheControl="no-store",
                ContentMD5=base64.b64encode(hashlib.md5(data, usedforsecurity=False).digest()).decode("ascii"),
                Metadata={"cipher-sha256": hashlib.sha256(data).hexdigest(), "format": "certiface-encrypted-v1"})
        except ClientError as error:
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") in (409, 412):
                raise WriteConflict("La referencia ya existe y no puede sobrescribirse") from None
            raise StorageError("El almacén rechazó la preservación del objeto") from None
        except BotoCoreError:
            raise StorageError("No se pudo confirmar la preservación del objeto") from None
        uri = f"s3://{self.config.bucket}/{key}"
        _, persisted = self.read(uri)
        if not hashlib.sha256(persisted).digest() == hashlib.sha256(data).digest():
            raise IntegrityError("El objeto recuperado no coincide con el enviado")
        return uri

    def read(self, uri: str) -> tuple[str, bytes]:
        parsed = urlsplit(uri)
        if parsed.scheme != "s3" or parsed.netloc != self.config.bucket or parsed.query or parsed.fragment:
            raise IntegrityError("Referencia ajena al almacén autorizado")
        key = validate_key(parsed.path.lstrip("/"), self.config.prefix)
        body = None
        try:
            response = self.client.get_object(Bucket=self.config.bucket, Key=key)
            if response.get("ContentLength", 0) > self.config.max_object + 4096:
                raise IntegrityError("Objeto fuera de los límites del almacén")
            body = response["Body"]
            data = body.read(self.config.max_object + 4097)
            if len(data) > self.config.max_object + 4096:
                raise IntegrityError("Objeto fuera de los límites del almacén")
            return key, data
        except (BotoCoreError, ClientError):
            raise StorageError("No se pudo recuperar el objeto preservado") from None
        finally:
            if body is not None:
                body.close()


class LocalObjectStore:
    """Solo desarrollo. O_EXCL evita sobrescrituras, pero no sustituye WORM."""
    def __init__(self, config: StorageConfig):
        self.config = config

    def path(self, key: str) -> Path:
        validate_key(key, self.config.prefix)
        target = self.config.root.joinpath(*key.split("/"))
        resolved = target.resolve()
        if not resolved.is_relative_to(self.config.root) or any(p.is_symlink() for p in [target, *target.parents] if p.is_relative_to(self.config.root)):
            raise IntegrityError("Ruta local no permitida")
        if os.name == "nt" and not str(resolved).startswith("\\\\?\\"):
            return Path("\\\\?\\" + str(resolved))
        return resolved

    def check(self):
        self.config.root.mkdir(parents=True, exist_ok=True, mode=0o700)

    def put_once(self, key: str, data: bytes) -> str:
        target = self.path(key)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            raise WriteConflict("El objeto local ya existe") from None
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(target, 0o400)
        return f"local://{key}"

    def read(self, uri: str) -> tuple[str, bytes]:
        if not uri.startswith("local://"):
            raise IntegrityError("Referencia local inválida")
        key = uri[len("local://"):]
        try:
            with self.path(key).open("rb") as handle:
                data = handle.read(self.config.max_object + 4097)
        except OSError:
            raise StorageError("No se pudo recuperar el objeto local preservado") from None
        if len(data) > self.config.max_object + 4096:
            raise IntegrityError("Objeto demasiado grande")
        return key, data
