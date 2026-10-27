import base64
import hashlib
import json
import os
import struct
from pathlib import Path

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.storage.config import private_path
from app.storage.ports import IntegrityError, StorageError

MAGIC = b"CFENC1\x00"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def public_id(key: Ed25519PublicKey) -> str:
    return sha256(key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))


class Sealer:
    def __init__(self, keys: dict[str, bytes], active_key: str, signing_key: Ed25519PrivateKey, public_keys: dict[str, Ed25519PublicKey]):
        if active_key not in keys or any(len(key) != 32 for key in keys.values()):
            raise StorageError("El cifrado forense requiere claves AES de 256 bits")
        self.keys, self.active_key, self.signing_key = keys, active_key, signing_key
        self.signing_id = public_id(signing_key.public_key())
        self.public_keys = {**public_keys, self.signing_id: signing_key.public_key()}

    @classmethod
    def from_env(cls):
        try:
            keys = {name: base64.b64decode(value, validate=True) for name, value in json.loads(os.environ["FORENSIC_ENCRYPTION_KEYS"]).items()}
            key_path = private_path(os.environ["FORENSIC_SIGNING_KEY_PATH"])
            private_key = serialization.load_pem_private_key(key_path.read_bytes(), password=os.environ["FORENSIC_SIGNING_KEY_PASSWORD"].encode("utf-8"))
            if not isinstance(private_key, Ed25519PrivateKey):
                raise ValueError()
            trusted = {}
            for path in private_path(os.getenv("FORENSIC_PUBLIC_KEYS_PATH", "./keys")).glob("*.pub.pem"):
                key = serialization.load_pem_public_key(path.read_bytes())
                if isinstance(key, Ed25519PublicKey):
                    trusted[public_id(key)] = key
            return cls(keys, os.environ["FORENSIC_ACTIVE_ENCRYPTION_KEY_ID"], private_key, trusted)
        except (KeyError, ValueError, OSError, TypeError):
            raise StorageError("No se pudieron cargar las claves forenses privadas") from None

    def encrypt(self, data: bytes, object_key: str) -> bytes:
        nonce = os.urandom(12)
        header = canonical_json({"schema": 1, "key_id": self.active_key, "nonce": base64.b64encode(nonce).decode("ascii"), "sha256": sha256(data)})
        envelope = MAGIC + struct.pack("!H", len(header)) + header
        aad = envelope + b"\x00" + object_key.encode("ascii")
        return envelope + AESGCM(self.keys[self.active_key]).encrypt(nonce, data, aad)

    def decrypt(self, encrypted: bytes, object_key: str, expected_hash: str) -> bytes:
        try:
            if not encrypted.startswith(MAGIC):
                raise ValueError()
            start = len(MAGIC) + 2
            length = struct.unpack("!H", encrypted[len(MAGIC):start])[0]
            if length > 2048:
                raise ValueError()
            header = json.loads(encrypted[start:start + length])
            key = self.keys[header["key_id"]]
            if header["schema"] != 1 or header["sha256"] != expected_hash:
                raise ValueError()
            data = AESGCM(key).decrypt(base64.b64decode(header["nonce"], validate=True), encrypted[start + length:], encrypted[:start + length] + b"\x00" + object_key.encode("ascii"))
            if sha256(data) != expected_hash:
                raise ValueError()
            return data
        except (ValueError, KeyError, TypeError, InvalidTag, struct.error, UnicodeError):
            raise IntegrityError("No se pudo verificar la integridad criptográfica del objeto") from None

    def sign_manifest(self, payload: dict) -> bytes:
        data = canonical_json(payload)
        return canonical_json({"schema": "certiface-manifest-v1", "algorithm": "Ed25519", "key_id": self.signing_id,
            "payload_b64": base64.b64encode(data).decode("ascii"),
            "signature_b64": base64.b64encode(self.signing_key.sign(data)).decode("ascii")})

    def verify_manifest(self, manifest: bytes) -> dict:
        try:
            envelope = json.loads(manifest)
            if envelope["schema"] != "certiface-manifest-v1" or envelope["algorithm"] != "Ed25519":
                raise ValueError()
            payload = base64.b64decode(envelope["payload_b64"], validate=True)
            self.public_keys[envelope["key_id"]].verify(base64.b64decode(envelope["signature_b64"], validate=True), payload)
            result = json.loads(payload)
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (ValueError, KeyError, TypeError, InvalidSignature):
            raise IntegrityError("La firma del manifiesto no es válida o su clave no es de confianza") from None
