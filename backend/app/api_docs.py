"""Textos de la documentación pública de la API (ReDoc en `/docs`).

La descripción general, los grupos de endpoints y las respuestas de error
comunes viven aquí para que las rutas solo declaren lo propio de cada una.
"""
from typing import Any

from app.schemas import ErrorResponse, ValidationErrorResponse

API_DESCRIPTION = """
API del motor forense de **CertiFace**: recibe imágenes y videos, los preserva
con cadena de custodia (ISO/IEC 27037), detecta manipulaciones con cuatro
modelos de visión y emite un dictamen pericial firmado en PDF.

## Acceso y permisos

Las rutas protegidas exigen la cabecera `Authorization: Bearer <token>`. El
token lo emite el **auth-service** central (inicio de sesión en
`POST /api/v1/auth/login`). En cada solicitud la API valida el token contra ese
servicio y comprueba que la cuenta esté `ACTIVO`.

Los permisos dependen del rol (`ROLE_PERMISSIONS`):

| Permiso | Da acceso a |
|---|---|
| `laboratory` | Expedientes, evidencias, análisis, informes y archivo forense |
| `users` | Gestión de usuarios |
| `roles` | Gestión de roles |

## Flujo típico de un análisis

1. `POST /api/v1/cases` crea el expediente.
2. `POST /api/v1/cases/{case_id}/ingest` sube la evidencia. El servidor guarda
   el original y una copia de trabajo cifrados y devuelve sus huellas SHA-256.
3. `POST /api/v1/cases/{case_id}/analyze-async` encola el análisis y devuelve un `job_id`.
4. `GET /api/v1/jobs/{job_id}` se consulta cada `poll_after_ms` milisegundos
   hasta que el estado sea `completed` o `failed`.
5. `POST /api/v1/cases/{case_id}/reports/{report_id}/finalize` añade las
   conclusiones del perito y emite la versión definitiva del informe PDF.
6. `GET /api/v1/cases/{case_id}/summary` muestra el expediente completo y
   `.../artifacts/{artifact_id}/download` descarga el PDF u otros objetos.

## Veredictos

| `prediction` | `verdict_forensic` | Significado |
|---|---|---|
| `Fake` | `MANIPULADO` | Hay evidencia suficiente de manipulación |
| `Real` | `SIN_MANIPULACION` | Ningún detector decisivo encontró indicios |
| `Suspect` | `ANTECEDENTES` | Señales ambiguas: requiere revisión humana (ver `caveat`) |

## Errores

Todas las respuestas de error tienen la forma `{"detail": "mensaje en español"}`,
listo para mostrarse al usuario. Los errores de validación (`422`) añaden
`errors` con cada motivo por separado.

## Límites

- Formatos admitidos: JPEG, PNG, WebP, BMP, GIF, MP4, MOV, AVI, MKV y WebM.
- Tamaño máximo por evidencia: `FORENSIC_MAX_UPLOAD_BYTES` (10 MB por defecto).
"""

TAGS: list[dict[str, Any]] = [
    {"name": "Estado del servicio",
     "description": "Comprobaciones de salud para balanceadores, monitoreo y el pipeline de despliegue."},
    {"name": "Autenticación",
     "description": "Inicio de sesión y perfil de la cuenta. Las credenciales se validan en el auth-service central."},
    {"name": "Usuarios y roles",
     "description": "Pasarela hacia el auth-service para administrar cuentas y roles. "
                    "Requiere los permisos `users` o `roles`."},
    {"name": "Expedientes",
     "description": "Casos forenses del perito autenticado. Cada perito solo ve sus propios expedientes."},
    {"name": "Evidencias y análisis",
     "description": "Ingesta con cadena de custodia y análisis de imágenes o videos con los modelos de detección."},
    {"name": "Trabajos de análisis",
     "description": "Seguimiento de los análisis asíncronos: estado, progreso por etapas y resultado."},
    {"name": "Archivo forense",
     "description": "Objetos cifrados y sellados del expediente, informes PDF y bitácora de custodia."},
]

_ERRORS = {
    400: "Solicitud incompleta: falta un dato obligatorio.",
    401: "Falta el token o la sesión expiró.",
    403: "La cuenta no está activa o su rol no tiene el permiso necesario.",
    404: "El recurso no existe o pertenece a otro perito.",
    409: "Conflicto: el registro ya existe o la integridad (SHA-256) no coincide.",
    413: "La evidencia supera el tamaño máximo permitido.",
    415: "Formato de archivo no admitido.",
    422: "Los datos no cumplen el formato esperado.",
    429: "Demasiados intentos; espera antes de reintentar.",
    502: "El auth-service devolvió una respuesta no válida.",
    503: "Un servicio dependiente (PostgreSQL, almacén, broker o auth-service) no está disponible.",
}


def errors(*codes: int) -> dict[int | str, dict[str, Any]]:
    """Respuestas de error documentadas para `responses=` de una ruta."""
    return {code: {"model": ValidationErrorResponse if code == 422 else ErrorResponse, "description": _ERRORS[code]}
            for code in codes}


# Errores que puede devolver cualquier ruta protegida.
AUTH_ERRORS = (401, 403, 503)
