"""Genera claves una sola vez. Nunca imprime secretos ni reemplaza claves existentes."""
import base64
import json
import os
import secrets
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from dotenv import dotenv_values

from app.storage.config import BACKEND, private_path
from app.storage.sealing import public_id


def exclusive_write(path: Path, data: bytes, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def setup():
    path = BACKEND / ".env"
    existing = dotenv_values(path)
    key_path = private_path(existing.get("FORENSIC_SIGNING_KEY_PATH") or "./.secrets/manifest-signing.pem")
    crypto_variables = ["FORENSIC_ENCRYPTION_KEYS", "FORENSIC_ACTIVE_ENCRYPTION_KEY_ID", "FORENSIC_SIGNING_KEY_PASSWORD"]
    if key_path.exists():
        if not all(existing.get(name) for name in crypto_variables):
            raise RuntimeError("Ya existe una clave. Restaura su entorno: no se regenerará automáticamente")
        print("Claves existentes conservadas; no se modificaron")
        return
    if any(existing.get(name) for name in crypto_variables):
        raise RuntimeError("Entorno criptográfico parcial: revisa y restaura las claves antes de continuar")
    key_id = secrets.token_hex(8)
    encryption_key = base64.b64encode(os.urandom(32)).decode("ascii")
    password = secrets.token_urlsafe(48)
    signing = Ed25519PrivateKey.generate()
    private_pem = signing.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.BestAvailableEncryption(password.encode("utf-8")))
    exclusive_write(key_path, private_pem)
    public_directory = private_path(existing.get("FORENSIC_PUBLIC_KEYS_PATH") or "./keys")
    public_path = public_directory / f"{public_id(signing.public_key())}.pub.pem"
    exclusive_write(public_path, signing.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo), 0o644)
    additions = {
        "FORENSIC_ENCRYPTION_KEYS": "'" + json.dumps({key_id: encryption_key}, separators=(",", ":")) + "'",
        "FORENSIC_ACTIVE_ENCRYPTION_KEY_ID": key_id,
        "FORENSIC_SIGNING_KEY_PASSWORD": password,
        "FORENSIC_PUBLIC_KEYS_PATH": "./keys",
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write("\n# Material criptográfico privado generado localmente\n")
        for name, value in additions.items():
            handle.write(f"{name}={value}\n")
    print("Cifrado AES-256-GCM y firma Ed25519 preparados; respalda el .env y la clave privada de forma separada")
    print("Identificador público de firma:", public_id(signing.public_key()))


if __name__ == "__main__":
    setup()
