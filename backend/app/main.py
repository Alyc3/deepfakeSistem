import logging
import time

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

from app.model import predict_image, predict_video
from app.preprocessing import extract_frames

logger = logging.getLogger("certiface.api")

app = FastAPI(title="CertiFace API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_headers=["*"],
    allow_methods=["*"],
)


@app.get("/")
def health_check():
    return {"status": "ok"}


@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    contents = await file.read()
    started = time.perf_counter()
    logger.info(
        "Petición /predict: %s (%s, %d bytes)",
        file.filename, file.content_type, len(contents),
    )

    if file.content_type and file.content_type.startswith("video/"):
        frames = extract_frames(contents)
        if not frames:
            # Antes esto acababa en un ZeroDivisionError (HTTP 500) sin pista
            # alguna; ahora la causa llega al cliente y queda en el log.
            raise HTTPException(
                status_code=422,
                detail=(
                    "No se pudo decodificar ningún fotograma del video. "
                    "Códec o contenedor no soportado por OpenCV; "
                    "prueba a recodificarlo como MP4 (H.264)."
                ),
            )
        result = predict_video(frames)
    else:
        result = predict_image(contents)

    logger.info(
        "Respuesta /predict en %.2f s: %s",
        time.perf_counter() - started, result,
    )
    return result
