"""Cliente del servicio de identidad. Nunca acepta un JWT sin validación remota."""
import os
from typing import Any

import httpx
from fastapi import Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from app.access_policy import enforce_permission

AUTH_SERVICE_URL = os.environ["AUTH_SERVICE_URL"].rstrip("/")
security = HTTPBearer(auto_error=False)


async def identity_request(method: str, path: str, token: str | None = None, body: Any = None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.request(method, f"{AUTH_SERVICE_URL}{path}", headers=headers, json=body)
    except httpx.RequestError:
        raise HTTPException(503, "El servicio de usuarios no está disponible. Intenta de nuevo.")
    if response.status_code >= 400:
        # No propagar cuerpos arbitrarios del proveedor ni datos de credenciales.
        messages = {
            400: "La operación contiene datos inválidos o un registro duplicado.",
            401: "Credenciales incorrectas o sesión expirada.",
            403: "No tienes permisos para realizar esta operación.",
            404: "Usuario o rol no encontrado.",
            422: "Revisa los campos: no cumplen el formato del servicio.",
            429: "Demasiadas solicitudes. Intenta de nuevo más tarde.",
        }
        code = response.status_code if response.status_code in messages else 502
        raise HTTPException(code, messages.get(code, "El servicio de usuarios devolvió un error."))
    if response.status_code == 204:
        return None
    try:
        return response.json()
    except ValueError:
        raise HTTPException(502, "Respuesta inválida del servicio de usuarios.")


def bearer_token(auth: HTTPAuthorizationCredentials | None) -> str:
    if not auth or auth.scheme.lower() != "bearer" or not auth.credentials:
        raise HTTPException(401, "Debes iniciar sesión.", headers={"WWW-Authenticate": "Bearer"})
    return auth.credentials


async def active_profile(token: str) -> dict:
    user = await identity_request("GET", "/api/auth/me", token)
    if not isinstance(user, dict) or not user.get("id") or not user.get("email") or not isinstance(user.get("role"), dict):
        raise HTTPException(502, "El perfil recibido no es válido.")
    if user.get("status") != "ACTIVO":
        raise HTTPException(403, "Tu cuenta no está activa. Contacta al administrador.")
    return user


async def require_identity(auth: HTTPAuthorizationCredentials | None = Security(security)) -> dict:
    return await active_profile(bearer_token(auth))


async def require_laboratory(user: dict = Depends(require_identity)) -> dict:
    enforce_permission(user, "laboratory")
    return user
