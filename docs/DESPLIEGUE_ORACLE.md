# Despliegue del backend en Oracle Cloud con GitHub Actions

El backend corre en una VM de Oracle Cloud (Always Free) con Docker y se
actualiza solo: cada push a `main` que toque `backend/` pasa las pruebas y, si
salen bien, se despliega en la VM.

- API: <https://157-151-202-23.sslip.io>
- Documentación (ReDoc): <https://157-151-202-23.sslip.io/docs>

```text
git push (main) ──► GitHub Actions ──► pruebas ──► rsync por SSH ──► VM Oracle
                                                                     │
                     Internet ──► Caddy (HTTPS 443) ──► API + worker + Redis (Docker)
```

| Archivo | Para qué sirve |
|---|---|
| `.github/workflows/backend.yml` | Pipeline: pruebas y despliegue |
| `backend/deploy/oracle/setup.sh` | Preparación inicial de una VM nueva (una sola vez) |
| `backend/deploy/oracle/deploy.sh` | Reconstruye la imagen y reinicia la API (lo ejecuta el pipeline) |
| `backend/deploy/oracle/docker-compose.yml` | Servicios `api` y `caddy` |
| `backend/deploy/oracle/Caddyfile` | HTTPS automático con Let's Encrypt |

## La VM

| | Valor |
|---|---|
| Forma | `VM.Standard.A1.Flex` (ARM): 2 OCPU y 12 GB de RAM (gratis hasta 4 OCPU y 24 GB) |
| Sistema | Ubuntu 24.04, usuario `ubuntu` |
| IP pública | `157.151.202.23` |
| Carpeta del backend | `/home/ubuntu/certiface` |
| Puertos abiertos | 22 (SSH), 80 y 443 (Security List de la VCN y cortafuegos de la VM) |

Lo que **solo existe en la VM** y el pipeline nunca toca: `backend/.env`
(variables de entorno), `backend/.secrets/manifest-signing.pem` (clave privada
de firma) y `deploy/oracle/.env` (dominio, lo escribe `setup.sh`).

## Preparar una VM nueva (una sola vez)

1. En la VCN, **Security List → Add Ingress Rules**: TCP `80` y `443` desde
   `0.0.0.0/0`.
2. Copia el código y los secretos desde tu PC:
   ```powershell
   cd backend
   ssh -i <clave> ubuntu@<IP> "mkdir -p ~/certiface/.secrets"
   scp -i <clave> -r app deploy docker keys migrations models scripts Dockerfile requirements.txt .dockerignore .env ubuntu@<IP>:~/certiface/
   scp -i <clave> .secrets/manifest-signing.pem ubuntu@<IP>:~/certiface/.secrets/
   ```
3. En la VM:
   ```bash
   cd ~/certiface && bash deploy/oracle/setup.sh
   ```
   Instala Docker, abre 80/443, fija el dominio `<ip-con-guiones>.sslip.io` y
   hace el primer despliegue (15-30 min: descarga ~2.6 GB de modelos).

Después, todo despliegue lo hace GitHub Actions.

## Conectar GitHub Actions (una sola vez)

1. **Clave de despliegue.** Una clave SSH exclusiva del pipeline (no la
   personal). Se genera en tu PC:
   ```powershell
   ssh-keygen -t ed25519 -N '""' -C github-actions-certiface-deploy -f $env:USERPROFILE\.ssh\certiface-github-deploy
   ```
   Y se autoriza en la VM añadiendo la pública a `~/.ssh/authorized_keys`:
   ```powershell
   Get-Content $env:USERPROFILE\.ssh\certiface-github-deploy.pub | ssh -i $env:USERPROFILE\.ssh\oracle-certiface ubuntu@157.151.202.23 "cat >> ~/.ssh/authorized_keys"
   ```
2. **Secretos del repositorio** (GitHub → *Settings → Secrets and variables →
   Actions → New repository secret*). Solo el dueño del repositorio puede
   crearlos:

   | Secreto | Valor |
   |---|---|
   | `ORACLE_HOST` | `157.151.202.23` |
   | `ORACLE_USER` | `ubuntu` |
   | `ORACLE_SSH_KEY` | Contenido completo de `certiface-github-deploy` (la privada, sin `.pub`) |
   | `ORACLE_KNOWN_HOSTS` | Opcional: salida de `ssh-keyscan -t ed25519 157.151.202.23`. Si falta, se obtiene al conectar |

   Variables opcionales (pestaña *Variables*): `BACKEND_URL` si cambia el
   dominio y `ORACLE_APP_DIR` si el backend no está en `/home/ubuntu/certiface`.
3. **Probar:** *Actions → Backend CI/CD → Run workflow* sobre `main`.

## Qué hace el pipeline

| Evento | Pruebas | Despliegue |
|---|---|---|
| Push a `develop` o pull request que toca `backend/` | Sí | No |
| Push a `main` que toca `backend/` (p. ej. al fusionar un PR) | Sí | Sí, si las pruebas pasan |
| *Run workflow* manual sobre `main` | Sí | Sí |

1. **Pruebas:** Python 3.11, dependencias sin PyTorch (las pruebas no cargan
   modelos) y `python -m unittest tests/test_*.py`.
2. **Copia:** `rsync --delete` de `backend/` a `/home/ubuntu/certiface`. La VM
   queda igual que el repositorio, salvo los secretos y datos locales, que se
   excluyen.
3. **Reconstrucción:** `deploy/oracle/deploy.sh` construye la imagen (los
   modelos quedan en caché; solo cambia la capa del código, ~1-2 min) y
   reinicia los contenedores. La API anterior sigue atendiendo mientras se
   construye la imagen; al reiniciar hay 1-3 min sin servicio mientras se
   cargan los modelos.
4. **Verificación:** espera a que `/health/live` responda dentro de la VM y
   después desde Internet, y comprueba `/docs`. Si algo falla, el job queda en
   rojo con los últimos logs de la API.

Los despliegues no se solapan: uno nuevo espera a que termine el anterior.

## Operación

```bash
cd ~/certiface
sudo docker compose -f deploy/oracle/docker-compose.yml ps            # estado
sudo docker compose -f deploy/oracle/docker-compose.yml logs -f api   # logs
sudo docker compose -f deploy/oracle/docker-compose.yml restart api   # reiniciar
bash deploy/oracle/deploy.sh                                          # redesplegar a mano
```

- **Cambiar una variable de entorno:** edita `~/certiface/.env` en la VM y
  ejecuta `bash deploy/oracle/deploy.sh` (el pipeline no toca ese archivo).
- **Volver a una versión anterior:** revierte el commit en `main`
  (`git revert`) y haz push; el pipeline despliega la versión revertida.

## Problemas

| Síntoma | Causa y solución |
|---|---|
| El job falla en *Configurar SSH* con `Faltan los secretos` | Crea los secretos del paso 2 |
| `Permission denied (publickey)` | La clave pública de despliegue no está en `~/.ssh/authorized_keys` de la VM |
| `Connection timed out` en SSH | Falta la regla de ingreso TCP 22 en la Security List |
| *Verificar la API pública* falla | Falta la regla de 80/443, o Caddy no obtuvo el certificado: `... logs caddy` |
| `No se pudieron cargar las claves forenses privadas` | Falta `.secrets/manifest-signing.pem` o `FORENSIC_SIGNING_KEY_PASSWORD` en `.env` |
| La web da error de CORS | La URL de la web no está en `ALLOWED_ORIGINS` del `.env` de la VM |
| Análisis muy lento | Sube la VM a 4 OCPU / 24 GB (sigue siendo gratis) y vuelve a ejecutar `setup.sh` |
