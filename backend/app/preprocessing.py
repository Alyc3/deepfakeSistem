import logging
import os
import tempfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

logger = logging.getLogger("certiface.preprocessing")

# Detector de rostros YuNet (DNN). OpenCV 5 eliminó el clásico
# CascadeClassifier, así que la detección usa este modelo ONNX, que además es
# bastante más robusto con poses y tamaños variados. La ruta es relativa a
# este archivo para no depender del directorio de trabajo.
_YUNET_PATH = Path(__file__).resolve().parent.parent / "models" / "Detector_Facial_YuNet.onnx"
_detector = cv2.FaceDetectorYN.create(
    str(_YUNET_PATH), "", (320, 320), score_threshold=0.6
)


def crop_largest_face(pil_image: Image.Image, margin: float = 0.35):
    """Recorta el rostro más grande de la imagen, con margen alrededor.

    El modelo fue entrenado con rostros alineados que ocupan todo el encuadre;
    pasarle un fotograma completo (rostro pequeño + fondo) rompe esa
    distribución y sesga el veredicto. Devuelve (imagen, rostro_encontrado):
    si no se detecta ningún rostro se devuelve la imagen completa como último
    recurso, dejando constancia en el log.
    """
    frame = np.array(pil_image)
    bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
    height, width = bgr.shape[:2]

    _detector.setInputSize((width, height))
    _, faces = _detector.detect(bgr)
    if faces is None or len(faces) == 0:
        return pil_image, False

    x, y, w, h = faces[int(np.argmax(faces[:, 2] * faces[:, 3]))][:4]
    mx, my = w * margin, h * margin
    x0, y0 = max(int(x - mx), 0), max(int(y - my), 0)
    x1 = min(int(x + w + mx), width)
    y1 = min(int(y + h + my), height)
    if x1 <= x0 or y1 <= y0:
        return pil_image, False
    return pil_image.crop((x0, y0, x1, y1)), True


def extract_frames(video_bytes: bytes, max_frames: int = 24):
    """Extrae hasta max_frames fotogramas repartidos a lo largo del video.

    Usa un archivo temporal con nombre único (dos peticiones simultáneas ya
    no se pisan) y lo elimina siempre, incluso si la decodificación falla.
    Devuelve una lista de tuplas (imagen PIL en RGB, segundo del video o
    None si no hay fps); vacía si OpenCV no pudo abrir o decodificar el
    video. Se muestrean 24 fotogramas porque los artefactos de face swap son
    intermitentes: cuantos más puntos de la línea de tiempo, más ocasiones
    de sorprenderlos.
    """
    fd, tmp_path = tempfile.mkstemp(suffix=".mp4", prefix="certiface_")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(video_bytes)

        cap = cv2.VideoCapture(tmp_path)
        if not cap.isOpened():
            logger.error(
                "OpenCV no pudo abrir el video (%d bytes). "
                "Posible códec o contenedor no soportado.",
                len(video_bytes),
            )
            return []

        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        logger.info(
            "Video abierto: %d bytes, %dx%d, %.1f fps, %d fotogramas declarados",
            len(video_bytes), width, height, fps, total,
        )

        step = max(total // max_frames, 1)
        frames = []
        count = 0
        while len(frames) < max_frames:
            ret, frame = cap.read()
            if not ret:
                break
            if count % step == 0:
                timestamp = round(count / fps, 1) if fps > 0 else None
                frames.append(
                    (Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)), timestamp)
                )
            count += 1
        cap.release()

        if not frames:
            logger.error(
                "El video se abrió pero no se pudo decodificar ningún fotograma "
                "(leídos %d). Códec de video probablemente no soportado.", count,
            )
        else:
            logger.info(
                "Extraídos %d fotogramas (paso de muestreo %d, leídos %d)",
                len(frames), step, count,
            )
        return frames
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
