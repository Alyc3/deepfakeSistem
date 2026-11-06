#!/usr/bin/env bash
# Arranque del contenedor: Redis -> worker Celery -> API FastAPI.
# Si cualquiera de los tres procesos muere, el contenedor termina para que la
# plataforma lo reinicie (en vez de quedar una API sin worker).
set -euo pipefail
cd "$(dirname "$0")/.."

log() { echo "[start] $*"; }

# 1. Clave privada de firma de manifiestos, desde un secreto en base64.
#    (Las plataformas no admiten archivos secretos; el PEM viaja como texto.)
if [[ -n "${FORENSIC_SIGNING_KEY_PEM_B64:-}" ]]; then
  key_path="${FORENSIC_SIGNING_KEY_PATH}"
  mkdir -p "$(dirname "$key_path")"
  chmod 700 "$(dirname "$key_path")"
  (umask 077 && printf '%s' "$FORENSIC_SIGNING_KEY_PEM_B64" | base64 -d > "$key_path")
  log "Clave de firma escrita en $key_path"
elif [[ ! -f "${FORENSIC_SIGNING_KEY_PATH}" ]]; then
  log "ERROR: falta el secreto FORENSIC_SIGNING_KEY_PEM_B64 (clave privada de firma)."
  exit 1
fi

# 2. Diagnóstico de red hacia PostgreSQL (Hugging Face bloquea puertos
#    salientes distintos de 80/443/8080 en algunos Spaces).
python - <<'PY' || true
import os, socket
from sqlalchemy.engine import make_url
try:
    url = make_url(os.environ["DATABASE_URL"])
    host, port = url.host, url.port or 5432
    socket.create_connection((host, port), timeout=8).close()
    print(f"[start] PostgreSQL alcanzable en {host}:{port}")
except KeyError:
    print("[start] ERROR: falta el secreto DATABASE_URL")
except OSError as exc:
    print(f"[start] ADVERTENCIA: no se pudo abrir TCP a PostgreSQL ({exc}). "
          "Si estás en Hugging Face Spaces, el puerto puede estar bloqueado; "
          "ver docs/DESPLIEGUE_HUGGINGFACE.md, sección Problemas.")
PY

# 3. Redis local, solo en loopback y sin persistencia (los resultados de
#    Celery son efímeros; lo pericial vive en PostgreSQL y R2).
redis-server --bind 127.0.0.1 --port 6379 --save "" --appendonly no --dir /tmp &
for _ in $(seq 1 30); do
  redis-cli -h 127.0.0.1 ping >/dev/null 2>&1 && break
  sleep 0.5
done
log "Redis listo"

# 4. Worker Celery: un trabajo a la vez (pool solo) para no duplicar los
#    modelos en memoria con varios procesos hijos.
celery -A app.celery_app worker --pool=solo --loglevel=INFO &
log "Worker Celery iniciado"

# 5. API. --proxy-headers para registrar la IP real del cliente en la
#    cadena de custodia (la plataforma pone un proxy delante).
uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-7860}" \
  --proxy-headers --forwarded-allow-ips='*' &
log "API iniciando en el puerto ${PORT:-7860} (la carga de modelos tarda 1-3 min)"

trap 'kill 0' EXIT
wait -n
log "Un proceso terminó; deteniendo el contenedor"
exit 1
