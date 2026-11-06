# Despliegue Gratuito Del Backend En Hugging Face Spaces

Guía paso a paso para publicar el backend de CertiFace (FastAPI + Celery +
Redis + modelos de detección) en un **Space Docker gratuito** de Hugging Face:
2 vCPU, 16 GB de RAM, sin tarjeta de crédito.

## Arquitectura Del Despliegue

```
                 ┌──────────── Space Docker (CPU basic, gratis) ───────────┐
 Web (Astro) ──► │ uvicorn :7860 ──► Redis 127.0.0.1 ──► worker Celery     │
                 │      │  (API)       (broker local)      (inferencia)     │
                 └──────┼──────────────────────────────────────┼───────────┘
                        ├──► PostgreSQL (Neon)        ◄────────┤
                        ├──► Cloudflare R2 (evidencia cifrada) ◄┤
                        └──► auth-service (Render)
```

- Un solo contenedor ejecuta los tres procesos (`backend/docker/start.sh`).
  Si uno muere, el contenedor se detiene y Hugging Face lo reinicia.
- Los pesos de terceros (~2.6 GB) se descargan y convierten **durante el
  build** (`scripts/fetch_models.py`): el contenedor arranca sin depender de
  las fuentes de los modelos.
- Nada pericial vive en el disco del Space (que es efímero): PostgreSQL y R2
  siguen siendo la fuente de verdad, exactamente como en local.

| Archivo | Función |
|---|---|
| `backend/Dockerfile` | Imagen: Python 3.11, PyTorch CPU, Redis, pesos |
| `backend/docker/start.sh` | Arranque: clave de firma → Redis → Celery → API |
| `backend/.dockerignore` | Excluye secretos, venv y pesos re-descargables |
| `backend/deploy/huggingface/README.md` | Ficha del Space (SDK Docker, puerto 7860) |
| `backend/deploy/huggingface/deploy.py` | Publica `backend/` en el Space |

---

## Paso 0 — Requisitos

1. Cuenta gratuita en [huggingface.co](https://huggingface.co/join).
2. Python con `huggingface_hub` en tu máquina:
   ```powershell
   pip install -U huggingface_hub
   ```
3. A mano, los valores de tu `backend/.env` local que ya funciona (Neon, R2,
   claves forenses) y el archivo `backend/.secrets/manifest-signing.pem`.
4. La clave **pública** correspondiente a esa clave privada debe estar en
   `backend/keys/*.pub.pem` (la genera `scripts/setup_forensic_keys.py`; ya
   hay dos versionadas). Sin ella, los manifiestos firmados no se verifican.

## Paso 1 — Crear El Space

1. Abre <https://huggingface.co/new-space>.
2. Completa:
   - **Space name:** `certiface-api` (o el que prefieras).
   - **License:** la del proyecto (o déjalo vacío).
   - **Select the Space SDK:** **Docker** → plantilla **Blank**.
   - **Space hardware:** **CPU basic · 2 vCPU · 16 GB · FREE**.
   - **Visibility:** **Public**.
3. Pulsa **Create Space**.

> **¿Por qué público?** Un Space privado exige un token de Hugging Face en la
> cabecera `Authorization`, pero esa cabecera ya la usa el JWT del perito
> (`Bearer …`): la web no podría llamar a la API. Público solo expone el
> código, que ya es público en GitHub; **los secretos del Paso 2 nunca son
> visibles** y la API sigue exigiendo autenticación en cada ruta pericial.

## Paso 2 — Variables Y Secretos

En el Space: **Settings → Variables and secrets**. Usa **New secret** para
lo sensible y **New variable** para lo demás. Copia los valores de tu `.env`
**sin las comillas simples externas** (en `.env` se escriben
`'{"…"}'`; en Hugging Face va solo `{"…"}`).

### Secretos (New secret)

| Nombre | Valor |
|---|---|
| `DATABASE_URL` | La de Neon, igual que en tu `.env` |
| `INTERNAL_API_KEY` | Igual que en tu `.env` |
| `S3_ACCESS_KEY` | Access key de R2 |
| `S3_SECRET_KEY` | Secret key de R2 |
| `CLOUDFLARE_API_TOKEN` | Igual que en tu `.env` (verificación de retención) |
| `FORENSIC_ENCRYPTION_KEYS` | El JSON `{"id":"clave-base64"}`, sin comillas externas |
| `FORENSIC_SIGNING_KEY_PASSWORD` | Contraseña de la clave de firma |
| `FORENSIC_SIGNING_KEY_PEM_B64` | La clave privada en base64 (ver abajo) |

Para obtener `FORENSIC_SIGNING_KEY_PEM_B64`, en PowerShell desde la raíz del
repo (copia la salida al portapapeles; no la pegues en ningún otro sitio):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("backend\.secrets\manifest-signing.pem")) | Set-Clipboard
```

`start.sh` la decodifica al arrancar en `./.secrets/manifest-signing.pem`
con permisos 600, dentro del contenedor.

### Variables (New variable)

| Nombre | Valor |
|---|---|
| `AUTH_SERVICE_URL` | `https://auth-service-w3lo.onrender.com` |
| `S3_ENDPOINT_URL` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `S3_BUCKET_NAME` | Tu bucket de R2 |
| `S3_REGION` | `auto` |
| `FORENSIC_STORAGE_PREFIX` | `certiface/v1` |
| `FORENSIC_REQUIRE_RETENTION` | `true` |
| `FORENSIC_ACTIVE_ENCRYPTION_KEY_ID` | Igual que en tu `.env` |
| `FORENSIC_MAX_UPLOAD_BYTES` | `10485760` |
| `CLOUDFLARE_ACCOUNT_ID` | Igual que en tu `.env` |
| `ALLOWED_ORIGINS` | Origen de la web, p. ej. `https://certiface.tu-dominio.com` |
| `ROLE_PERMISSIONS` | El JSON de roles, sin comillas externas |
| `DEFAULT_PERMISSIONS` | `["profile","security"]` |

