# CertiFace backend — imagen única para Hugging Face Spaces (CPU) o cualquier VM.
#
# Un solo contenedor ejecuta Redis (broker local), el worker Celery y la API
# FastAPI. Los pesos de terceros se descargan y convierten DURANTE el build,
# así el contenedor arranca sin red hacia las fuentes de los modelos y un
# Space que despierta no vuelve a bajar 2.6 GB.

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# redis-server: broker/result backend de Celery dentro del contenedor.
# libglib2.0-0 / libgomp1: requeridas por OpenCV headless y PyTorch en CPU.
RUN apt-get update \
 && apt-get install -y --no-install-recommends redis-server libglib2.0-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces ejecuta el contenedor con el UID 1000.
RUN useradd --create-home --uid 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH
WORKDIR /home/user/app

# PyTorch solo-CPU (~5x más liviano que el wheel con CUDA). Se instala antes
# que requirements.txt para que pip dé por satisfecho "torch".
RUN pip install --user --index-url https://download.pytorch.org/whl/cpu torch torchvision
COPY --chown=user requirements.txt .
RUN pip install --user -r requirements.txt

# Pesos de terceros desde sus fuentes oficiales (scripts/fetch_models.py).
# Va ANTES de copiar el código: así un cambio en app/ no invalida esta capa
# ni vuelve a descargar 2.6 GB. Se borra la caché de Hugging Face en la misma
# capa: el checkpoint original de la sonda (~2.1 GB) solo sirve para convertir.
COPY --chown=user models ./models
COPY --chown=user scripts/fetch_models.py ./scripts/fetch_models.py
RUN python scripts/fetch_models.py \
 && rm -rf /home/user/.cache/huggingface \
 && find models -name ".cache" -type d -prune -exec rm -rf {} +

# Resto del código (los pesos ya descargados no se pisan: el contexto de
# build no los incluye, ver .dockerignore).
COPY --chown=user . .

RUN sed -i 's/\r$//' docker/start.sh && chmod +x docker/start.sh

# Valores por defecto no secretos; los del Space (Settings) los sobrescriben.
ENV PORT=7860 \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    USE_LOCAL_STORAGE=false \
    FORENSIC_SIGNING_KEY_PATH=./.secrets/manifest-signing.pem \
    FORENSIC_PUBLIC_KEYS_PATH=./keys \
    FORENSIC_TEMP_PATH=./.runtime-tmp \
    CELERY_BROKER_URL=redis://127.0.0.1:6379/0 \
    CELERY_RESULT_BACKEND=redis://127.0.0.1:6379/1

EXPOSE 7860
CMD ["./docker/start.sh"]
