import logging
import os
from datetime import datetime
from typing import Any, Dict, Optional

import httpx
from fastapi import Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.database import get_db
from app.models_db import CustodyAuditLog, Perito

logger = logging.getLogger("certiface.auth")

AUTH_SERVICE_URL = os.environ["AUTH_SERVICE_URL"]
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "")

security = HTTPBearer(auto_error=False)

from app.identity import active_profile, bearer_token, require_identity
from starlette.concurrency import run_in_threadpool


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
    is_active = user_data.get("status") == "ACTIVO"

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
        perito.email = email
        perito.last_synced_at = datetime.utcnow()
        perito.first_name = first_name
        perito.last_name = last_name
        perito.identifier = identifier
        perito.role_name = role_name
        perito.phone_number = phone
        perito.is_active = is_active
        db.commit()
        db.refresh(perito)

    return perito


async def get_current_perito(user_data: dict = Depends(require_identity), db: Session = Depends(get_db)) -> Perito:
    return await run_in_threadpool(sync_perito_in_db, user_data, db)


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
    def persist_local():
        db.add(audit_entry)
        db.commit()
        db.refresh(audit_entry)
        return db.query(Perito).filter(Perito.id == perito_id).first()

    perito = await run_in_threadpool(persist_local)
    if INTERNAL_API_KEY and perito:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    f"{AUTH_SERVICE_URL}/api/internal/audit",
                    headers={"X-Internal-Api-Key": INTERNAL_API_KEY},
                    json={
                        "user_id": perito.external_auth_id,
                        "action": action,
                        "endpoint": (details or {}).get("endpoint"),
                        "ip_address": ip_address,
                    },
                )
                response.raise_for_status()
            audit_entry.synced_to_central_audit = True
            await run_in_threadpool(db.commit)
        except httpx.HTTPError:
            logger.warning("No se pudo sincronizar el evento de auditoría central.")
    return audit_entry