Ya vienen fijadas en la imagen (no hace falta crearlas): `USE_LOCAL_STORAGE=false`,
`FORENSIC_SIGNING_KEY_PATH`, `FORENSIC_PUBLIC_KEYS_PATH`, `FORENSIC_TEMP_PATH`,
`CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND`, `PORT=7860`.

## Paso 3 — Base De Datos

Si tu base de Neon ya funciona con el backend local, **no hay nada que
hacer**: el Space usa la misma. Si es una base nueva, inicialízala una vez
desde tu máquina, como en desarrollo:

```powershell
cd backend
.\.venv\Scripts\python.exe -m scripts.init_db
```

## Paso 4 — Publicar

1. Crea un token en <https://huggingface.co/settings/tokens> con permiso
   **Write** e inicia sesión:
   ```powershell
   hf auth login
   ```
   (En versiones antiguas de la librería el comando es `huggingface-cli login`.)
2. Publica desde `backend/`:
   ```powershell
   cd backend
   python deploy/huggingface/deploy.py <tu-usuario>/certiface-api
   ```

El script sube el código, el **Detector De Síntesis GAN** (entrenamiento
propio, 16 MB) y los configs, y excluye `.env`, `.secrets/`, `.venv/` y los
pesos de terceros. Hugging Face empieza a construir la imagen al instante.

## Paso 5 — Seguir El Build Y El Arranque

1. Abre `https://huggingface.co/spaces/<tu-usuario>/certiface-api` →
   pestaña **Logs**.
2. **Build** (15-30 min la primera vez): instala PyTorch CPU y descarga y
   convierte los tres pesos de terceros (Face Swap 267 MB, Difusión 355 MB,
   Sonda de Escena 2.1 GB).
3. **Container**: deberías ver, en orden:
   ```
   [start] Clave de firma escrita en ./.secrets/manifest-signing.pem
   [start] PostgreSQL alcanzable en ep-xxxx.neon.tech:5432
   [start] Redis listo
   [start] Worker Celery iniciado
   [start] API iniciando en el puerto 7860 (la carga de modelos tarda 1-3 min)
   ... Uvicorn running on http://0.0.0.0:7860
   ```
   El estado del Space pasa a **Running** cuando la API responde.

## Paso 6 — Verificar

```powershell
# El proceso está vivo y los modelos cargados
curl https://<tu-usuario>-certiface-api.hf.space/health/live

# PostgreSQL + R2 + retención verificados
curl https://<tu-usuario>-certiface-api.hf.space/health/ready
```

La documentación interactiva queda en `/docs`. Si `/health/ready` responde
503, revisa **Problemas** más abajo.

## Paso 7 — Conectar La Web

En el entorno de producción de la web (`web/.env` o el panel de tu hosting):

```
CERTIFACE_API_URL=https://<tu-usuario>-certiface-api.hf.space
```

Y en el Space, `ALLOWED_ORIGINS` debe contener el origen público de la web
(`APP_ORIGIN`). Tras cambiar una variable, el Space se reinicia solo.

## Actualizar El Despliegue

Cada vez que cambies el backend, repite el Paso 4:

