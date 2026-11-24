# Despliegue de la web en Render

La aplicación web (`web/`) se despliega como un servicio Node en Render. El motor forense es el backend desplegado en Oracle Cloud (`https://157-151-202-23.sslip.io`, ver [DESPLIEGUE_ORACLE.md](DESPLIEGUE_ORACLE.md)). La web lo llama siempre desde `CERTIFACE_API_URL`; no hay que configurar nada en la interfaz.

```text
Navegador ──► CertiFace web (Render) ──► auth-service (FastAPI Cloud)
                       │
                       └──► motor forense (Oracle Cloud): CERTIFACE_API_URL
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
| `CERTIFACE_API_URL` | `https://157-151-202-23.sslip.io` (el backend en Oracle Cloud). |

En el auth-service (FastAPI Cloud), `FRONTEND_URL` debe ser esa misma URL pública, para que los enlaces de recuperación e invitación lleguen a la web.

## 4. Conexión con el motor forense

- Es el servidor web quien llama al motor, no el navegador. El token del usuario viaja de servidor a servidor, y ni el token ni `CERTIFACE_API_URL` llegan al navegador.
- Para cambiar de motor, cambia `CERTIFACE_API_URL` en Render (*Environment*) y vuelve a desplegar. Para desarrollo local con el backend de tu equipo, usa `http://127.0.0.1:8000` en `web/.env`.
- Las peticiones del motor tienen límites de tiempo: 4 minutos para un análisis directo y 2 para las del archivo forense. El análisis de los expedientes es asíncrono, así que los trabajos largos no se cortan.

## 5. Limitaciones del plan gratuito

- **Sesiones:** se guardan en el disco del servicio (`web/.sessions`). Render lo borra en cada despliegue o reinicio, y el plan gratuito se apaga tras 15 minutos sin tráfico. Los usuarios tendrán que volver a iniciar sesión tras cada arranque.
- **Una sola instancia:** la renovación de tokens se coordina en memoria. Con varias instancias, usa afinidad de sesión y un almacén de sesiones compartido.

## 6. Comprobar el despliegue

- `https://<servicio>.onrender.com/login` carga la página de acceso.
- Inicia sesión con una cuenta del auth-service.
- El laboratorio muestra el motor conectado. Si indica «Motor no disponible», revisa `CERTIFACE_API_URL` y que `https://157-151-202-23.sslip.io/health/live` responda.
