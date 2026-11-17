#!/usr/bin/env bash
# Prepara la VM de Oracle Cloud y levanta CertiFace con HTTPS.
#
# Uso, en la VM y dentro de la carpeta del backend:
#   bash deploy/oracle/setup.sh                 # dominio gratuito <ip>.sslip.io
#   DOMAIN=api.midominio.com bash deploy/oracle/setup.sh   # dominio propio
#
# Es idempotente: volver a ejecutarlo actualiza la imagen con el código copiado.
set -euo pipefail
cd "$(dirname "$0")/../.."          # → backend/

say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- 0. Comprobaciones previas ------------------------------------------------
[[ -f .env ]] || fail "Falta backend/.env (cópialo desde tu PC junto con el código)."
[[ -f .secrets/manifest-signing.pem ]] || fail "Falta backend/.secrets/manifest-signing.pem (clave privada de firma)."
[[ -f Dockerfile ]] || fail "Ejecuta el script desde la carpeta del backend."

mem_gb=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo)
if (( mem_gb < 6 )); then
  fail "La VM tiene ${mem_gb} GB de RAM y los modelos necesitan ~5 GB. Usa la forma VM.Standard.A1.Flex (gratis hasta 4 OCPU y 24 GB)."
fi
say "VM: $(nproc) CPU, ${mem_gb} GB de RAM, $(uname -m)"

# --- 1. Docker ---------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Instalando Docker"
  . /etc/os-release
  if [[ "${ID}" == "ol" || "${ID_LIKE:-}" == *rhel* ]]; then
    sudo dnf install -y dnf-utils
    sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    curl -fsSL https://get.docker.com | sudo sh
  fi
  sudo systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || sudo docker compose version >/dev/null 2>&1 || fail "Falta el plugin docker compose."

# --- 2. Cortafuegos del sistema operativo (además de la Security List de OCI) --
say "Abriendo los puertos 80 y 443 en el cortafuegos de la VM"
if command -v firewall-cmd >/dev/null 2>&1; then
  sudo firewall-cmd --permanent --add-service=http --add-service=https
  sudo firewall-cmd --reload
else
  for port in 80 443; do
    sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null \
      || sudo iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
  done
  if ! command -v netfilter-persistent >/dev/null 2>&1; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
  fi
  sudo netfilter-persistent save
fi

# --- 3. Dominio para HTTPS -----------------------------------------------------
if [[ -z "${DOMAIN:-}" ]]; then
  ip=$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me)
  [[ "$ip" =~ ^[0-9.]+$ ]] || fail "No se pudo averiguar la IP pública. Ejecuta: DOMAIN=<tu-dominio> bash deploy/oracle/setup.sh"
  DOMAIN="${ip//./-}.sslip.io"
fi
printf 'DOMAIN=%s\nTHREADS=%s\n' "$DOMAIN" "$(nproc)" > deploy/oracle/.env
say "Dominio: https://${DOMAIN}"

# --- 4. Clave de firma: legible solo por el usuario del contenedor (UID 1000) --
sudo chown -R 1000:1000 .secrets
sudo chmod 700 .secrets
sudo chmod 600 .secrets/manifest-signing.pem

# --- 5. Construir y arrancar -----------------------------------------------------
say "Construyendo la imagen (la primera vez descarga ~2.6 GB de modelos: 15-30 min)"
sudo docker compose -f deploy/oracle/docker-compose.yml up -d --build

say "Esperando a que la API cargue los modelos (1-3 min)"
for _ in $(seq 1 60); do
  if sudo docker compose -f deploy/oracle/docker-compose.yml exec -T api \
       python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/live', timeout=5)" >/dev/null 2>&1; then
    say "Listo. API pública: https://${DOMAIN}"
    echo "    Comprueba:  curl https://${DOMAIN}/health/live"
    echo "    Logs:       sudo docker compose -f deploy/oracle/docker-compose.yml logs -f api"
    exit 0
  fi
  sleep 5
done
fail "La API no respondió en 5 min. Revisa: sudo docker compose -f deploy/oracle/docker-compose.yml logs api"
