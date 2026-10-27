from dataclasses import dataclass
from typing import Protocol


class StorageError(Exception):
    pass


class IntegrityError(StorageError):
    pass


class WriteConflict(StorageError):
    pass


class RetentionNotVerified(StorageError):
    pass


@dataclass(frozen=True)
class Artifact:
    kind: str
    uri: str
    sha256: str
    size: int
    content_type: str


class ObjectStore(Protocol):
    """No ofrece métodos de borrado ni actualización."""
    def put_once(self, key: str, data: bytes) -> str: ...
    def read(self, uri: str) -> tuple[str, bytes]: ...
    def check(self) -> None: ...
