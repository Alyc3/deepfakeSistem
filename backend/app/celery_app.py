"""Configuración única de Celery para trabajos de inferencia."""
import os

from celery import Celery


broker_url = os.getenv("CELERY_BROKER_URL", "redis://127.0.0.1:6379/0")
result_backend = os.getenv("CELERY_RESULT_BACKEND", broker_url)

celery_app = Celery("certiface", broker=broker_url, backend=result_backend,
                    include=["app.tasks"])
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    task_track_started=True,
    result_expires=int(os.getenv("CELERY_RESULT_EXPIRES", "86400")),
    broker_connection_retry_on_startup=True,
    worker_prefetch_multiplier=1,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    timezone="UTC",
)
