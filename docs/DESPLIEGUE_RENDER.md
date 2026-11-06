# Despliegue de la web en Render

La aplicación web (`web/`) se despliega como un servicio Node en Render. El backend forense puede seguir en tu equipo mientras haces pruebas: la web se conecta a él desde un panel oculto.

```text
Navegador ──► CertiFace web (Render) ──► auth-service (FastAPI Cloud)
                       │
                       └──► motor forense: CERTIFACE_API_URL o el elegido en el panel oculto
```

## 1. Crear el servicio

**Opción A — Blueprint (más rápido).** En Render, *New > Blueprint* y elige el repositorio. `render.yaml`, en la raíz, crea el servicio `certiface-web` con todo configurado. Render pide los valores marcados como secretos: cópialos de `web/.env.production`.

**Opción B — A mano.** *New > Web Service* con:

| Campo | Valor |
| :--- | :--- |
| Runtime | Node |
| Root Directory | `web` |
| Build Command | `bash render-build.sh` |
| Start Command | `npm start` |
| Health Check Path | `/login` |

En *Environment > Add from .env*, pega el contenido de `web/.env.production`.

La versión de Node sale de `web/.node-version` (22, con el mínimo `>=22.23.4` que exige Astro en `package.json`).

## 2. Qué hace `render-build.sh`

1. `npm ci --include=dev`: instala desde `package-lock.json`, incluidas las herramientas de compilación.
2. `NODE_ENV=production npm run build`: compila el servidor en `dist/server/entry.mjs` con la cookie `__Host-` segura y HSTS.
3. `npm prune --omit=dev`: deja solo las dependencias que usa el servidor en ejecución.

## 3. Variables de entorno

`web/.env.production` ya trae los valores de producción. Revisa sobre todo:

| Variable | Valor en Render |
| :--- | :--- |
| `APP_ORIGIN` | La URL pública exacta, `https://<nombre-del-servicio>.onrender.com`. Si cambias el nombre del servicio, cámbiala: las peticiones de otro origen se rechazan. |
| `AUTH_INTERNAL_API_KEY` | La `INTERNAL_API_KEY` del auth-service. |
| `TRUSTED_PROXY_COUNT` | `1` (el proxy de Render). |
| `CERTIFACE_API_URL` | Vacía hasta desplegar el backend. |
| `FORENSICS_API_OVERRIDE` | `true` mientras uses el panel oculto. |

En el auth-service (FastAPI Cloud), `FRONTEND_URL` debe ser esa misma URL pública, para que los enlaces de recuperación e invitación lleguen a la web.

## 4. Usar el motor forense de tu equipo

Render no puede llegar a `http://127.0.0.1:8000` de tu equipo: es el servidor web quien llama al motor, no el navegador. Por eso el motor local se publica con un túnel HTTPS y la URL del túnel se pega en el panel oculto.

1. Arranca el backend en local (`backend/start.ps1`, puerto 8000).
2. Abre un túnel. No necesita cuenta:
   ```bash
   cloudflared tunnel --url http://localhost:8000
   ```
   Copia la URL `https://….trycloudflare.com` que muestra. También vale `ngrok http 8000`.
3. En la web, ya con sesión iniciada con un rol con laboratorio, pulsa **Ctrl + Alt + Shift + M**.
4. Pega la URL y pulsa *Probar y conectar*. La web comprueba `/health/live` antes de guardarla.

La elección vale solo para tu sesión y se borra al cerrarla. *Usar el del servidor* vuelve a `CERTIFACE_API_URL`.

**Seguridad del panel:**
- Solo existe con `FORENSICS_API_OVERRIDE=true` y para roles con permiso `laboratory`.
- En producción solo acepta HTTPS y los dominios de `FORENSICS_API_OVERRIDE_HOSTS`. Rechaza direcciones IP y dominios que resuelvan a redes internas.
- El token del usuario viaja de servidor a servidor; el navegador nunca lo ve. `CERTIFACE_API_URL` tampoco se envía al navegador.

Cuando despliegues el backend, define `CERTIFACE_API_URL` y pon `FORENSICS_API_OVERRIDE=false`.

Las peticiones del motor tienen límites de tiempo: 4 minutos para un análisis directo y 2 para las del archivo forense. El análisis de los expedientes es asíncrono, así que el túnel no corta los trabajos largos.

## 5. Limitaciones del plan gratuito

- **Sesiones:** se guardan en el disco del servicio (`web/.sessions`). Render lo borra en cada despliegue o reinicio, y el plan gratuito se apaga tras 15 minutos sin tráfico. Los usuarios tendrán que volver a iniciar sesión tras cada arranque.
- **Una sola instancia:** la renovación de tokens se coordina en memoria. Con varias instancias, usa afinidad de sesión y un almacén de sesiones compartido.

## 6. Comprobar el despliegue

- `https://<servicio>.onrender.com/login` carga la página de acceso.
- Inicia sesión con una cuenta del auth-service.
- Si el motor no está conectado, el laboratorio muestra «Motor no disponible»: conéctalo con el panel oculto.
