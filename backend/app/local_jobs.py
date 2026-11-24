"""Inferencia dentro del proceso de la API, sin worker ni Redis.

La API ya tiene los modelos cargados, así que puede analizar por sí misma: un
único hilo de fondo ejecuta los trabajos de uno en uno y guarda su avance en
memoria, con la misma forma que publica Celery. La web no nota la diferencia:
encola, consulta el progreso y recibe el resultado igual.

`INFERENCE_MODE` decide quién analiza:

- `auto` (por defecto): el worker de Celery si hay uno conectado; si no, la API.
- `local`: siempre la API. No hace falta Redis ni worker.
- `worker`: siempre Celery (despliegues con worker dedicado).

Límite del modo local: el avance vive en la memoria de este proceso. Si la API
se reinicia a mitad de un análisis, ese trabajo se da por interrumpido y hay
que volver a lanzarlo; la evidencia preservada no se ve afectada.
"""
from __future__ import annotations

import logging
import os
import queue
import socket
import threading
import time
from collections import OrderedDict
from typing import Callable
from urllib.parse import urlsplit

from app.celery_app import broker_url, celery_app

logger = logging.getLogger("certiface.local_jobs")

KEEP_FINISHED = 8            # resultados terminados que se conservan (llevan los mapas de calor)
WORKER_BUSY_GRACE = 30 * 60  # un worker ocupado no responde al ping: se le espera este tiempo
BROKER_CHECK_TTL = 5.0

_jobs: "OrderedDict[str, dict]" = OrderedDict()
_dispatched: dict[str, float] = {}
_pending: "queue.Queue[tuple[str, Callable]]" = queue.Queue()
_lock = threading.Lock()
_thread: threading.Thread | None = None
_broker_check: tuple[float, bool] = (0.0, False)


def inference_mode() -> str:
    mode = os.getenv("INFERENCE_MODE", "auto").strip().lower()
    return mode if mode in ("auto", "local", "worker") else "auto"


def broker_reachable(timeout: float = 1.5) -> bool:
    """¿Acepta conexiones el Redis del broker? Comprobación de red rápida, con caché breve."""
    global _broker_check
    checked_at, reachable = _broker_check
    if time.monotonic() - checked_at < BROKER_CHECK_TTL:
        return reachable
    url = urlsplit(broker_url)
    try:
        with socket.create_connection((url.hostname or "127.0.0.1", url.port or 6379), timeout=timeout):
            reachable = True
    except OSError:
        reachable = False
    _broker_check = (time.monotonic(), reachable)
    return reachable


def worker_responds(timeout: float = 1.0) -> bool:
    """¿Hay algún worker de Celery atendiendo ahora mismo?"""
    if not broker_reachable():
        return False
    try:
        return bool(celery_app.control.ping(timeout=timeout, limit=1))
    except Exception:
        return False


def note_dispatched(job_id: str) -> None:
    """Anota un trabajo entregado al worker (ver `recently_dispatched`)."""
    with _lock:
        _dispatched[job_id] = time.monotonic()


def recently_dispatched() -> list[str]:
    """Trabajos entregados hace poco al worker.

    Un worker con `--pool=solo` no contesta al ping mientras analiza. Si alguno de
    estos trabajos sigue sin terminar, el worker está ocupado, no ausente, y el
    siguiente análisis debe esperar su turno en la cola en vez de correr aquí.
    """
    limit = time.monotonic() - WORKER_BUSY_GRACE
    with _lock:
        for job_id in [key for key, sent in _dispatched.items() if sent < limit]:
            del _dispatched[job_id]
        return list(_dispatched)


def _trim() -> None:
    finished = [key for key, entry in _jobs.items() if entry["state"] in ("COMPLETED", "FAILED")]
    for key in finished[:-KEEP_FINISHED] if len(finished) > KEEP_FINISHED else []:
        del _jobs[key]


def _worker_loop() -> None:
    while True:
        job_id, run = _pending.get()
        with _lock:
            entry = _jobs.get(job_id)
            if entry is None:
                continue
            entry["state"] = "PROCESSING"

        def report(meta: dict, entry=entry) -> None:
            entry["progress"] = meta

        try:
            result = run(report)
        except Exception:
            # run_analysis_job ya registró el fallo y marcó el trabajo en PostgreSQL.
            logger.warning("Análisis local fallido job_id=%s", job_id)
            outcome = {"state": "FAILED", "result": None}
        else:
            outcome = {"state": "COMPLETED", "result": result}
        with _lock:
            entry.update(outcome)
            _trim()


def submit(job_id: str, run: Callable[[Callable[[dict], None]], dict]) -> None:
    """Encola `run(report_progress)` para ejecutarlo en el hilo de inferencia de esta API."""
    global _thread
    with _lock:
        waiting = _pending.qsize() + sum(entry["state"] == "PROCESSING" for entry in _jobs.values())
        message = "En espera: hay otro análisis en curso." if waiting else "El análisis comenzará en un momento."
        _jobs[job_id] = {"state": "QUEUED", "result": None, "progress": {"stage": "queued", "message": message}}
        if _thread is None or not _thread.is_alive():
            # Hilo demonio: no impide detener o recargar el servidor.
            _thread = threading.Thread(target=_worker_loop, name="certiface-inference", daemon=True)
            _thread.start()
    _pending.put((job_id, run))
    logger.info("Análisis %s en modo local (dentro de la API, sin worker)", job_id)


def status(job_id: str) -> dict | None:
    """Estado de un trabajo local: {"state", "progress", "result"}; None si esta API no lo conoce."""
    with _lock:
        entry = _jobs.get(job_id)
        return dict(entry) if entry else None
