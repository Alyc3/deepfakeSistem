"""Pasarela acotada al contrato OpenAPI de auth-service 1.1.0."""
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request, Response, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict

from app.identity import active_profile, bearer_token, identity_request, require_identity, security
from app.access_policy import enforce_permission
from app.validators import (Email, Identifier, LastName, OptionalEmail, OptionalPassword, OptionalUserRole, Password,
                            PersonName, Phone, RoleDescription, RoleName, UserRole)

router = APIRouter(prefix="/api/v1", tags=["Usuarios y roles"])
UserStatus = Literal["ACTIVO", "INACTIVO", "SUSPENDIDO", "PENDIENTE"]
# Una cuenta nueva nace activa o pendiente; inactivar y suspender son acciones sobre cuentas existentes.
NewUserStatus = Literal["ACTIVO", "PENDIENTE"]


class LoginInput(BaseModel):
    email: Email
    password: Password


class RoleInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: RoleName
    description: RoleDescription = None


class UserInput(LoginInput):
    model_config = ConfigDict(extra="forbid")
    role_name: UserRole
    first_name: PersonName = None
    last_name: LastName = None
    identifier: Identifier = None
    phone_number: Phone = None
    status: NewUserStatus = "ACTIVO"


class UserUpdate(BaseModel):
    """Solo se reenvían los campos enviados; si se envían, deben tener formato válido."""
    model_config = ConfigDict(extra="forbid")
    email: OptionalEmail = None
    password: OptionalPassword = None
    role_name: OptionalUserRole = None
    identifier: Identifier = None
    phone_number: Phone = None
    status: UserStatus | None = None


@router.post("/auth/login")
async def login(data: LoginInput, response: Response):
    response.headers["Cache-Control"] = "no-store"
    result = await identity_request("POST", "/api/auth/login", body=data.model_dump())
    from fastapi import HTTPException
    if not isinstance(result, dict) or not result.get("access_token") or str(result.get("token_type", "")).lower() != "bearer":
        raise HTTPException(502, "El servicio no devolvió una sesión válida.")
    user = await active_profile(result["access_token"])
    return {"access_token": result["access_token"], "token_type": "bearer", "user": user}


@router.get("/auth/me")
async def me(response: Response, user: dict = Depends(require_identity)):
    response.headers["Cache-Control"] = "no-store"
    return user


async def management_token(request: Request, auth: HTTPAuthorizationCredentials | None = Security(security)) -> str:
    token = bearer_token(auth)
    user = await active_profile(token)
    enforce_permission(user, "roles" if "/roles" in request.url.path else "users")
    # El servicio central también aplica sus reglas en cada operación.
    return token


@router.get("/users")
async def users(token: str = Depends(management_token)):
    return await identity_request("GET", "/api/users/", token)


@router.post("/users", status_code=201)
async def create_user(data: UserInput, token: str = Depends(management_token)):
    return await identity_request("POST", "/api/auth/register", token, data.model_dump())


@router.patch("/users/{user_id}")
async def update_user(user_id: str, data: UserUpdate, token: str = Depends(management_token)):
    return await identity_request("PATCH", f"/api/users/{quote(user_id, safe='')}", token, data.model_dump(exclude_unset=True))


@router.get("/roles")
async def roles(token: str = Depends(management_token)):
    return await identity_request("GET", "/api/roles/", token)


@router.post("/roles", status_code=201)
async def create_role(data: RoleInput, token: str = Depends(management_token)):
    return await identity_request("POST", "/api/roles/", token, data.model_dump())


@router.put("/roles/{role_id}")
async def update_role(role_id: str, data: RoleInput, token: str = Depends(management_token)):
    return await identity_request("PUT", f"/api/roles/{quote(role_id, safe='')}", token, data.model_dump())


@router.delete("/roles/{role_id}", status_code=204)
async def delete_role(role_id: str, token: str = Depends(management_token)):
    await identity_request("DELETE", f"/api/roles/{quote(role_id, safe='')}", token)
    return Response(status_code=204)
