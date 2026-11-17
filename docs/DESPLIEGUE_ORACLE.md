# Despliegue del backend en Oracle Cloud (Always Free)

Una VM `VM.Standard.A1.Flex` (ARM, gratis hasta 4 OCPU y 24 GB de RAM) con
Docker: la imagen de `backend/Dockerfile` (Redis + worker Celery + API) y Caddy
delante para servir HTTPS con certificado de Let's Encrypt.

Archivos: `backend/deploy/oracle/` (`pack.ps1`, `setup.sh`,
`docker-compose.yml`, `Caddyfile`).

## Requisitos de la VM

| | Mínimo |
|---|---|
| Forma | `VM.Standard.A1.Flex` con ≥ 2 OCPU y ≥ 12 GB (recomendado 4 OCPU / 24 GB). `VM.Standard.E2.1.Micro` (1 GB) **no sirve**: los modelos ocupan ~5 GB |
| Imagen | Ubuntu 22.04/24.04 (o Oracle Linux 8/9) |
| Disco | Volumen de arranque ≥ 50 GB (la imagen Docker ronda 10 GB) |

## 1. Abrir los puertos 80 y 443 en OCI

Instancia → **Networking** → la subred → **Security Lists** → la lista por
defecto → **Add Ingress Rules**, dos reglas:

| Source CIDR | IP Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

(El cortafuegos del sistema operativo lo abre `setup.sh`.)

## 2. Empaquetar y copiar el backend (en tu PC)

El repositorio de GitHub no tiene todo el backend (la línea `backend/*` de
`.gitignore` deja fuera archivos nuevos), así que se copia la carpeta local:

```powershell
cd C:\Users\<tu-usuario>\Desktop\projects\deepfakeSistem\backend
powershell -ExecutionPolicy Bypass -File deploy\oracle\pack.ps1
scp -i C:\ruta\a\tu-clave.key "$env:USERPROFILE\certiface-backend.tgz" ubuntu@<IP-PUBLICA>:~/
```

El paquete (~15 MB) lleva `.env` y la clave privada de firma: bórralo de tu PC
y de la VM cuando termines. Con Oracle Linux el usuario es `opc` en vez de
`ubuntu`.

## 3. Desplegar (en la VM)

```bash
ssh -i C:\ruta\a\tu-clave.key ubuntu@<IP-PUBLICA>
mkdir -p ~/certiface && tar -xzf ~/certiface-backend.tgz -C ~/certiface && rm ~/certiface-backend.tgz
cd ~/certiface
bash deploy/oracle/setup.sh
```

El script instala Docker, abre 80/443, construye la imagen (la primera vez
descarga ~2.6 GB de modelos: 15-30 min) y arranca. Termina mostrando la URL
pública, `https://<ip-con-guiones>.sslip.io`.

Comprobación: `curl https://<ip-con-guiones>.sslip.io/health/live`.

## 4. Conectar la web

- En la VM, `~/certiface/.env`: añade la URL de la web a `ALLOWED_ORIGINS`
  (separadas por comas) y vuelve a ejecutar `bash deploy/oracle/setup.sh`.
- En la web (Render u otro), variable `CERTIFACE_API_URL=https://<ip-con-guiones>.sslip.io`.

## Operación

```bash
cd ~/certiface
sudo docker compose -f deploy/oracle/docker-compose.yml logs -f api   # logs
sudo docker compose -f deploy/oracle/docker-compose.yml restart api   # reiniciar
sudo docker compose -f deploy/oracle/docker-compose.yml ps            # estado
```

Actualizar el código: repite el paso 2, descomprime encima
(`tar -xzf ~/certiface-backend.tgz -C ~/certiface`) y vuelve a ejecutar
`setup.sh`. La capa de modelos queda en caché: solo se reconstruye el código.

## Problemas

| Síntoma | Causa y solución |
|---|---|
| `setup.sh` dice que faltan GB de RAM | La forma es E2.1.Micro. Crea la instancia como A1.Flex |
| `curl` a la URL no responde | Falta la regla de ingreso de 80/443 en la Security List (paso 1) |
| Caddy no obtiene el certificado | Igual que arriba: Let's Encrypt valida por el puerto 80. Logs: `... logs caddy` |
| `No se pudieron cargar las claves forenses privadas` | Falta `.secrets/manifest-signing.pem` o `FORENSIC_SIGNING_KEY_PASSWORD` en `.env` |
| La web da error de CORS | La URL de la web no está en `ALLOWED_ORIGINS` |
| Análisis muy lento | Sube OCPU de la instancia (A1.Flex permite hasta 4 gratis) y vuelve a ejecutar `setup.sh` |