```powershell
cd backend
python deploy/huggingface/deploy.py <tu-usuario>/certiface-api
```

Los cambios en `app/` reutilizan la capa de los pesos si Hugging Face
conserva la caché del build anterior; los pesos se vuelven a descargar si
cambian `requirements.txt`, `models/` o `scripts/fetch_models.py`, o si el
Space se reconstruye desde cero (*Factory rebuild*).

---

## Límites Del Plan Gratuito

- **Se duerme tras ~48 h sin visitas.** La siguiente petición lo despierta,
  pero tarda 2-4 min (arranque + carga de modelos). Antes de una demo o
  defensa, ábrelo unos minutos antes.
- **2 vCPU sin GPU.** Un video tarda varios minutos; usa el flujo asíncrono
  de casos (Celery, con progreso) en lugar de `POST /predict` síncrono, que
  puede exceder el tiempo de espera del proxy.
- **Un trabajo de inferencia a la vez** (worker `--pool=solo`): los demás
  esperan en la cola de Redis.
- **Memoria:** la API carga los modelos al arrancar y el worker en su primer
  trabajo; ambos procesos caben en los 16 GB.
- **Disco efímero:** se borra al reiniciar. No afecta: la evidencia va a R2
  y los registros a PostgreSQL; Redis solo guarda resultados temporales.

## Problemas

### `ADVERTENCIA: no se pudo abrir TCP a PostgreSQL`

Hugging Face documenta que los Spaces solo pueden conectarse hacia fuera por
los puertos **80, 443 y 8080**; PostgreSQL usa el **5432**. Al personal de
Hugging Face se le ha pedido abrir el 5432 en algunos Spaces, pero no es una
política publicada. Si ves esta advertencia y `/health/ready` da 503:

1. Pide que abran el puerto en el foro
   (<https://discuss.huggingface.co/c/spaces/24>), indicando tu Space y que
   necesitas salida a `5432` hacia Neon. Ya lo han concedido en otros casos.
2. Mientras tanto, o si no responden, usa el **Plan B (Oracle)** de abajo:
   la misma imagen funciona sin cambios.

### El build falla en `fetch_models.py`

Suele ser un corte de red al descargar los 2.1 GB de la sonda. Vuelve a
lanzarlo en **Settings → Factory rebuild**.

### `ERROR: falta el secreto FORENSIC_SIGNING_KEY_PEM_B64`

Falta ese secreto o tiene espacios o saltos de línea extra. Regenéralo con el
comando del Paso 2.

### `/health/ready` da 503 por almacenamiento

Revisa `S3_*`, `CLOUDFLARE_*` y que el bucket tenga la retención
configurada (`scripts/check_forensic_storage.py` lo verifica en local).

---

## Plan B — Oracle Cloud Always Free (Misma Imagen)

Una VM ARM siempre encendida, sin bloqueo de puertos: **2 OCPU y 12 GB de
RAM** gratis (Oracle redujo el límite de 4 OCPU/24 GB en junio de 2026). Pide
tarjeta para verificar la identidad, pero no cobra mientras uses recursos
*Always Free*.

1. Crea la cuenta en <https://www.oracle.com/cloud/free/>.
2. **Compute → Instances → Create instance**: imagen **Ubuntu 24.04**, forma
   **VM.Standard.A1.Flex** con **2 OCPU / 12 GB** (si no hay capacidad, prueba
   otro dominio de disponibilidad o reintenta más tarde). Guarda la clave SSH.
3. Conéctate por SSH e instala Docker:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER && newgrp docker
   ```
4. Clona y construye (el Dockerfile funciona igual en ARM; el primer build
   tarda bastante por PyTorch y la descarga de pesos):
   ```bash
   git clone https://github.com/Alyc3/deepfakeSistem.git
   cd deepfakeSistem
   docker build -t certiface-api backend
   ```
5. Crea `~/certiface.env` con las **mismas** variables y secretos del Paso 2
   (formato `NOMBRE=valor`, sin comillas) y protégelo con `chmod 600`.
6. Arranca con reinicio automático:
   ```bash
   docker run -d --name certiface --restart unless-stopped \
     --env-file ~/certiface.env -p 127.0.0.1:7860:7860 certiface-api
   docker logs -f certiface
   ```
7. **HTTPS gratis sin abrir puertos:** usa un Cloudflare Tunnel
   (`cloudflared`) apuntando a `http://localhost:7860`; te da una URL
   `https://…` que pones en `CERTIFACE_API_URL` de la web.

> Oracle puede recuperar instancias *Always Free* con uso muy bajo durante
> varios días; revisa la consola si el servicio deja de responder.
