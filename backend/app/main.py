import logging
import time
import os
import subprocess

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

# Descargar los pesos de los modelos si no existen (útil para la nube donde se ignoran por el .gitignore)
if not os.path.exists("models/Detector_De_Difusion_Facial/model.safetensors"):
    logging.info("Descargando modelos faltantes (esto puede tardar unos minutos en el primer arranque)...")
    subprocess.run(["python", "scripts/fetch_models.py"], check=True)

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

    # El mapa de calor va como data URI base64: se resume en el log para no
    # inundarlo.
    loggable = {k: v for k, v in result.items() if k != "explanation"}
    if "explanation" in result:
        exp = result["explanation"]
        strip = exp.get("frames") or []
        detail = f", {len(strip)} fotogramas ilustrados" if strip else ""
        loggable["explanation"] = (
            f"<mapa de calor {exp['width']}x{exp['height']}, "
            f"t={exp['second']}{detail}>"
        )
    logger.info(
        "Respuesta /predict en %.2f s: %s",
        time.perf_counter() - started, loggable,
    )
    return result
