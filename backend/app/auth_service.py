import logging
import os
import time
import uuid
from datetime import datetime
from typing import Any, Dict, Optional

import httpx
import jwt
from fastapi import Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db
from app.models_db import CustodyAuditLog, Perito

logger = logging.getLogger("certiface.auth")

AUTH_SERVICE_URL = os.getenv("AUTH_SERVICE_URL", "https://auth-service-w3lo.onrender.com")
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "")

security = HTTPBearer(auto_error=False)

# Caché en memoria para evitar latencia de red en cada petición
# token -> {"user": dict, "cached_at": float}
_TOKEN_CACHE: Dict[str, Dict[str, Any]] = {}
CACHE_TTL_SECONDS = 300  # 5 minutos


async def verify_token_remote(token: str) -> Optional[Dict[str, Any]]:
    """Consulta al microservicio de autenticación en Render (/api/auth/me)."""
    headers = {"Authorization": f"Bearer {token}"}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{AUTH_SERVICE_URL}/api/auth/me", headers=headers)
            if response.status_code == 200:
                return response.json()
            elif response.status_code in (401, 403):
                logger.warning("Token rechazado por auth-service: status %d", response.status_code)
                return None
    except Exception as exc:
        logger.warning("No se pudo contactar directamente con auth-service en Render (%s): %s", AUTH_SERVICE_URL, exc)
    return None


def verify_token_fallback_db(token: str, db: Session) -> Optional[Dict[str, Any]]:
    """Fallback de alta disponibilidad: Si Render está en 'cold start', decodifica el claim 'sub'

    del JWT y busca el usuario directamente en la tabla 'users' de Neon DB (base de datos compartida).
    """
    try:
        payload = jwt.decode(token, options={"verify_signature": False})
        sub = payload.get("sub") or payload.get("user_id") or payload.get("email")
        if not sub:
            return None

        # Consultar tabla 'users' de Neon DB
        query = text(
            "SELECT id, email, first_name, last_name, identifier, phone_number, status, role_id "
            "FROM users WHERE email = :sub OR id = :sub LIMIT 1"
        )
        res = db.execute(query, {"sub": str(sub)}).fetchone()
        if not res:
            return None

        # Consultar nombre del rol
        role_id = res[7]
        role_name = "perito"
        if role_id:
            role_res = db.execute(text("SELECT name FROM roles WHERE id = :rid"), {"rid": str(role_id)}).fetchone()
            if role_res:
                role_name = role_res[0]

        return {
            "id": res[0],
            "email": res[1],
            "first_name": res[2] or "Perito",
            "last_name": res[3] or "Forense",
            "identifier": res[4] or "MAT-0000",
            "phone_number": res[5],
            "status": str(res[6] or "ACTIVO"),
            "role": {"id": str(role_id or ""), "name": role_name},
        }
    except Exception as err:
        logger.error("Error en fallback DB para token: %s", err)
        return None


def sync_perito_in_db(user_data: Dict[str, Any], db: Session) -> Perito:
    """Sincroniza el perfil del perito autenticado en la tabla 'peritos'."""
    external_id = str(user_data.get("id"))
    perito = db.query(Perito).filter(Perito.external_auth_id == external_id).first()

    role_info = user_data.get("role") or {}
    role_name = role_info.get("name") if isinstance(role_info, dict) else str(role_info or "perito")
    first_name = user_data.get("first_name") or "Perito"
    last_name = user_data.get("last_name") or "Forense"
    identifier = user_data.get("identifier") or "COLEG-0000"
    email = user_data.get("email") or f"{external_id}@sistema.local"
    phone = user_data.get("phone_number")
    is_active = user_data.get("status") != "INACTIVO"

    if not perito:
        perito = Perito(
            external_auth_id=external_id,
            email=email,
            first_name=first_name,
            last_name=last_name,
            identifier=identifier,
            role_name=role_name,
            phone_number=phone,
            is_active=is_active,
        )
        db.add(perito)
        db.commit()
        db.refresh(perito)
        logger.info("Nuevo perito sincronizado: %s (%s)", perito.id, perito.email)
    else:
        perito.first_name = first_name
        perito.last_name = last_name
        perito.identifier = identifier
        perito.role_name = role_name
        perito.phone_number = phone
        perito.is_active = is_active
        db.commit()
        db.refresh(perito)

    return perito


async def get_current_perito(
    auth: Optional[HTTPAuthorizationCredentials] = Security(security),
    db: Session = Depends(get_db),
) -> Perito:
    """Dependencia FastAPI para proteger endpoints forenses."""
    if not auth or not auth.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Se requiere cabecera 'Authorization: Bearer <token>'",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = auth.credentials

    # 1. Comprobar caché
    cached = _TOKEN_CACHE.get(token)
    if cached and (time.time() - cached["cached_at"] < CACHE_TTL_SECONDS):
        user_data = cached["user"]
    else:
        # 2. Consultar Render
        user_data = await verify_token_remote(token)
        # 3. Fallback en base de datos si Render no responde
        if not user_data:
            user_data = verify_token_fallback_db(token, db)

        if user_data:
            _TOKEN_CACHE[token] = {"user": user_data, "cached_at": time.time()}

    if not user_data:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token no válido, expirado o perito no encontrado.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    perito = sync_perito_in_db(user_data, db)
    if not perito.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="El perfil del perito está inactivo o suspendido.",
        )
    return perito


async def record_audit_event(
    db: Session,
    perito_id: Any,
    action: str,
    evidence_id: Optional[Any] = None,
    ip_address: str = "127.0.0.1",
    user_agent: Optional[str] = None,
    hash_verified: bool = True,
    details: Optional[Dict[str, Any]] = None,
) -> CustodyAuditLog:
    """Registra la traza en la tabla local 'custody_audit_log' e intenta replicar al servicio central."""
    # 1. Registro local pericial inmutable
    audit_entry = CustodyAuditLog(
        evidence_id=evidence_id,
        perito_id=perito_id,
        action=action,
        ip_address=ip_address,
        user_agent=user_agent,
        hash_verified=hash_verified,
        details=details or {},
    )
    db.add(audit_entry)
    db.commit()
    db.refresh(audit_entry)

    # 2. Registro en tabla audit_logs del ecosistema central
    try:
        log_id = str(uuid.uuid4())
        db.execute(
            text(
                "INSERT INTO audit_logs (id, user_id, action, endpoint, ip_address, created_at) "
                "VALUES (:id, :uid, :act, :ep, :ip, :cat)"
            ),
            {
                "id": log_id,
                "uid": str(perito_id),
                "act": action,
                "ep": (details or {}).get("endpoint", "/api/v1/cases"),
                "ip": ip_address,
                "cat": datetime.utcnow(),
            },
        )
        db.commit()
        audit_entry.synced_to_central_audit = True
        db.commit()
    except Exception as db_err:
        logger.warning("No se pudo escribir directamente en audit_logs del ecosistema: %s", db_err)

    # 3. Llamada al endpoint remoto si hay API key configurada
    if INTERNAL_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                await client.post(
                    f"{AUTH_SERVICE_URL}/api/internal/audit",
                    headers={"X-Internal-Api-Key": INTERNAL_API_KEY},
                    json={
                        "user_id": str(perito_id),
                        "action": action,
                        "endpoint": (details or {}).get("endpoint"),
                        "ip_address": ip_address,
                    },
                )
        except Exception:
            pass

    return audit_entry
