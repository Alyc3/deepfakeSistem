"""Pasarela acotada al contrato OpenAPI de auth-service 1.1.0."""
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, Response, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field

from app.api_docs import AUTH_ERRORS, errors
from app.identity import active_profile, bearer_token, identity_request, require_identity, security
from app.access_policy import enforce_permission
from app.validators import (Email, Identifier, LastName, OptionalEmail, OptionalPassword, OptionalUserRole, Password,
                            PersonName, Phone, RoleDescription, RoleName, UserRole)
from app.schemas import LoginResponse

router = APIRouter(prefix="/api/v1")
USERS = ["Usuarios y roles"]
MANAGEMENT_ERRORS = errors(*AUTH_ERRORS, 502)
UserStatus = Literal["ACTIVO", "INACTIVO", "SUSPENDIDO", "PENDIENTE"]
# Una cuenta nueva nace activa o pendiente; inactivar y suspender son acciones sobre cuentas existentes.
NewUserStatus = Literal["ACTIVO", "PENDIENTE"]


class LoginInput(BaseModel):
    email: Email = Field(description="Correo de la cuenta.", examples=["perito@dominio.com"])
    password: Password = Field(description="Contraseña de la cuenta.")


class RoleInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: RoleName = Field(description="Nombre del rol: letra inicial y luego letras sin tildes, números, `-` o `_`.", examples=["PERITO_SENIOR"])
    description: RoleDescription = Field(None, description="Descripción del rol (hasta 500 caracteres).")


class UserInput(LoginInput):
    model_config = ConfigDict(extra="forbid")
    role_name: UserRole = Field(description="Rol asignado (debe existir en el auth-service).", examples=["PERITO"])
    first_name: PersonName = None
    last_name: LastName = None
    identifier: Identifier = Field(None, description="Cédula (10 dígitos) o RUC (13).")
    phone_number: Phone = Field(None, examples=["+593 99 999 9999"])
    status: NewUserStatus = Field("ACTIVO", description="Una cuenta nueva nace `ACTIVO` o `PENDIENTE`.")


class UserUpdate(BaseModel):
    """Solo se reenvían los campos enviados; si se envían, deben tener formato válido."""
    model_config = ConfigDict(extra="forbid")
    email: OptionalEmail = None
    password: OptionalPassword = None
    role_name: OptionalUserRole = None
    identifier: Identifier = None
    phone_number: Phone = None
    status: UserStatus | None = None


@router.post("/auth/login", tags=["Autenticación"], summary="Iniciar sesión",
             responses={200: {"model": LoginResponse, "description": "Sesión iniciada."}, **errors(401, 403, 422, 429, 502, 503)})
async def login(data: LoginInput, response: Response):
    """Envía las credenciales al auth-service y devuelve el token de acceso junto con el perfil.
    Rechaza las cuentas que no estén `ACTIVO`. La respuesta nunca se guarda en caché."""
    response.headers["Cache-Control"] = "no-store"
    result = await identity_request("POST", "/api/auth/login", body=data.model_dump())
    if not isinstance(result, dict) or not result.get("access_token") or str(result.get("token_type", "")).lower() != "bearer":
        raise HTTPException(502, "El servicio no devolvió una sesión válida.")
    user = await active_profile(result["access_token"])
    return {"access_token": result["access_token"], "token_type": "bearer", "user": user}


@router.get("/auth/me", tags=["Autenticación"], summary="Cuenta de la sesión actual",
            responses={200: {"description": "Perfil tal como lo devuelve el auth-service (`id`, `email`, `role`, `status`…)."},
                       **errors(*AUTH_ERRORS, 502)})
async def me(response: Response, user: dict = Depends(require_identity)):
    """Devuelve la cuenta asociada al token, validada en ese momento contra el auth-service."""
    response.headers["Cache-Control"] = "no-store"
    return user


async def management_token(request: Request, auth: HTTPAuthorizationCredentials | None = Security(security)) -> str:
    token = bearer_token(auth)
    user = await active_profile(token)
    enforce_permission(user, "roles" if "/roles" in request.url.path else "users")
    # El servicio central también aplica sus reglas en cada operación.
    return token


@router.get("/users", tags=USERS, summary="Listar usuarios", responses={200: {"description": "Lista de cuentas del auth-service."}, **MANAGEMENT_ERRORS})
async def users(token: str = Depends(management_token)):
    """Lista las cuentas registradas. Requiere el permiso `users`."""
    return await identity_request("GET", "/api/users/", token)


@router.post("/users", status_code=201, tags=USERS, summary="Crear usuario",
             responses={201: {"description": "Cuenta creada."}, **errors(*AUTH_ERRORS, 400, 422, 502)})
async def create_user(data: UserInput, token: str = Depends(management_token)):
    """Registra una cuenta nueva con su rol. Requiere el permiso `users`. Devuelve `400` si el correo ya existe."""
    return await identity_request("POST", "/api/auth/register", token, data.model_dump())


@router.patch("/users/{user_id}", tags=USERS, summary="Actualizar usuario",
              responses={200: {"description": "Cuenta actualizada."}, **errors(*AUTH_ERRORS, 400, 404, 422, 502)})
async def update_user(user_id: str, data: UserUpdate, token: str = Depends(management_token)):
    """Cambia solo los campos enviados: correo, contraseña, rol, identificación, teléfono o estado
    (`ACTIVO`, `INACTIVO`, `SUSPENDIDO`, `PENDIENTE`). Requiere el permiso `users`."""
    return await identity_request("PATCH", f"/api/users/{quote(user_id, safe='')}", token, data.model_dump(exclude_unset=True))


@router.get("/roles", tags=USERS, summary="Listar roles", responses={200: {"description": "Lista de roles."}, **MANAGEMENT_ERRORS})
async def roles(token: str = Depends(management_token)):
    """Lista los roles disponibles. Requiere el permiso `roles`."""
    return await identity_request("GET", "/api/roles/", token)


@router.post("/roles", status_code=201, tags=USERS, summary="Crear rol",
             responses={201: {"description": "Rol creado."}, **errors(*AUTH_ERRORS, 400, 422, 502)})
async def create_role(data: RoleInput, token: str = Depends(management_token)):
    """Crea un rol. Sus permisos en CertiFace se asignan en `ROLE_PERMISSIONS`. Requiere el permiso `roles`."""
    return await identity_request("POST", "/api/roles/", token, data.model_dump())


@router.put("/roles/{role_id}", tags=USERS, summary="Actualizar rol",
            responses={200: {"description": "Rol actualizado."}, **errors(*AUTH_ERRORS, 400, 404, 422, 502)})
async def update_role(role_id: str, data: RoleInput, token: str = Depends(management_token)):
    """Cambia el nombre y la descripción de un rol. Requiere el permiso `roles`."""
    return await identity_request("PUT", f"/api/roles/{quote(role_id, safe='')}", token, data.model_dump())


@router.delete("/roles/{role_id}", status_code=204, tags=USERS, summary="Eliminar rol",
               responses={204: {"description": "Rol eliminado."}, **errors(*AUTH_ERRORS, 400, 404, 502)})
async def delete_role(role_id: str, token: str = Depends(management_token)):
    """Elimina un rol del auth-service. Requiere el permiso `roles`."""
    await identity_request("DELETE", f"/api/roles/{quote(role_id, safe='')}", token)
    return Response(status_code=204)
