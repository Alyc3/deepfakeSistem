"""Reglas de formato de los datos de entrada.

Espejo de `web/src/domain/validation.ts`: la web valida antes de enviar, pero
la API no confía en ningún cliente y aplica las mismas reglas con los mismos
mensajes. Cada tipo normaliza (espacios, mayúsculas…) y rechaza lo que no
corresponde: letras donde van números, números donde van letras, etc.
"""
import re
import unicodedata
from typing import Annotated, Callable, Optional

from pydantic import BeforeValidator

# Caracteres de control: nunca son contenido legítimo (salto de línea y tabulador sí).
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# [^\W\d_] equivale a "cualquier letra Unicode" (incluye tildes y ñ).
_NAME = re.compile(r"[^\W\d_]+(?:[ '’-][^\W\d_]+)*")
_LETTER = re.compile(r"[^\W\d_]")
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}")


def _squash(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", value).strip())


def _trim(value: str) -> str:
    return unicodedata.normalize("NFC", value).strip()


def _digits(value: str) -> int:
    return sum(char.isdigit() for char in value)


def rule(label: str, *, max_len: int, min_len: int = 0, required: bool = True,
         normalize: Optional[Callable[[str], str]] = None, check: Optional[Callable[[str], bool]] = None,
         hint: str = "formato no válido.") -> BeforeValidator:
    """Validador previo: normaliza, comprueba longitud y formato, y devuelve el valor limpio."""
    def validate(value):
        if value is None or (isinstance(value, str) and not value.strip()):
            if required:
                raise ValueError(f"{label}: es obligatorio.")
            return None
        if not isinstance(value, str):
            raise ValueError(f"{label}: formato no válido.")
        value = normalize(value) if normalize else value
        if _CONTROL.search(value):
            raise ValueError(f"{label}: contiene caracteres no permitidos.")
        if min_len and len(value) < min_len:
            raise ValueError(f"{label}: escribe al menos {min_len} caracteres.")
        if len(value) > max_len:
            raise ValueError(f"{label}: admite como máximo {max_len} caracteres.")
        if check and not check(value):
            raise ValueError(f"{label}: {hint}")
        return value
    return BeforeValidator(validate)


def email(required: bool = True) -> BeforeValidator:
    return rule("Correo electrónico", max_len=254, required=required, normalize=lambda v: v.strip().lower(),
                check=lambda v: bool(_EMAIL.fullmatch(v)), hint="Escribe un correo válido, por ejemplo nombre@dominio.com.")


def person_name(label: str = "Nombre") -> BeforeValidator:
    return rule(label, min_len=2, max_len=100, required=False, normalize=_squash,
                check=lambda v: bool(_NAME.fullmatch(v)), hint="Solo admite letras, espacios, apóstrofo o guion.")


def role_name(label: str = "Nombre del rol", required: bool = True) -> BeforeValidator:
    return rule(label, min_len=2, max_len=50, required=required, normalize=str.strip,
                check=lambda v: bool(re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]+", v)),
                hint="Empieza por una letra y solo admite letras sin tildes, números, guion o guion bajo. Ejemplo: PERITO_SENIOR.")


Email = Annotated[str, email()]
OptionalEmail = Annotated[Optional[str], email()]  # opcional al editar, pero si se envía no puede ir vacío
PersonName = Annotated[Optional[str], person_name()]
LastName = Annotated[Optional[str], person_name("Apellido")]
Identifier = Annotated[Optional[str], rule(
    "Identificación", max_len=13, required=False, normalize=str.strip,
    check=lambda v: bool(re.fullmatch(r"\d{10}|\d{13}", v)), hint="Solo admite números: 10 dígitos (cédula) o 13 (RUC).")]
Phone = Annotated[Optional[str], rule(
    "Teléfono", max_len=20, required=False, normalize=_squash,
    check=lambda v: bool(re.fullmatch(r"\+?[\d ()-]+", v)) and 7 <= _digits(v) <= 15,
    hint="Solo admite números (7 a 15), con + inicial opcional y espacios, guiones o paréntesis. Ejemplo: +593 99 999 9999.")]
RoleName = Annotated[str, role_name()]
UserRole = Annotated[str, role_name("Rol")]
OptionalUserRole = Annotated[Optional[str], role_name("Rol")]
RoleDescription = Annotated[Optional[str], rule("Descripción", max_len=500, required=False, normalize=_trim)]
Password = Annotated[str, rule("Contraseña", max_len=1024)]
OptionalPassword = Annotated[Optional[str], rule("Contraseña", max_len=1024, required=False)]

CaseNumber = Annotated[str, rule(
    "Número de caso", min_len=3, max_len=100, normalize=lambda v: v.strip().upper(),
    check=lambda v: bool(re.fullmatch(r"[A-Z0-9]+(?:[-/.][A-Z0-9]+)*", v)),
    hint="Solo admite letras sin tildes, números y los separadores - / . (sin espacios). Ejemplo: FGE-2026-0001.")]
CaseTitle = Annotated[str, rule(
    "Nombre del caso", min_len=3, max_len=255, normalize=_squash,
    check=lambda v: bool(_LETTER.search(v)), hint="Debe contener texto, no solo números o símbolos.")]
CaseDescription = Annotated[Optional[str], rule("Descripción", max_len=10000, required=False, normalize=_trim)]
Conclusions = Annotated[str, rule(
    "Conclusiones del perito", min_len=10, max_len=20000, normalize=_trim,
    check=lambda v: bool(_LETTER.search(v)), hint="Deben contener texto, no solo números o símbolos.")]


def sha256_or_none(value: Optional[str]) -> Optional[str]:
    """Huella SHA-256 declarada en un formulario multipart: 64 caracteres hexadecimales o nada."""
    if value is None or not value.strip():
        return None
    value = value.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        from fastapi import HTTPException
        raise HTTPException(422, "Hash SHA-256: son exactamente 64 caracteres hexadecimales (0-9 y a-f).")
    return value


def _validation_message(error: dict) -> str:
    """Mensaje legible en español para un error de validación de Pydantic."""
    field = str((error.get("loc") or ["campo"])[-1])
    kind = error.get("type", "")
    if kind == "value_error":
        return str(error.get("msg", "")).removeprefix("Value error, ")
    if kind == "missing":
        return f"{field}: es obligatorio."
    if kind == "extra_forbidden":
        return f"{field}: campo no permitido."
    if kind == "literal_error":
        return f"{field}: valor no permitido."
    return f"{field}: formato no válido."


def install_validation_handler(app) -> None:
    """Responde 422 con `detail` en texto (la web lo muestra tal cual) y la lista de motivos en `errors`."""
    from fastapi.exceptions import RequestValidationError
    from fastapi.responses import JSONResponse

    @app.exception_handler(RequestValidationError)
    async def request_validation_handler(request, error: RequestValidationError):
        messages = list(dict.fromkeys(_validation_message(item) for item in error.errors()))
        return JSONResponse({"detail": " · ".join(messages) or "Revisa los datos enviados.", "errors": messages},
                            status_code=422, headers={"Cache-Control": "no-store"})
