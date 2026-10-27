"""Política de acceso configurable; los roles desconocidos no heredan privilegios."""
import json
import os
import unicodedata
from pathlib import Path

from dotenv import load_dotenv
from fastapi import HTTPException

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def normalize_role(value: str) -> str:
    plain = "".join(c for c in unicodedata.normalize("NFD", value) if not unicodedata.combining(c))
    return "_".join(plain.strip().upper().replace("-", " ").split())


def permissions_for(role: str) -> list[str]:
    policy = json.loads(os.getenv("ROLE_PERMISSIONS", "{}"))
    return next((permissions for name, permissions in policy.items() if normalize_role(name) == normalize_role(role)), json.loads(os.getenv("DEFAULT_PERMISSIONS", "[]")))


def enforce_permission(user: dict, permission: str) -> None:
    if permission not in permissions_for((user.get("role") or {}).get("name", "")):
        raise HTTPException(403, "Tu rol no tiene acceso a esta sección.")
