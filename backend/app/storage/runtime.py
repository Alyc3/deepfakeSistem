import os
import tempfile

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

from app.storage.config import private_path


def configure_private_temp():
    """Los temporales de multipart/OpenCV son copias de trabajo, nunca originales."""
    directory = private_path(os.getenv("FORENSIC_TEMP_PATH", "./.runtime-tmp"))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.environ["TMP"] = os.environ["TEMP"] = str(directory)
    tempfile.tempdir = str(directory)


class UploadSizeLimit:
    def __init__(self, app, max_bytes: int):
        self.app, self.max_bytes = app, max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") not in ("POST", "PUT", "PATCH"):
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        try:
            declared = int(headers.get(b"content-length", b"0"))
        except ValueError:
            declared = self.max_bytes + 1
        if declared > self.max_bytes or declared < 0:
            return await JSONResponse({"detail": "Solicitud demasiado grande"}, status_code=413)(scope, receive, send)
        consumed = 0

        async def bounded_receive():
            nonlocal consumed
            message = await receive()
            consumed += len(message.get("body", b""))
            if consumed > self.max_bytes:
                raise HTTPException(413, "Solicitud demasiado grande")
            return message

        return await self.app(scope, bounded_receive, send)
