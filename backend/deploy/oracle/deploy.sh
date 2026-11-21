#!/usr/bin/env bash
# Reconstruye y reinicia CertiFace con el código que ya está en la VM.
#
# Lo ejecuta GitHub Actions tras copiar el código (.github/workflows/backend.yml)
# y también setup.sh al final de la preparación inicial. A mano, desde backend/:
#   bash deploy/oracle/deploy.sh
#
# Solo se reconstruyen las capas que cambiaron: los modelos (~2.6 GB) quedan en
# caché mientras no cambien requirements.txt, models/ ni scripts/fetch_models.py.
set -euo pipefail
cd "$(dirname "$0")/../.."          # → backend/

compose=(sudo docker compose -f deploy/oracle/docker-compose.yml)
say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f .env ]] || fail "Falta backend/.env en la VM."
[[ -f .secrets/manifest-signing.pem ]] || fail "Falta backend/.secrets/manifest-signing.pem en la VM."
[[ -f deploy/oracle/.env ]] || fail "Falta deploy/oracle/.env: ejecuta primero deploy/oracle/setup.sh."

say "Construyendo la imagen"
"${compose[@]}" build api

say "Reiniciando los servicios"
"${compose[@]}" up -d --remove-orphans

say "Esperando a que la API cargue los modelos (1-3 min)"
for _ in $(seq 1 60); do
  if "${compose[@]}" exec -T api python -c \
       "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/live', timeout=5)" >/dev/null 2>&1; then
    # Imágenes anteriores sin etiqueta: liberan el disco de la VM.
    sudo docker image prune -f >/dev/null
    say "Despliegue completado: la API responde."
    exit 0
  fi
  sleep 5
done

"${compose[@]}" logs --tail 80 api
fail "La API no respondió en 5 minutos (arriba, los últimos logs)."
