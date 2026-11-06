#!/usr/bin/env bash
# Build de CertiFace web en Render (servicio Node).
#   Root Directory:  web
#   Build Command:   bash render-build.sh
#   Start Command:   npm start
# Las variables de entorno se cargan en Render desde .env.production (Environment > Add from .env).
set -o errexit -o nounset -o pipefail

echo "Node $(node --version) · npm $(npm --version)"

# Las herramientas de compilación (TypeScript, astro check) son devDependencies: se instalan aunque
# NODE_ENV sea production. --prefer-offline aprovecha la caché de npm de Render entre despliegues.
npm ci --include=dev --prefer-offline --no-audit --no-fund

# NODE_ENV=production activa la cookie __Host- segura y las cabeceras HSTS del servidor.
NODE_ENV=production npm run build

# El servidor compilado solo necesita las dependencias de producción.
npm prune --omit=dev --no-audit --no-fund

echo "Build listo: dist/server/entry.mjs"
