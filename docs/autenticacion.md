# Identidad, interfaz y acceso

## Ejecución local

1. Redis: `docker compose -f docker-compose.inference.yml up -d redis`, o iniciar Redis en `127.0.0.1:6379`.
2. Worker: desde `backend/`, `celery -A app.celery_app.celery_app worker --loglevel=INFO --pool=solo`.
3. Backend: `cd backend` y `./start.ps1` (PowerShell). Usa el Python de `.venv`.
4. Web: `cd web` y `npm run dev`. Abrir `http://localhost:4321`.
5. Producción: `npm run build` y `npm run serve` desde `web/`, detrás de HTTPS.

La aplicación ahora necesita un servidor Node: las rutas protegidas y las
sesiones se resuelven mediante Astro SSR con el adaptador oficial de Node.
No desplegar `dist/client` como sitio estático independiente.

## Entorno privado

Se crearon `backend/.env` y `web/.env`; ambos están excluidos de Git.
Los archivos `.env.example` contienen la estructura de configuración sin claves
reales. Nunca colocar `DATABASE_URL`, tokens o claves internas en variables
`PUBLIC_*`.

Web:

- `AUTH_SERVICE_URL`: servicio de usuarios, llamado solo desde el servidor web.
- `CERTIFACE_API_URL`: API de inferencia, llamada solo desde el servidor web.
- `APP_ORIGIN`: origen público exacto; en desarrollo `http://localhost:4321`.
- `SESSION_TTL_SECONDS`: duración máxima de la sesión (segundos).
- `SESSION_COOKIE_SECURE`: activar con HTTPS. En compilaciones de producción
  siempre se fuerza `Secure`, aunque el entorno local contenga `false`.
- `ROLE_PERMISSIONS`: objeto JSON de nombres de rol y permisos de CertiFace.
- `DEFAULT_PERMISSIONS`: permisos para roles no mapeados; no concede laboratorio
  ni administración en la configuración entregada.

Backend:

- `DATABASE_URL`: conexión PostgreSQL privada, conservando SSL y channel binding.
- `AUTH_SERVICE_URL`: mismo servicio de identidad de la web.
- `ROLE_PERMISSIONS`, `DEFAULT_PERMISSIONS`: misma política de acceso de la web.
- `ALLOWED_ORIGINS`: lista explícita para clientes web externos; no usar `*`.
- `DB_CONNECT_TIMEOUT`, `DB_POOL_SIZE`, `DB_MAX_OVERFLOW`: límites de conexión.
- `INTERNAL_API_KEY`: clave para escribir auditoría central, solo en servidor.
- `AUTO_DOWNLOAD_MODELS`: descarga opcional; por defecto el arranque requiere
  los pesos ya preparados con `python scripts/fetch_models.py`.
- `CELERY_BROKER_URL`: broker Redis para publicar trabajos de inferencia.
- `CELERY_RESULT_BACKEND`: Redis para conservar el resultado del trabajo hasta
  su consulta autenticada.
- `CELERY_RESULT_EXPIRES`: TTL de resultados en segundos.

Reiniciar ambos servicios después de cambiar la política de roles o el entorno.
La configuración incluye Administrador, Perito e Invitado, y mapea ADMIN y
GERENTE_GENERAL a administración para mantener la cuenta existente. Esos nombres
solo están en el entorno; no hay IDs de usuarios, roles o cuentas precargados en
el código de la aplicación. Los datos visibles provienen del servicio.

## Pantallas

- `/login`, `/recuperar`, `/restablecer`: acceso y recuperación.
- `/app/laboratorio`: análisis, permitido a Administrador y Perito.
- `/app/usuarios`: listar, buscar, filtrar, crear y editar usuarios.
- `/app/roles`: crear, editar y eliminar roles; pestaña de accesos efectivos.
- `/app/perfil`, `/app/seguridad`: identidad y sesión del usuario activo.

El sidebar muestra las opciones permitidas. El middleware SSR y las rutas API
comprueban también el permiso; ocultar un enlace no es la protección. FastAPI
aplica la misma política al acceder directamente a sus endpoints. El servicio
central conserva sus propias restricciones, que pueden ser más estrictas.

