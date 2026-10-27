# CertiFace — Peritaje de Medios Digitales

> **Actualización de identidad:** la web ahora usa Astro SSR, sidebar por permisos
> y sesiones HttpOnly. El acceso usa el servicio central de usuarios y roles;
> `/predict` requiere autenticación y permiso de laboratorio. Consulta
> [la guía de integración](docs/autenticacion.md) para configuración, uso y pruebas.
> Las referencias al registro local PBKDF2 que aparecen más abajo describen el flujo anterior.

> **Almacén forense:** originales, copias y reportes ahora se preservan cifrados
> y sellados en R2. El flujo `/predict` también archiva sus resultados. Consulta
> [la implementación y operación del almacén](docs/ALMACEN_FORENSE_S3.md).

Sistema pericial para casos de **suplantación de identidad** (face swap y
deepfake), compuesto por una **API de inferencia en FastAPI** y una
**aplicación web responsive construida en Astro con arquitectura hexagonal**.
El perito incorpora una imagen o un video con un rostro y el sistema emite un
dictamen preliminar — **auténtico** o **manipulado** — con su confianza
porcentual.

La aplicación tiene tres pantallas: una **landing** de presentación, un **login
local** (perfil de perito con clave protegida por PBKDF2 en el propio
navegador, sin servidor de identidad) y el **laboratorio** de análisis. Se usa
igual desde un monitor de escritorio que desde una tableta o un teléfono: la
misma interfaz se reorganiza en una sola columna sin perder ninguna sección.
La identidad visual usa una paleta de negros cálidos, naranja (`#EB4604`,
manipulación/alerta) y verde moss (`#99A57D`, autenticidad), con tipografías
Chakra Petch e IBM Plex servidas por la propia aplicación.

**Autoría:** Alyce Maldonado

---

## Tabla de contenidos