Los permisos de CertiFace se administran en el entorno, porque el contrato
recibido no tiene un endpoint para editar permisos. La pestaña Accesos es de
consulta. Crear un rol remoto no le concede privilegios locales automáticamente.
Nombre y apellido pueden crearse pero no actualizarse: esa operación no existe
en el contrato de edición proporcionado.

## Sesión y seguridad

El token Bearer nunca se entrega al JavaScript del navegador. Se guarda en la
sesión de Astro, en el servidor, con un identificador aleatorio en cookie
HttpOnly + SameSite=Lax. En producción usa Secure y el prefijo `__Host-`.
Se regenera el ID al iniciar sesión y se destruye el registro al salir; una
cookie anterior no permite recuperar la sesión cerrada. Se revalida el perfil
con el servicio en cada petición protegida: no se aceptan JWT sin firma ni se
consulta directamente su base de datos.

En esta instalación de una sola instancia, el almacén está en `web/.sessions`,
fuera de `public` y de Git. Restringir el acceso al directorio al usuario del
proceso. Para múltiples réplicas, cambiar el driver a un almacén compartido
(Redis con TLS, por ejemplo); no replicar archivos de sesión ni servirlos por HTTP.
El logout revoca la sesión web; el contrato externo no ofrece revocación del JWT
ni refresh tokens.

Los formularios API requieren el origen configurado, incluso para JSON. Hay
límites de tamaño, una lista de rutas y campos permitidos, protección CSP,
prevención de inclusión en iframes, políticas de referencia y no-cache privado.
Login y recuperación tienen un limitador local; en múltiples instancias aplicar
además límites compartidos en el proxy. Configurar correctamente el proxy y
APP_ORIGIN antes de publicar.

## PostgreSQL y arranque

`python -m scripts.init_db` crea las tablas faltantes sin borrar datos, incluida
`analysis_jobs` para el estado operativo de Celery. No cambia
columnas existentes: futuras evoluciones requieren migraciones versionadas.

Si la red permite HTTPS a Neon pero bloquea PostgreSQL/TCP, puede inicializarse
el esquema con `python -m scripts.init_db --https`. Envía las sentencias DDL como
una transacción a la API SQL de Neon. Esto no cambia el transporte del ORM:
los expedientes siguen requiriendo conectividad TCP/TLS en el puerto 5432.

- `/health/live`: proceso y modelos cargados, sin depender de PostgreSQL.
- `/health/ready` y `/`: comprueban PostgreSQL; devuelven 503 si no está disponible.
- `/docs`: documentación interactiva.

Durante la configuración se verificó la credencial por HTTPS y se crearon las
las tablas periciales, incluida `analysis_jobs`. La negociación PostgreSQL/TCP agotó el tiempo de espera
en este equipo. Revisar la ruta de red, firewall y disponibilidad del endpoint;
no desactivar SSL ni channel binding como solución.

La clave de BD antigua que estuvo versionada debe revocarse en el proveedor.
La nueva solo se guardó en `backend/.env`.

## Auditoría y contrato externo

La escritura usa `POST /api/internal/audit`, con el ID externo del usuario y la
clave interna del servidor. Sin clave o ante fallos, el evento local queda sin
sincronizar. El contrato no incluye GET de auditoría, edición de permisos,
renovación de sesión ni edición autónoma del perfil. No se simulan esas funciones.
Configurar en el servicio de usuarios que sus correos de recuperación apunten a
`/restablecer?token=...` de la URL pública de CertiFace.

## Pruebas

```powershell
cd backend
.venv/Scripts/python.exe -m unittest discover -s tests -v
cd ../web
npm test
npm run check
npm run build
```

Las pruebas HTTP arrancan un servidor externo simulado exclusivamente para
pruebas. Verifican sesiones, revocación, CSRF y acceso por URL para los tres roles,
además de roles desconocidos. No se crean usuarios reales durante estas pruebas.
La interfaz se verificó con navegador a 1440 px y 390 px, incluyendo filtros,
formularios laterales, pestañas y navegación móvil.