1. [Arquitectura general](#arquitectura-general)
2. [Requisitos previos](#requisitos-previos)
3. [Puesta en marcha del backend](#puesta-en-marcha-del-backend)
4. [Puesta en marcha de la aplicación web](#puesta-en-marcha-de-la-aplicación-web)
5. [Construcción y despliegue](#construcción-y-despliegue)
6. [El modelo en detalle](#el-modelo-en-detalle)
7. [El backend en detalle](#el-backend-en-detalle)
8. [La aplicación web en detalle](#la-aplicación-web-en-detalle)
9. [Contrato de la API](#contrato-de-la-api)
10. [Limitaciones conocidas](#limitaciones-conocidas)
11. [Resolución de problemas](#resolución-de-problemas)

---

## Arquitectura general

Son **dos piezas independientes** que se comunican por HTTP. El backend no
sirve la interfaz: solo expone la API de inferencia. La aplicación web es un
sitio estático que se ejecuta entero en el navegador del perito, así que el
material analizado va del navegador al backend **sin intermediarios**.

```
┌──────────────────────────────┐         ┌──────────────────────────────┐
│  Aplicación web (Astro)      │         │       Backend FastAPI        │
│  navegador del perito        │         │        (Python/PyTorch)      │
│                              │         │                              │
│  ┌────────────────────────┐  │         │  ┌────────────────────────┐  │
│  │ ui/       vistas y     │  │         │  │ main.py    rutas HTTP  │  │
│  │           controladores│  │         │  └───────────┬────────────┘  │
│  ├────────────────────────┤  │         │              │               │
│  │ application/ casos de  │  │  HTTP   │   ┌──────────┴──────────┐    │
│  │           uso + puertos│──┼────────►│   │ preprocessing.py    │    │
│  ├────────────────────────┤  │  POST   │   │ (fotogramas, YuNet) │    │
│  │ domain/   reglas del   │  │         │   └──────────┬──────────┘    │
│  │           peritaje     │  │  JSON   │   ┌──────────┴──────────┐    │
│  ├────────────────────────┤◄─┼─────────│   │ model.py + explain  │    │
│  │ infrastructure/        │  │         │   │ 3 peritos + sonda   │    │
│  │   fetch · localStorage │  │         │   └─────────────────────┘    │
│  └────────────────────────┘  │         │                              │
└──────────────────────────────┘         └──────────────────────────────┘
        ▲ dependencias siempre hacia dentro: ui → application → domain
```

**Estructura del repositorio:**

```
deepfakeSistem/
├── backend/
│   ├── app/
│   │   ├── main.py            # Rutas HTTP y despacho imagen/video
│   │   ├── model.py           # Orquestación: peritos, agregación y veredicto
│   │   ├── faceswap_model.py  # Detector De Face Swap (B7, DFDC)
│   │   ├── diffusion_model.py # Detector De Difusión Facial (SigLIP2)
│   │   ├── scene_model.py     # Sonda De Escena Generada (ensemble)
│   │   ├── explain.py         # Mapa de calor explicativo (EigenCAM fusionado)
│   │   ├── preprocessing.py   # Fotogramas (OpenCV) y recorte facial (YuNet)
│   │   └── schemas.py         # (vacío, reservado para modelos Pydantic)
│   ├── scripts/
│   │   └── fetch_models.py    # Reconstruye los pesos no versionados
│   ├── models/                # Ver models/README.md (catálogo y procedimiento)
│   │   ├── Detector_Facial_YuNet.onnx    # Recorte facial (227 KB)
│   │   ├── Detector_De_Sintesis_GAN.pth  # Perito 1: síntesis GAN (16 MB)
│   │   ├── Detector_De_Face_Swap.pth     # Perito 2: face swap, DFDC (267 MB)
│   │   ├── Detector_De_Difusion_Facial/  # Perito 3: difusión moderna (355 MB)
│   │   └── Sonda_De_Escena_Generada/     # Sonda de encuadre completo (2 GB)
│   └── requirements.txt
└── web/                       # Aplicación web (Astro + TypeScript)
    ├── src/
    │   ├── domain/            # NÚCLEO — reglas del peritaje, sin navegador
    │   │   ├── verdict.ts     # Dictámenes, nombres de peritos, leyenda ▸
    │   │   ├── analysis.ts    # Contrato de la respuesta del backend
    │   │   ├── evidence.ts    # Admisión del material (MIME, 10 MB)
    │   │   ├── integrity.ts   # Cadena de custodia: huellas y su contraste
    │   │   ├── risk.ts        # Bandas de la escala de riesgo del mapa
    │   │   ├── checklist.ts   # Peritaje manual y aritmética del desempate
    │   │   ├── analyst.ts     # Perito y credenciales
    │   │   ├── case-record.ts # Registro de casos
    │   │   └── settings.ts    # Configuración del laboratorio
    │   ├── application/       # CASOS DE USO Y PUERTOS
    │   │   ├── ports/         # Contratos: API, ajustes, casos, credencial, huella
    │   │   └── use-cases/     # Analizar, verificar integridad, acceder, casos
    │   ├── infrastructure/    # ADAPTADORES — lo reemplazable
    │   │   ├── http/          # API pericial sobre fetch
    │   │   ├── storage/       # localStorage / sessionStorage
    │   │   ├── crypto/        # PBKDF2 (acceso) y SHA-256 (custodia)
    │   │   └── container.ts   # Raíz de composición (aquí se enchufa todo)
    │   ├── ui/                # ADAPTADOR DE ENTRADA — la interfaz
    │   │   ├── layouts/       # Envoltura del documento
    │   │   ├── components/    # Landing, login, laboratorio (.astro)
    │   │   ├── styles/        # Tokens de la identidad CertiFace
    │   │   └── client/        # Controladores y presentadores (TypeScript)
    │   └── pages/index.astro  # Única ruta: las tres vistas
    ├── public/assets/
    │   ├── fonts/             # Chakra Petch + IBM Plex (OFL)
    │   ├── art/               # Retícula pericial e icono
    │   └── muestras/          # Muestras de ejemplo
    ├── astro.config.mjs
    └── tsconfig.json          # Alias @domain, @application, @infrastructure, @ui
```

---

## Requisitos previos

| Componente | Requisito | Comprobación |
|---|---|---|
| Backend | Python 3.10 o superior | `python3 --version` |
| Aplicación web | Node.js 22.12 o superior (lo exige Astro 7) | `node --version` |
| Aplicación web | npm 9.6.5 o superior | `npm --version` |
| Uso | Un navegador moderno (Chrome, Firefox, Edge, Safari) | — |

No hace falta GPU: si no se detecta CUDA, PyTorch usa la CPU automáticamente
(y la Sonda De Escena elige dispositivo según la VRAM libre). Tampoco hace
falta entrenar nada: los pesos propios van en el repositorio y los de
terceros se reconstruyen con `scripts/fetch_models.py` (paso 4).

---

## Puesta en marcha del backend

> **Importante:** `uvicorn` debe lanzarse **desde el directorio `backend/`**.
> El modelo se carga con la ruta relativa `models/Detector_De_Sintesis_GAN.pth`
> (`backend/app/model.py`) y el video temporal también se escribe en el
> directorio de trabajo. Si arrancas desde otro sitio, la carga falla.

### 1. Crear el entorno virtual

```bash
cd backend
python3 -m venv .venv
```

### 2. Activarlo

| Shell / sistema | Comando |
|---|---|
| bash / zsh | `source .venv/bin/activate` |
| fish | `source .venv/bin/activate.fish` |
| Windows (PowerShell) | `.venv\Scripts\Activate.ps1` |
| Windows (CMD) | `.venv\Scripts\activate.bat` |

### 3. Instalar dependencias

```bash
pip install -r requirements.txt
```

Son once paquetes directos: `fastapi`, `uvicorn[standard]`, `torch`,
`torchvision`, `efficientnet-pytorch`, `pillow`, `opencv-python-headless`,
`python-multipart` (obligatorio para recibir `multipart/form-data`), `timm`,
`transformers` y `peft` (los tres últimos los usan el Detector De Face Swap,
el Detector De Difusión Facial y la Sonda De Escena Generada). La descarga es
grande, principalmente por PyTorch y sus bibliotecas CUDA.

### 4. Descargar los pesos grandes

Los tres modelos de terceros (Face Swap, Difusión, Escena — ~2.7 GB en
total) **no se versionan en git** por el límite de 100 MB por archivo de
GitHub. Un script los descarga de sus fuentes oficiales y les aplica las
mismas conversiones documentadas:

```bash
python scripts/fetch_models.py
```

Es idempotente: lo ya descargado no se repite. El Detector De Síntesis GAN
(16 MB, entrenamiento propio) y el Detector Facial YuNet sí van en el
repositorio.

### 5. Arrancar el servidor

```bash
uvicorn app.main:app --reload
```

Queda escuchando en `http://127.0.0.1:8000`. Para exponerlo a otros equipos de
la red, añade `--host 0.0.0.0`.

### 6. Comprobar que responde

```bash
curl http://127.0.0.1:8000/            # → {"status":"ok"}
```

La documentación interactiva que genera FastAPI está en
`http://127.0.0.1:8000/docs` y permite probar `/predict` subiendo un archivo
desde el navegador.

**Prueba directa desde la terminal:**

```bash
curl -F "file=@../web/public/assets/muestras/sample-fake.jpg" http://127.0.0.1:8000/predict
```

---

## Puesta en marcha de la aplicación web

En **otra terminal**, con el backend ya en marcha:

```bash
cd web
npm install     # Astro y su cadena de construcción (~90 paquetes)
npm run dev
```

Queda servida en `http://localhost:4321`. Para abrirla también desde otros
equipos de la red (una tableta, otro portátil):

```bash
npm start       # equivale a: astro dev --host
```

> **Nota de seguridad del navegador:** el registro y el acceso del perito
> derivan la clave con Web Crypto, que los navegadores solo ofrecen en
> **contextos seguros** — `localhost` o `https://`. Si sirves el laboratorio
> por `http://` contra una IP de la red, el acceso se rechaza con un aviso
> explícito en lugar de degradarse a algo inseguro. Para uso en red, sirve la
> aplicación por HTTPS.

La URL del backend por defecto es `http://127.0.0.1:8000`. Se puede cambiar
desde el panel de configuración de la propia aplicación (`Ctrl/Cmd+,`) y queda
guardada en el navegador: **no hay archivos `.env`**.

### Uso

1. En la landing, pulsa **Iniciar peritaje**. La primera vez se registra el
   perfil del perito (credencial + clave de al menos 6 caracteres, guardadas
   solo en este navegador con hash PBKDF2); las siguientes veces se inicia
   sesión.
2. El laboratorio es un panel doble: a la **izquierda**, la cámara de
   evidencia con el material completo en su formato original (sin recortes),
   los controles y el registro de casos; a la **derecha**, el registro del
   análisis paso a paso y el dictamen. En pantallas estrechas las dos columnas
   se apilan en ese mismo orden. Arrastra un archivo, haz clic para abrir el
   selector del navegador, o usa las muestras de ejemplo.
3. Al incorporar el material se calcula su **huella SHA-256** y aparece el
   panel de **cadena de custodia**. Pega en él la huella que anotaste al
   recibir la evidencia: antes de cada análisis se recalcula sobre el archivo
   que se va a enviar y se contrasta. Si coinciden, el material es bit a bit
   el que se recibió; si no, el sistema **advierte pero no bloquea** — la
   discrepancia queda escrita en el registro y en el propio dictamen, y el
   perito decide. Sin huella de referencia el análisis sigue igual, con la
   integridad marcada como no verificada.
4. Pulsa **Ejecutar análisis**. Durante la inferencia, una línea de barrido
   recorre la vista previa y el registro muestra el progreso; al terminar,
   despliega cada etapa con sus datos reales — fotogramas, rostros, la señal
   de cada detector, los momentos sospechosos — y cierra con el dictamen.
5. El dictamen aparece como sello — **MANIPULADO** en naranja, **REAL** en
   moss o **INDICIOS** en ámbar — con su confianza y el desglose por modelo.
6. Bajo el dictamen aparece el **mapa de calor explicativo** (EigenCAM
   fusionado de todos los peritos): las zonas coloreadas son las regiones que
   sustentaron el veredicto, con la leyenda de ponderación por detector. El
   color va por intensidad en escala de riesgo — verde bajo, amarillo medio,
   naranja/rojo alto —, así que un material auténtico muestra zonas verdes.
   En video hay **un mapa por cada fotograma analizado**: debajo del grande
   se despliega la tira de los 24, cada uno con su segundo y su señal
   coloreada por riesgo, y el destacado (▸) es el de mayor señal. Clic en
   una miniatura —o `←` / `→`— para recorrerlos; clic en la imagen grande
   para ampliarla.
7. Si el dictamen queda en **INDICIOS**, se abre el **peritaje manual**: un
   checklist de seis observaciones (bordes del rostro, naturalidad de gestos,
   coherencia de iluminación, filtros, momentos sospechosos, origen del
   material) que respondes mirando la evidencia a la izquierda. Al emitir, el
   dictamen final combina tus respuestas con la señal de los modelos —la
   señal fuerte pesa doble— y queda asentado en el registro de casos como
   entrada de peritaje. Un empate técnico mantiene los INDICIOS.

El punto de color de la barra superior indica el estado del backend: moss en
línea, naranja fuera de línea, ámbar comprobando. Clic sobre el texto para
volver a comprobar.

### Atajos de teclado

| Atajo | Acción |
|---|---|
| `Ctrl/Cmd + O` | Abrir archivo |
| `Ctrl/Cmd + Enter` | Ejecutar análisis |
| `Alt + N` | Nuevo examen (limpiar la selección) |
| `Ctrl/Cmd + ,` | Configurar la URL del backend |
| `Ctrl/Cmd + Shift + L` | Cerrar sesión |
| `←` / `→` | Recorrer los mapas de calor de los fotogramas analizados |
| `Esc` | Cerrar el mapa de calor ampliado o el panel de configuración |

Sustituyen al menú de la aplicación de escritorio anterior. Se evitan a
propósito las combinaciones que el navegador reserva para sí (`Ctrl+R`
recarga la página), por eso «Nuevo examen» usa `Alt+N`.

---

## Construcción y despliegue

Desde `web/`:

| Comando | Resultado |
|---|---|
| `npm run dev` | Servidor de desarrollo con recarga en caliente (`:4321`) |
| `npm run build` | Sitio estático en `web/dist/` |
| `npm run preview` | Sirve lo construido, para comprobarlo antes de publicar |
| `npm run check` | Comprobación de tipos de todo el proyecto |

`npm run build` produce **HTML, CSS y JavaScript planos** en `web/dist/`: no
hay servidor de Node en producción. Basta con copiar esa carpeta a cualquier
alojamiento estático (Nginx, Apache, GitHub Pages, Netlify, Vercel, un
`python -m http.server` para una demostración) y el laboratorio funciona.

Ten en cuenta que lo publicado es **únicamente la interfaz**. El backend es un
proceso aparte que debe estar accesible desde el navegador del perito en la
URL configurada, sea en la máquina local o en un servidor remoto.

**Recomendaciones para una publicación real:**

- **Sírvelo por HTTPS.** Además de lo evidente, Web Crypto —y con ella el
  acceso del perito— solo está disponible en contextos seguros.
- Si el backend queda en otro origen, mantén su CORS abierto (ya lo está) o
  restringe `allow_origins` al dominio donde publiques la aplicación.
- Cabeceras de seguridad recomendadas en el servidor web:
  `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:;
  media-src 'self' blob:; connect-src *` (el `connect-src` abierto es
  necesario porque la URL del backend la decide el perito), más
  `X-Content-Type-Options: nosniff` y `Referrer-Policy: no-referrer`.

---

## El modelo en detalle

> 📋 **Referencia canónica:** [backend/models/README.md](backend/models/README.md)
> documenta el procedimiento completo de determinación paso a paso (con
> diagrama de flujo) y el catálogo de modelos con su Nombre Estándar.

El sistema usa **tres peritos faciales complementarios más una sonda de
escena** — cada uno especialista en una familia de manipulación — y el
veredicto lo decide el que más alarma levante, con la sonda como segunda
opinión sobre el encuadre completo:

| | Perito 1: síntesis GAN | Perito 2: face swap | Perito 3: difusión moderna | Sonda de escena |
|---|---|---|---|---|
| Arquitectura | EfficientNet-B0 (propio) | EfficientNet-B7 noisy-student | SigLIP2 base 512 | SigLIP2-SO400M + DINOv2-L (LoRA fusionado) |
| Entrenado sobre | 140k Real and Fake Faces (StyleGAN) | DFDC (face swap en video) | OpenDeepfake-Preview (rostros) | OpenFake (~100k imágenes generales, 25+ generadores) |
| Detecta | Rostros 100 % sintéticos (GAN clásica) | Caras intercambiadas en video | Generación por difusión en el rostro | Generación en el **encuadre completo** |
| Origen | Entrenamiento propio en Colab ([dataset en Kaggle](https://www.kaggle.com/datasets/xhlulu/140k-real-and-fake-faces)) | [Ganador del DFDC](https://github.com/selimsef/dfdc_deepfake_challenge) (MIT) | [prithivMLmods/deepfake-detector-model-v1](https://huggingface.co/prithivMLmods/deepfake-detector-model-v1) (Apache 2.0) | [Bombek1/ai-image-detector-siglip-dinov2](https://huggingface.co/Bombek1/ai-image-detector-siglip-dinov2) (MIT) |
| Pesos | `Detector_De_Sintesis_GAN.pth` (16 MB) | `Detector_De_Face_Swap.pth` (267 MB) | `Detector_De_Difusion_Facial/` (355 MB) | `Sonda_De_Escena_Generada/` (2 GB) |
| Entrada | 224×224, recorte facial | 380×380 isotrópico con relleno | 512×512 (processor propio) | 384/392, fotograma completo |

La sonda de escena es el modelo más caro (~27 s por imagen en CPU), así que
**solo se invoca para resolver ambigüedades** y sobre 2 fotogramas: cuando la
condena viene únicamente del detector de difusión (¿generación global o
filtro facial?) o cuando un veredicto «Real» arrastra señal de generación en
zona gris (¿generador reciente con firma atenuada?). Los casos claros no
pagan su coste. Sus pesos se convirtieron a solo-tensores y los LoRA se
fusionan en los backbones al cargar (equivalente en inferencia; la
cuantización int8 se probó y se descartó por degradar el resultado).

Los pesos del segundo modelo se convirtieron una única vez desde el
checkpoint del release oficial a un archivo de solo-tensores, para poder
cargarlos con el modo seguro (`weights_only`) de `torch.load`.

En video (24 fotogramas muestreados), cada modelo agrega según su naturaleza:
los de generación (GAN y difusión) usan la **mediana**, porque una cara
generada lo es en todos los fotogramas por igual — el valor central es el
representativo, y la mediana resiste la minoría de fotogramas atípicos en
ambas direcciones (picos de ruido en video auténtico, valles por desenfoque
en video generado). El de face swap usa el **segundo máximo**. La razón es forense: en un swap el rostro está intercambiado todo
el tiempo, pero los artefactos solo se ven en algunos fotogramas (pose,
expresión, iluminación) — los picos intermitentes son señal, no ruido, y un
promedio simple los diluye. El segundo máximo exige **dos detecciones
independientes**: un único pico (una oclusión o un desenfoque en un video
auténtico) se ignora por completo, pero dos fotogramas delatores condenan sin
dilución. La calibración salió de casos reales de ambas clases: sobre
material auténtico el B7 puntúa por debajo de 0.05 con notable consistencia,
mientras que el B0 sí produce picos aislados en fotogramas de video (está
fuera de su dominio ahí) — por eso solo el detector de face swap alimenta
`suspicious_seconds`, los fotogramas que superan 0.6 y que el perito debería
revisar a mano con su marca de tiempo.

### Arquitectura del perito 1

**EfficientNet-B0** adaptado a clasificación binaria. Se instancia con
`EfficientNet.from_name('efficientnet-b0', num_classes=2)`
(`backend/app/model.py`): `from_name` construye la arquitectura **sin**
descargar los pesos de ImageNet, porque a continuación se cargan los pesos
propios del entrenamiento.

- **4 052 175 parámetros** repartidos en 360 tensores.
- La capa final `_fc` es de `1280 → 2`: dos logits, uno por clase.
- Tamaño en disco: 16,3 MB.

### Entrenamiento

| Aspecto | Detalle |
|---|---|
| Dataset | [140k Real and Fake Faces](https://www.kaggle.com/datasets/xhlulu/140k-real-and-fake-faces) (Kaggle, de xhlulu) |
| Partición | 100 000 imágenes de entrenamiento / 20 000 de validación |
| Épocas | 3 |
| Precisión | ~99,7 % en entrenamiento |
| Entorno | Google Colab (GPU gratuita) |

Las imágenes falsas del dataset proceden de **StyleGAN**. Esto condiciona por
completo el alcance del modelo, como se explica en [limitaciones](#limitaciones-conocidas).

### Convención de clases

Este es el detalle más fácil de confundir al tocar el código:

| Índice | Clase |
|---|---|
| `0` | **Fake** (generado por IA) |
| `1` | **Real** |

Se deduce de dos puntos coherentes entre sí:

- `backend/app/model.py:30` — `label = "Real" if predicted_class.item() == 1 else "Fake"`
- `backend/app/model.py:45` — `probabilities[0][0]` se acumula como *fake score*,
  es decir, la probabilidad de la clase `0`.

### Preprocesamiento

Idéntico para imágenes y para cada fotograma de video (`backend/app/model.py:15`):

1. `Resize((224, 224))` — tamaño de entrada nativo de EfficientNet-B0.
2. `ToTensor()` — pasa a tensor y escala los valores a `[0, 1]`.
3. `Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])` — las
   estadísticas estándar de ImageNet, las mismas que se usaron al entrenar.

Cualquier cambio en estos valores invalida los pesos: el modelo espera
exactamente esta distribución de entrada.

---

## El backend en detalle

### `main.py` — enrutamiento

Define dos rutas:

- **`GET /`** — comprobación de salud. Devuelve `{"status": "ok"}` y es lo que
  consulta el indicador de estado del cliente.
- **`POST /predict`** — recibe el archivo y despacha según su tipo.

El despacho entre imagen y video se decide con el **`content_type` del archivo
subido** (`backend/app/main.py:25`):

```python
if file.content_type.startswith("video/"):
    frames = extract_frames(contents)
    result = predict_video(frames)
    ...
else:
    result = predict_image(contents)
```

Por eso la aplicación web se preocupa de enviar el MIME correcto: si un `.mp4`
llegara como `application/octet-stream`, el backend intentaría abrirlo como
imagen y fallaría. Como el navegador deja el tipo vacío en varios contenedores
de video, el MIME se deduce de la extensión con una tabla explícita del
dominio (`web/src/domain/evidence.ts`).

El middleware CORS está abierto a cualquier origen (`allow_origins=["*"]`) y
**es imprescindible**: la petición la origina el navegador del perito, que
suele estar en un origen distinto (`localhost:4321` → `127.0.0.1:8000`). Si se
publica el laboratorio en un dominio fijo, puede restringirse `allow_origins`
a ese dominio.

### `model.py` — orquestación de peritos y veredicto

Es el director del peritaje. Cada modelo vive en su propio módulo
(`faceswap_model.py`, `diffusion_model.py`, `scene_model.py`; el Detector De
Síntesis GAN, por herencia histórica, vive aquí mismo) y todos se cargan
**una sola vez al importar**, con `model.eval()` y toda la inferencia bajo
`torch.no_grad()`. Cada módulo gestiona su propio `device`: los detectores
por-fotograma suben a GPU si existe, y la Sonda De Escena comprueba la VRAM
libre antes de decidir (en GPUs de ~4 GiB se queda en CPU y cede la GPU a
quienes corren 24 veces por video).

`predict_image` y `predict_video` comparten el mismo esqueleto:

1. Recorte facial (YuNet) → los tres peritos faciales puntúan el recorte.
2. Agregación por familia (video): **mediana** para GAN y difusión, **segundo
   máximo** para face swap — la justificación forense de cada estadística
   está en [backend/models/README.md](backend/models/README.md), Paso 4.
3. Cascada de decisión: condena corroborada → `Fake`; condena solo por
   difusión → contraprueba con la Sonda De Escena (cuatro salidas, Paso 5);
   candidato a `Real` → verificación sistemática de escena; señal en zona
   gris → `Suspect`.
4. Mapa de calor explicativo (`explain.py`) sobre el fotograma más
   incriminatorio, dentro de un `try/except`: su fallo nunca afecta al
   veredicto.

Cada fotograma queda en el log con sus tres probabilidades (`p_gan`,
`p_swap`, `p_diff`), y la respuesta expone `frame_scores` (máximo por
fotograma) y los agregados por familia en `models` — la trazabilidad
completa de dónde salió el veredicto.

### `explain.py` — mapa de calor explicativo

Genera la evidencia visual del dictamen: **EigenCAM** (primer componente
principal de las activaciones, vía SVD, sin gradientes ni dependencias
externas) por cada perito que participó, fusionado por máximo ponderado y
superpuesto sobre el fotograma completo.

En video se produce **un mapa por cada fotograma analizado** (los 24), cada
uno con la señal de su propio instante, más el destacado (el de mayor señal,
el único que incorpora el CAM de la sonda de escena). Para que eso no cueste
una segunda pasada de inferencia, `FacialCapture` engancha las capas de
interés una sola vez y congela el EigenCAM de cada fotograma **mientras los
peritos puntúan**: lo que se guarda es una rejilla de 7×7, 12×12 o 14×14, y
el coste añadido es una SVD por fotograma.

Los detalles del método, los anclajes por arquitectura y la semántica de la
intensidad están en el Paso 7 de
[backend/models/README.md](backend/models/README.md); el contrato del campo
`explanation` está en la sección de la API.

### `preprocessing.py` — detección facial y extracción de fotogramas

**Recorte facial (`crop_largest_face`).** El modelo fue entrenado con rostros
alineados que ocupan todo el encuadre; pasarle un fotograma de video completo
—rostro pequeño más fondo— rompe esa distribución y el veredicto lo termina
dominando el fondo, no la cara. Por eso, antes de clasificar, se detecta el
rostro más grande con **YuNet** (`cv2.FaceDetectorYN`, modelo ONNX de
[opencv_zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) incluido en
`backend/models/`) y se recorta con un margen del 35 %. La función devuelve
`(imagen, encontrado, bbox)`: la caja en píxeles del encuadre original
permite reubicar el mapa de calor sobre el fotograma completo. Si no hay
rostro detectable se analiza la imagen completa como último recurso (bbox =
encuadre entero), se avisa en el log y `faces_detected` lo refleja en la
respuesta. Esto aplica tanto a imágenes como a cada fotograma de video.

**Extracción (`extract_frames`, hasta 24 fotogramas con marca de tiempo).** Escribe el video en un
archivo temporal **de nombre único** (dos peticiones simultáneas ya no se
pisan), que se elimina siempre en un `finally`. Muestrea a intervalos
regulares para cubrir todo el video:

```python
step = max(total_frames // max_frames, 1)
```

Cada fotograma se convierte de BGR (orden de canales de OpenCV) a RGB (el que
espera el modelo). Si OpenCV no puede abrir o decodificar el video —códec no
soportado—, devuelve una lista vacía y el endpoint responde **422** con la
causa, en lugar del veredicto sin sentido (o el error 500 por división entre
cero) que producía antes.

---

## La aplicación web en detalle

### Arquitectura hexagonal (puertos y adaptadores)

La aplicación está organizada en cuatro capas con una única regla: **las
dependencias apuntan siempre hacia dentro**. El dominio no sabe que existe un
navegador; los casos de uso no saben que existe HTTP; solo los adaptadores
conocen `fetch`, `localStorage` o el DOM.

| Capa | Carpeta | Qué contiene | Qué **no** puede importar |
|---|---|---|---|
| Dominio | `src/domain/` | Reglas del peritaje: dictámenes, admisión del material, checklist, credenciales | Nada. Es TypeScript puro |
| Aplicación | `src/application/` | Casos de uso y **puertos** (contratos) | Adaptadores concretos ni el DOM |
| Infraestructura | `src/infrastructure/` | **Adaptadores**: cliente HTTP, repositorios de navegador, criptografía, raíz de composición | La interfaz |
| Interfaz | `src/ui/` | Vistas `.astro`, controladores y presentadores | Adaptadores (solo casos de uso) |

Los alias de `tsconfig.json` (`@domain`, `@application`, `@infrastructure`,
`@ui`) hacen visible cada cruce de frontera de un vistazo.

**Recorrido de un análisis, capa a capa:**

```
ui/client/controllers/analysis.controller.ts   el perito pulsa "Ejecutar análisis"
        ↓ llama al caso de uso (no sabe cómo se envía)
application/use-cases/analyze-evidence.ts      recibe el puerto ForensicsApiPort
        ↓ el contenedor le inyectó el adaptador
infrastructure/http/http-forensics-api.ts      multipart/form-data → POST /predict
        ↓ devuelve un AnalysisResult del dominio
domain/analysis.ts + domain/verdict.ts         forma y vocabulario del dictamen
        ↓
ui/client/presenters/*.ts                      dictamen, mapa de calor, checklist
```

La ventaja práctica: la aritmética del peritaje manual, las reglas de
admisión del material y el vocabulario del dictamen se pueden probar sin
levantar un navegador, y sustituir `fetch` por otro transporte —o
`localStorage` por IndexedDB— es cambiar un archivo de `infrastructure/` y
una línea de `container.ts`.

### La raíz de composición

`src/infrastructure/container.ts` es el **único** sitio donde un adaptador se
enchufa a un puerto:

```ts
const settings = createLocalSettingsRepository();
// La API relee la URL en cada llamada: si el perito la cambia en el panel de
// configuración, la siguiente petición ya sale a la nueva.
const api = createHttpForensicsApi(() => settings.read().apiUrl);

return { analyzeEvidence: analyzeEvidence(api), /* … */ };
```

La interfaz recibe un objeto de casos de uso ya montados y nunca importa un
adaptador.

### Por qué las peticiones salen directamente del navegador

El material se envía como `multipart/form-data` desde el propio navegador del
perito: no hay servidor intermedio que lo reciba, lo copie ni lo registre. Eso
tiene tres consecuencias de diseño:

1. **CORS vuelve a intervenir** — por eso el backend lo mantiene abierto (ver
   `main.py`).
2. El **MIME se determina por extensión** con la tabla del dominio, no por lo
   que declare el navegador (que deja vacío el tipo de varios contenedores de
   video). Es justo lo que el backend necesita para distinguir imagen de video.
3. El adaptador HTTP es el **único** archivo del frontend que menciona rutas,
   verbos o códigos de estado.

La petición lleva un **tiempo límite de 3 minutos** vía `AbortController`,
holgado a propósito porque la inferencia en CPU sobre un video puede tardar
bastante; la comprobación de salud usa 5 segundos.

### Admisión del material

`inspectFile` (`src/domain/evidence.ts`) rechaza antes de enviar nada:

- extensiones fuera de la lista soportada (`.jpg`, `.jpeg`, `.png`, `.webp`,
  `.bmp`, `.gif`, `.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`);
- archivos de más de **10 MB**;
- archivos vacíos o ilegibles.

La misma función valida venga el archivo del selector, del arrastre o de las
muestras de demostración: hay un solo punto de entrada (`admitFile`).

### Cadena de custodia: la huella del material

Una evidencia sirve si se puede demostrar que es la misma que se recibió. Al
incorporar el material se calcula su **huella SHA-256** en el propio navegador
(`crypto.subtle.digest` sobre los bytes del archivo) y se muestra para que el
perito la anote en el acta. En el campo *huella registrada en la recepción* se
pega la del acta y, **antes de cada análisis, la huella se vuelve a calcular
sobre el archivo que se va a enviar** y se contrastan.

El resultado nunca detiene el análisis. Un perito puede querer examinar
material alterado precisamente porque está alterado; lo que el sistema debe
hacer es advertirlo y dejar constancia:

| Resultado | Qué hace el sistema |
|---|---|
| Coinciden | «COINCIDE» en moss y línea de verificación en el registro |
| No coinciden | «NO COINCIDE» en naranja, aviso emergente, línea de advertencia en el registro y **advertencia dentro del propio dictamen** — el análisis continúa |
| Sin huella de referencia | Se registra la huella calculada y se marca la integridad como no verificada |
| Huella ilegible o MD5 | Se dice por qué no se pudo comparar (MD5 no lo implementa Web Crypto) |

El algoritmo se deduce de la longitud de la huella declarada —40 dígitos es
SHA-1, 64 SHA-256, 96 SHA-384, 128 SHA-512—, así que sirve el acta que traiga
el caso sin configurar nada. La comparación normaliza mayúsculas, espacios y
prefijos del estilo `sha256:`, porque así es como aparecen en las actas
reales.

Igual que el acceso del perito, esto necesita **contexto seguro** (`localhost`
o HTTPS): si no lo hay, se dice con claridad en lugar de fingir una
comprobación que no se hizo.

### La vista previa

En el navegador los bytes ya están en el objeto `File` que entrega el usuario,
así que la vista previa es directa: `URL.createObjectURL(file)` produce un
Blob URL con el que el reproductor tiene duración, búsqueda y reproducción
nativas. Cada Blob URL se revoca al seleccionar otro archivo para no acumular
memoria. Esto sustituye a todo el puente de lectura de disco con autorización
por archivo que necesitaba la versión de escritorio: aquí la aplicación nunca
ve el sistema de archivos, solo el archivo que el perito le entrega.

El material se muestra **completo, en su relación de aspecto original** — sin
recortes: el perito debe ver el encuadre íntegro.

### Arrastrar y soltar

Se cancela el comportamiento por defecto de `dragover` y `drop` en toda la
ventana; sin ello, soltar un archivo haría que el navegador lo abriese y
abandonara el laboratorio. El archivo soltado llega por
`event.dataTransfer.files` y pasa por la misma admisión que los demás.

### Persistencia en el navegador

Los repositorios de `src/infrastructure/storage/` guardan:

| Clave | Almacén | Contenido |
|---|---|---|
| `certiface:settings` | `localStorage` | URL del backend |
| `certiface:history` | `localStorage` | Últimos cinco casos (nombre, dictamen, confianza) |
| `certiface:credential` | `localStorage` | Perfil del perito: credencial, sal y hash |
| `certiface:session` | `sessionStorage` | Sesión abierta |

La credencial persiste entre visitas, pero **la sesión vive solo mientras la
pestaña esté abierta**: cerrarla obliga a identificarse de nuevo, que es lo
prudente en un equipo compartido. El material analizado **nunca se guarda**.
Si el almacenamiento está bloqueado (modo privado), el laboratorio sigue
funcionando sin recordar nada entre visitas en lugar de fallar.

### El acceso del perito

El cliente de escritorio derivaba la clave con scrypt de Node. En el navegador
el equivalente disponible es **PBKDF2-SHA-256 con 210 000 iteraciones** sobre
Web Crypto, con sal aleatoria de 16 bytes y 64 bytes de salida; la comparación
recorre siempre la longitud completa, sin salir antes en la primera
diferencia. La clave nunca se guarda en claro y no hay servidor de identidad:
es un control de acceso al puesto de trabajo, no un sistema multiusuario.

Web Crypto solo existe en **contextos seguros**. Si el laboratorio se sirve por
`http://` contra una IP de red, el acceso se rechaza con un mensaje explícito
en lugar de recurrir a un hash débil.

### La interfaz y el diseño responsive

Astro genera un sitio estático: **no hay framework de interfaz en el
navegador**, solo el HTML de las tres vistas y los controladores en
TypeScript. Landing, login y laboratorio conviven en el mismo documento y un
enrutador mínimo alterna su atributo `hidden`, igual que en la versión de
escritorio.

La identidad visual es un sistema de tokens CSS: paleta fija en modo oscuro,
con el color siempre semántico (naranja = manipulación, moss = autenticidad).
Las tipografías se sirven desde la propia aplicación como `@font-face`, así
que no depende de ninguna red externa. Los márgenes laterales son fluidos
(`clamp`), y los cortes son estos:

| Ancho | Qué cambia |
|---|---|
| ≥ 1500 px | El banco de trabajo se ensancha a 1560 px |
| ≤ 1020 px | El laboratorio pasa de dos columnas a una |
| ≤ 900 px | El hero se apila; la ficha del protocolo pierde la columna de nota |
| ≤ 720 px | La barra de estado salta a su propia línea, el dictamen apila sello y datos, los paneles pierden relleno y los botones ocupan el ancho |
| ≤ 420 px | Se oculta la etiqueta `LAB·PERICIAL`, se compacta el registro y las opciones del checklist se reparten el ancho |

Los campos de texto usan 16 px para que Safari en iOS no acerque la página al
enfocarlos, y las animaciones de barrido respetan `prefers-reduced-motion`.

---

## Contrato de la API

### `GET /`

```json
{ "status": "ok" }
```

### `POST /predict`

Cuerpo `multipart/form-data` con un único campo `file`.

**Respuesta para imagen:**

```json
{
  "prediction": "Fake",
  "confidence": 98.42,
  "faces_detected": 1,
  "models": { "synthesis_gan": 0.9842, "faceswap_dfdc": 0.1201, "diffusion_modern": 0.0512 }
}
```

**Respuesta para video:**

```json
{
  "prediction": "Fake",
  "confidence": 91.3,
  "frames_analyzed": 10,
  "faces_detected": 9,
  "frame_scores": [0.12, 0.88, 0.95, 0.11, 0.09, 0.91, 0.9, 0.2, 0.93, 0.17],
  "suspicious_seconds": [{ "second": 2.4, "score": 0.9782 }, { "second": 4.1, "score": 0.695 }],
  "models": { "synthesis_gan": 0.0312, "faceswap_dfdc": 0.913, "diffusion_modern": 0.0421 },
  "explanation": {
    "image": "data:image/jpeg;base64,…",
    "second": 2.4,
    "weights": { "synthesis_gan": 0.031, "faceswap_dfdc": 0.978, "diffusion_modern": 0.042 },
    "width": 720,
    "height": 405,
    "featured_index": 11,
    "frames": [
      {
        "index": 0,
        "second": 0.0,
        "signal": 0.1204,
        "image": "data:image/jpeg;base64,…",
        "weights": { "synthesis_gan": 0.02, "faceswap_dfdc": 0.12, "diffusion_modern": 0.03 },
        "width": 640,
        "height": 360
      }
    ]
  }
}
```

`explanation` es opcional y aditivo: el **mapa de calor explicativo**
(EigenCAM fusionado por máximo ponderado de todos los peritos que
participaron) superpuesto sobre el fotograma de mayor señal (`second`;
`null` en imágenes), como data URI JPEG con lado mayor ≤ 720 px. `weights`
son las señales por-fotograma que ponderaron la fusión.

En video, `frames` trae **un mapa por cada fotograma analizado** (los 24),
cada uno con su `index` en la secuencia, su `second`, su `signal` (la mayor
de sus tres señales, la que fija su color dominante) y las `weights` de ese
instante concreto, con lado mayor ≤ 640 px. `featured_index` señala cuál de
ellos es el destacado. En imágenes `frames` no aparece: solo hay un mapa. Si
el cálculo falla —de un fotograma o de todos— el campo o la entrada
simplemente no aparecen: el veredicto nunca depende de ellos.

Una respuesta de video con los 24 mapas pesa del orden de **1–3 MB**. Es el
precio de que el dictamen viaje con su evidencia visual completa.

`prediction` es la cadena `"Real"`, `"Fake"` o `"Suspect"`, y `confidence` un
porcentaje entre 0 y 100 redondeado a dos decimales.

**Dictamen con reserva (`"Suspect"`) y contraprueba de contexto:** cuando el
único perito que condena es el detector de difusión y los otros dos están
limpios (< 0.3), el sistema ejecuta una **contraprueba de contexto**: vuelve a
analizar los encuadres completos (solo aquellos donde el rostro ocupa menos de
la mitad del fotograma, mínimo 6 en video). El fundamento forense: un filtro
de embellecimiento actúa sobre el rostro, pero la generación por difusión
fabrica el encuadre entero — fondo incluido.

- Firma también en el entorno (mediana > 0.5) → **`"Fake"` pleno**: generación
  global confirmada. El valor aparece como `models.scene_generated` y la
  interfaz lo muestra como «ESCENA».
- Firma solo en el rostro → **`"Suspect"`** con `caveat`: patrón compatible
  con filtros o procesado de cámara sobre material auténtico.
- Sin encuadres contrastables (primer plano) → **`"Suspect"`** prudente.

La reserva existe porque la clase de falsos positivos del detector está
verificada empíricamente: un video auténtico con filtros llegó a puntuar por
encima de uno genuinamente generado. La interfaz muestra `"Suspect"` como
sello **INDICIOS** en ámbar con borde discontinuo, la etiqueta «Señal de
generación» en lugar de «Confianza», y la nota de reserva. Las condenas por
face swap o GAN siguen saliendo como `"Fake"` pleno.

**Verificación de todo veredicto `"Real"`:** antes de certificar, la sonda
de escena examina el encuadre completo como segunda opinión sistemática —
un generador reciente llegó a dejar el rostro casi limpio (señal facial
0.13, por debajo del real más alto observado) y solo el encuadre podía
delatarlo. Escena > 0.75 → condena plena (listón alto: la sonda condena en
solitario y su ruido sobre material auténtico llega casi a 0.5); escena
≥ 0.55 o señal facial en zona gris (0.25–0.5, donde los generadores
recientes han puntuado 0.27 y 0.34) → `"Suspect"` con peritaje manual;
escena limpia y señal facial baja → `"Real"` verificado, con la lectura
registrada en `models.scene_generated` como evidencia positiva. En primeros planos la
sonda examina el fotograma tal cual — la opinión de un modelo independiente
sobre el mismo contenido, no una lectura de entorno.

**Lenguaje del dictamen:** el veredicto `"Real"` se muestra como **REAL**; el
porcentaje de confianza que lo acompaña es el que orienta la decisión del
perito, y la zona gris garantiza que una señal de generación sin explicar
nunca llega a este sello. `faces_detected` indica en
cuántos fotogramas (o en la imagen) se pudo recortar un rostro; si es 0, el
veredicto se emitió sobre el encuadre completo y la aplicación lo advierte.
`frame_scores` es, por fotograma, la mayor probabilidad de manipulación entre
los peritos faciales. `models` desglosa la puntuación agregada de cada uno:
`synthesis_gan`, `faceswap_dfdc`, `diffusion_modern` y, cuando la sonda
participó, `scene_generated`; el veredicto lo decide la señal más alta, con
las reglas de reserva y verificación descritas arriba.

**Errores:** si el video no se puede decodificar (códec no soportado), el
endpoint responde `422` con un campo `detail` que explica la causa; la
aplicación web muestra ese mensaje tal cual en el registro del análisis.

---

## Limitaciones conocidas

- **Generalización.** Cada perito conoce su familia: el B0 la síntesis
  StyleGAN, el B7 el face swap del dataset DFDC (2020), el SigLIP2 la
  generación moderna por difusión. Manipulaciones de familias que ninguno vio
  en entrenamiento —face swap comercial de última generación, reenactment,
  generadores futuros— pueden escapar a los tres. Es la carrera
  armamentística documentada del campo, no una peculiaridad de este proyecto;
  la aplicación muestra este aviso junto a cada resultado.
- **El modelo espera rostros.** Fue entrenado con un dataset de caras. El
  detector YuNet recorta el rostro antes de clasificar; si no encuentra
  ninguno, el sistema analiza el encuadre completo, lo advierte y marca
  `faces_detected: 0` — ese veredicto no es significativo.
- **Muestreo de video limitado.** Se examinan hasta 24 fotogramas repartidos,
  no todos. La agregación top-3 está pensada para que los artefactos
  intermitentes no se diluyan; aun así, `frame_scores` y
  `suspicious_seconds` permiten auditar de dónde salió cada veredicto.
- **Sensibilidad a la compresión.** Recompresiones fuertes del video alteran
  los artefactos que el modelo usa como señal y pueden sesgar el veredicto en
  cualquier dirección.
- **Arranques en frío.** Si el backend se despliega en un plan gratuito que
  suspende el servicio por inactividad, la primera petición puede tardar entre
  30 y 60 segundos.

---

## Resolución de problemas

| Síntoma | Causa y solución |
|---|---|
| `FileNotFoundError: models/Detector_De_Sintesis_GAN.pth` | Lanzaste `uvicorn` desde otro directorio. Hazlo desde `backend/`. |
| `Form data requires "python-multipart"` | Falta esa dependencia: `pip install -r requirements.txt`. |
| La barra de estado dice «Backend fuera de línea» | El backend no está arrancado, o la URL configurada no coincide. Verifica con `curl http://127.0.0.1:8000/` y revísala en `Ctrl/Cmd+,`. |
| El acceso —o la verificación de integridad— dice que el navegador no ofrece criptografía segura | Estás sirviendo el laboratorio por `http://` contra una IP. Web Crypto solo existe en contextos seguros: usa `localhost` o publica por HTTPS. |
| La huella no coincide y el material parece el mismo | Comprueba que el acta registre la huella del **archivo original** y no la de una copia recomprimida (WhatsApp, exportaciones de edición y algunas descargas re-codifican el video y cambian todos sus bits). El aviso es correcto: ese archivo no es el que se recibió. |
| El panel de custodia no aparece | Solo se muestra con material cargado. Si aparece pero la huella dice «no disponible», es el contexto inseguro de la fila anterior. |
| «Failed to fetch» al analizar, con el backend en marcha | El navegador bloqueó la petición por CORS o por contenido mixto (página HTTPS llamando a un backend HTTP). Revisa `allow_origins` en `backend/app/main.py` y sirve ambos por el mismo esquema. |
| Un video se analiza como si fuera imagen | La extensión no está en la tabla de MIME de `web/src/domain/evidence.ts`. Añádela allí. |
| Todo video da el mismo veredicto | Revisa el log del backend: `faces_detected` por fotograma y los `p_fake` individuales dicen si el detector encuentra el rostro y cómo puntúa cada fotograma. Si `rostro=no` en todos, el material no tiene caras detectables de frente. |
| El video no se puede decodificar (HTTP 422) | El códec no lo soporta OpenCV. Recodifica a MP4/H.264, por ejemplo: `ffmpeg -i entrada -c:v libx264 -crf 23 salida.mp4`. |
| El análisis de un video se agota por tiempo | En CPU los tres peritos faciales suman ~2 s por fotograma (~45–55 s por video), más la sonda de escena (~30 s por sonda) cuando el caso la requiere y ~2–5 s del mapa de calor. Si se agota, sube `PREDICT_TIMEOUT_MS` en `web/src/infrastructure/http/http-forensics-api.ts` o reduce `max_frames` en `extract_frames`. |
| La vista previa aparece en blanco | El formato del contenedor de video no lo soporta el navegador (por ejemplo, ciertos `.mkv`). El análisis sigue funcionando: la vista previa y la inferencia son independientes. |
