# 🔍 CertiFace — Peritaje de Medios Digitales

Sistema pericial para casos de **suplantación de identidad** (face swap y
deepfake), compuesto por una **API de inferencia en FastAPI** y una **aplicación
de escritorio multiplataforma en Electron**. El perito incorpora una imagen o un
video con un rostro y el sistema emite un dictamen preliminar — **auténtico** o
**manipulado** — con su confianza porcentual.

La aplicación tiene tres pantallas: una **landing** de presentación, un **login
local** (perfil de perito con clave protegida por scrypt, sin servidor de
identidad) y el **laboratorio** de análisis. La identidad visual usa una paleta
de negros cálidos, naranja (`#EB4604`, manipulación/alerta) y verde moss
(`#99A57D`, autenticidad), con tipografías Chakra Petch e IBM Plex empaquetadas
en la aplicación.

**Autoría:** Alyce Maldonado

---

## Tabla de contenidos

1. [Arquitectura general](#arquitectura-general)
2. [Requisitos previos](#requisitos-previos)
3. [Puesta en marcha del backend](#puesta-en-marcha-del-backend)
4. [Puesta en marcha del cliente de escritorio](#puesta-en-marcha-del-cliente-de-escritorio)
5. [Empaquetado para distribución](#empaquetado-para-distribución)
6. [El modelo en detalle](#el-modelo-en-detalle)
7. [El backend en detalle](#el-backend-en-detalle)
8. [El cliente de escritorio en detalle](#el-cliente-de-escritorio-en-detalle)
9. [Contrato de la API](#contrato-de-la-api)
10. [Limitaciones conocidas](#limitaciones-conocidas)
11. [Resolución de problemas](#resolución-de-problemas)

---

## Arquitectura general

Son **dos procesos independientes** que se comunican por HTTP. El backend no
sirve la interfaz: solo expone la API de inferencia.

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  Aplicación de escritorio   │         │       Backend FastAPI        │
│         (Electron)          │         │        (Python/PyTorch)      │
│                             │         │                              │
│  ┌───────────────────────┐  │         │  ┌────────────────────────┐  │
│  │ Renderer (interfaz)   │  │         │  │ main.py    rutas HTTP  │  │
│  │ HTML · CSS · JS       │  │         │  └───────────┬────────────┘  │
│  └──────────┬────────────┘  │         │              │               │
│             │ IPC           │         │   ┌──────────┴──────────┐    │
│  ┌──────────┴────────────┐  │  HTTP   │   │ preprocessing.py    │    │
│  │ Proceso principal     │──┼────────►│   │ (fotogramas, OpenCV)│    │
│  │ lectura de disco,     │  │  POST   │   └──────────┬──────────┘    │
│  │ peticiones, ajustes   │◄─┼─────────│   ┌──────────┴──────────┐    │
│  └───────────────────────┘  │  JSON   │   │ model.py            │    │
│                             │         │   │ EfficientNet-B0     │    │
└─────────────────────────────┘         │   └─────────────────────┘    │
                                        └──────────────────────────────┘
```

**Estructura del repositorio:**

```
deepfakeSistem/
├── backend/
│   ├── app/
│   │   ├── main.py            # Rutas HTTP y despacho imagen/video
│   │   ├── model.py           # Carga del modelo e inferencia
│   │   ├── preprocessing.py   # Extracción de fotogramas con OpenCV
│   │   └── schemas.py         # (vacío, reservado para modelos Pydantic)
│   ├── models/                # Ver models/README.md (catálogo y procedimiento)
│   │   ├── Detector_Facial_YuNet.onnx    # Recorte facial (227 KB)
│   │   ├── Detector_De_Sintesis_GAN.pth  # Perito 1: síntesis GAN (16 MB)
│   │   ├── Detector_De_Face_Swap.pth     # Perito 2: face swap, DFDC (267 MB)
│   │   ├── Detector_De_Difusion_Facial/  # Perito 3: difusión moderna (355 MB)
│   │   └── Sonda_De_Escena_Generada/     # Sonda de encuadre completo (2 GB)
│   └── requirements.txt
└── desktop/
    ├── src/
    │   ├── main/              # Proceso principal de Electron (Node.js)
    │   │   ├── main.js        # Ventana y canales IPC
    │   │   ├── api.js         # Validación de archivos y llamadas HTTP
    │   │   ├── auth.js        # Perfil local del perito (scrypt)
    │   │   ├── store.js       # Ajustes, sesión e historial persistentes
    │   │   ├── menu.js        # Menú nativo y atajos de teclado
    │   │   └── preload.js     # Puente seguro hacia la interfaz
    │   └── renderer/          # Interfaz (sin framework ni bundler)
    │       ├── index.html     # Tres vistas: landing, login, laboratorio
    │       ├── styles.css     # Sistema de tokens de la identidad CertiFace
    │       └── renderer.js
    ├── assets/
    │   ├── fonts/             # Chakra Petch + IBM Plex (OFL, empaquetadas)
    │   ├── art/reticle.svg    # Retícula pericial (generada)
    │   └── sample-*.jpg       # Muestras de ejemplo
    ├── build/icon.png         # Icono de la aplicación
    └── package.json           # Objetivos de electron-builder
```

---

## Requisitos previos

| Componente | Requisito | Comprobación |
|---|---|---|
| Backend | Python 3.10 o superior | `python3 --version` |
| Cliente | Node.js 22.12 o superior (lo exige Electron 43) | `node --version` |
| Cliente | npm | `npm --version` |

No hace falta GPU: si no se detecta CUDA, PyTorch usa la CPU automáticamente
(`backend/app/model.py:9`). Tampoco hace falta entrenar nada, porque los pesos
ya están en el repositorio.

---

## Puesta en marcha del backend

> **Importante:** `uvicorn` debe lanzarse **desde el directorio `backend/`**.
> El modelo se carga con la ruta relativa `models/Detector_De_Sintesis_GAN.pth`
> (`backend/app/model.py:11`) y el video temporal también se escribe en el
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

Son ocho paquetes directos: `fastapi`, `uvicorn[standard]`, `torch`,
`torchvision`, `efficientnet-pytorch`, `pillow`, `opencv-python-headless` y
`python-multipart` (este último es obligatorio para recibir `multipart/form-data`).
La descarga es grande, principalmente por PyTorch y sus bibliotecas CUDA.

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
curl -F "file=@../desktop/assets/sample-fake.jpg" http://127.0.0.1:8000/predict
```

---

## Puesta en marcha del cliente de escritorio

En **otra terminal**, con el backend ya en marcha:

```bash
cd desktop
npm install     # dependencias + binario de Electron (~150 MB)
npm start
```

Para abrir además las herramientas de desarrollo:

```bash
npm run dev
```

La URL del backend por defecto es `http://127.0.0.1:8000`. Se puede cambiar
desde el panel de configuración de la propia aplicación (`Ctrl/Cmd+,`) y queda
guardada entre sesiones: **no hay archivos `.env`**.

### Uso

1. En la landing, pulsa **Iniciar peritaje**. La primera vez se registra el
   perfil del perito (credencial + clave de al menos 6 caracteres, guardadas
   solo en este equipo con hash scrypt); las siguientes veces se inicia sesión.
2. En el laboratorio, arrastra un archivo a la cámara de evidencia, haz clic
   para abrir el diálogo del sistema, o usa las muestras de ejemplo.
3. Pulsa **Ejecutar análisis**. Durante la inferencia, una línea de barrido
   recorre la vista previa.
4. El dictamen aparece como sello — **MANIPULADO** en naranja o **AUTÉNTICO**
   en moss — con su confianza y, en videos, los fotogramas analizados.

El punto de color de la barra superior indica el estado del backend: moss en
línea, naranja fuera de línea, ámbar comprobando. Clic sobre el texto para
volver a comprobar.

### Atajos de teclado

| Atajo | Acción |
|---|---|
| `Ctrl/Cmd + O` | Abrir archivo |
| `Ctrl/Cmd + Enter` | Ejecutar análisis |
| `Ctrl/Cmd + R` | Limpiar la selección |
| `Ctrl/Cmd + ,` | Configurar la URL del backend |
| `Ctrl/Cmd + Shift + L` | Cerrar sesión |

---

## Empaquetado para distribución

Desde `desktop/`:

| Comando | Resultado |
|---|---|
| `npm run pack` | Carpeta sin empaquetar en `dist/` (para probar) |
| `npm run dist:linux` | `AppImage` + `.deb` |
| `npm run dist:win` | Instalador `NSIS` + ejecutable portable |
| `npm run dist:mac` | `.dmg` + `.zip` |
| `npm run dist` | Los objetivos del sistema anfitrión |

Los artefactos se generan en `desktop/dist/`.

**Sobre la compilación cruzada:**

- Linux → Windows funciona si tienes `wine` instalado.
- **Los paquetes de macOS solo pueden generarse desde macOS**, porque el
  firmado y la creación del `.dmg` dependen de herramientas propias del sistema.

Ten en cuenta que el paquete resultante contiene **únicamente el cliente**. El
backend es un proceso aparte que debe estar accesible en la URL configurada,
sea en la máquina local o en un servidor remoto.

---

## El modelo en detalle

> 📋 **Referencia canónica:** [backend/models/README.md](backend/models/README.md)
> documenta el procedimiento completo de determinación paso a paso (con
> diagrama de flujo) y el catálogo de modelos con su Nombre Estándar.

El sistema usa **tres modelos complementarios** — tres peritos, cada uno
especialista en una familia de manipulación — y el veredicto lo decide el que
más alarma levante:

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
(`backend/app/model.py:10`): `from_name` construye la arquitectura **sin**
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

Por eso el cliente se preocupa de enviar el MIME correcto: si un `.mp4` llegara
como `application/octet-stream`, el backend intentaría abrirlo como imagen y
fallaría.

El middleware CORS está abierto a cualquier origen (`allow_origins=["*"]`), algo
heredado de la etapa en que el frontend era una página web. Con el cliente de
escritorio ya no interviene, porque la petición sale de Node y no de un
navegador.

### `model.py` — inferencia

El modelo se carga **una sola vez al importar el módulo**, no en cada petición:
`load_state_dict`, traslado al dispositivo y `model.eval()` para desactivar
*dropout* y fijar las capas de *batch normalization*. Toda la inferencia va
dentro de `torch.no_grad()`, que evita construir el grafo de gradientes.

Las dos funciones difieren en cómo calculan la confianza:

**`predict_image`** — un solo paso hacia delante. Aplica `softmax` sobre los dos
logits y toma el máximo: gana la clase con mayor probabilidad y esa misma
probabilidad es la confianza.

```python
probabilities = torch.softmax(outputs, dim=1)
confidence, predicted_class = torch.max(probabilities, dim=1)
```

**`predict_video`** — clasifica cada fotograma por separado, guarda la
probabilidad de la clase *fake* y **promedia**. La decisión se toma sobre ese
promedio con umbral 0,5:

```python
avg_fake_score = sum(fake_scores) / len(fake_scores)
label = "Fake" if avg_fake_score > 0.5 else "Real"
confidence = avg_fake_score if label == "Fake" else 1 - avg_fake_score
```

Promediar probabilidades en lugar de votar por mayoría hace que un fotograma
muy dudoso pese lo mismo que uno muy claro; es una decisión de diseño
deliberadamente simple. Cada fotograma queda registrado en el log con su
probabilidad individual (`frame_scores` en la respuesta), lo que permite ver si
un veredicto salió de fotogramas homogéneos o de una mezcla dudosa.

### `preprocessing.py` — detección facial y extracción de fotogramas

**Recorte facial (`crop_largest_face`).** El modelo fue entrenado con rostros
alineados que ocupan todo el encuadre; pasarle un fotograma de video completo
—rostro pequeño más fondo— rompe esa distribución y el veredicto lo termina
dominando el fondo, no la cara. Por eso, antes de clasificar, se detecta el
rostro más grande con **YuNet** (`cv2.FaceDetectorYN`, modelo ONNX de
[opencv_zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) incluido en
`backend/models/`) y se recorta con un margen del 35 %. Si no hay rostro
detectable se analiza la imagen completa como último recurso, se avisa en el
log y `faces_detected` lo refleja en la respuesta. Esto aplica tanto a
imágenes como a cada fotograma de video.

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

## El cliente de escritorio en detalle

### Los dos procesos de Electron

Electron separa el **proceso principal** (Node.js completo: disco, red, ventanas)
del **renderer** (la interfaz, en un contexto de navegador). Aquí esa separación
se respeta de forma estricta:

- El renderer **no** tiene acceso a Node (`nodeIntegration: false`) ni comparte
  contexto con el preload (`contextIsolation: true`).
- Toda comunicación pasa por los canales IPC declarados uno a uno en
  `preload.js`. La interfaz solo ve las funciones expuestas en `window.api`.

### Por qué las peticiones HTTP salen del proceso principal

`src/main/api.js` lee el archivo del disco con `fs`, lo envuelve en un `Blob`
con su MIME correcto y lo envía como `multipart/form-data`:

```js
const form = new FormData();
form.append("file", new Blob([buffer], { type: mime }), name);
```

Hacerlo aquí y no en la interfaz tiene tres ventajas concretas:

1. **CORS deja de intervenir**, porque la petición no la origina un contexto de
   navegador.
2. El **MIME se determina por extensión** con una tabla explícita, en vez de
   depender de lo que el sistema operativo declare. Es justo lo que el backend
   necesita para distinguir imagen de video.
3. La interfaz nunca manipula rutas ni contenidos del disco.

La petición lleva un **tiempo límite de 3 minutos** vía `AbortController`, holgado
a propósito porque la inferencia en CPU sobre un video puede tardar bastante.

### Validación de archivos

`inspectFile` (`src/main/api.js`) rechaza antes de enviar nada:

- extensiones fuera de la lista soportada (`.jpg`, `.png`, `.webp`, `.bmp`,
  `.gif`, `.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`);
- archivos de más de **10 MB**;
- rutas que no correspondan a un archivo real.

### La vista previa: Blob URL con autorización por archivo

Para mostrar la vista previa, la interfaz necesita leer un archivo del disco,
pero darle acceso libre al sistema de archivos sería un riesgo innecesario. El
canal IPC `file:preview` entrega los bytes **solo del archivo seleccionado en
ese momento**, comprobando cada petición contra una lista de rutas
autorizadas que se vacía en cada selección:

```js
if (!allowedPreviewPaths.has(normalized)) {
  return { ok: false, error: "Archivo no autorizado para vista previa." };
}
```

El renderer convierte esos bytes en un **Blob URL**
(`URL.createObjectURL`), con el que el reproductor de Chromium tiene
duración, búsqueda y reproducción nativas sin protocolo HTTP de por medio.
Cargar el archivo en memoria es viable porque la validación previa lo acota
a 10 MB, y cada Blob URL se revoca al seleccionar otro archivo. (Una versión
anterior servía la vista previa con un protocolo `media://` propio con
soporte de rangos; el stack de medios de Chromium resultó poco fiable sobre
él y se sustituyó por esta vía más simple.)

### Arrastrar y soltar

Desde Electron 32 el objeto `File` **ya no expone `.path`**. La vía soportada es
`webUtils.getPathForFile(file)`, que solo puede invocarse desde el preload
(`src/main/preload.js`). Además se cancela el comportamiento por defecto de
`dragover` y `drop` en toda la ventana; sin ello, soltar un archivo haría que la
ventana navegase hacia él y la aplicación desaparecería.

### Persistencia

`src/main/store.js` guarda un `settings.json` en el directorio de datos de
usuario que da el sistema operativo (`app.getPath("userData")`):

| Sistema | Ruta |
|---|---|
| Linux | `~/.config/Deepfake Detector/settings.json` |
| Windows | `%APPDATA%\Deepfake Detector\settings.json` |
| macOS | `~/Library/Application Support/Deepfake Detector/settings.json` |

Contiene la URL del backend, el historial de los últimos cinco análisis, el
perfil del perito (credencial, sal y hash scrypt de la clave — nunca la clave en
claro) y el estado de la sesión. Si el archivo no existe o está corrupto, se
vuelve a los valores por defecto sin fallar.

### La interfaz

Sin framework y sin paso de compilación: `index.html`, `styles.css` y
`renderer.js` planos. Las tres vistas (landing, login, laboratorio) conviven en
el mismo documento y un enrutador mínimo alterna su atributo `hidden`. La
identidad visual es un sistema de tokens CSS: paleta fija en modo oscuro, con el
color siempre semántico (naranja = manipulación, moss = autenticidad). Las
tipografías van empaquetadas como `@font-face`, así que la aplicación no
depende de la red para nada salvo el backend. La política de seguridad de
contenido declarada en el `<head>` prohíbe todo por defecto y solo permite
recursos propios y los Blob URL de la vista previa. La animación de barrido
respeta
`prefers-reduced-motion`.

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
  "models": { "synthesis_gan": 0.0312, "faceswap_dfdc": 0.913, "diffusion_modern": 0.0421 }
}
```

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

**Zona gris:** un `"Real"` cuya señal de generación queda entre 0.3 y 0.5
dispara la sonda de escena. Si el encuadre completo también delata generación
(> 0.5), la firma débil queda corroborada y la condena es plena (`"Fake"`,
con `models.scene_generated`); si no, el resultado queda en `"Suspect"`
(inconcluso). El rango sale de datos: el material auténtico limpio observado
puntúa ≤ ~0.2, pero un video 100 % generado con un generador reciente llegó a
puntuar solo 0.34 — en esa franja el sistema nunca certifica nada por sí
solo.

**Lenguaje del dictamen:** el veredicto `"Real"` se muestra como **REAL**; el
porcentaje de confianza que lo acompaña es el que orienta la decisión del
perito, y la zona gris garantiza que una señal de generación sin explicar
nunca llega a este sello. `faces_detected` indica en
cuántos fotogramas (o en la imagen) se pudo recortar un rostro; si es 0, el
veredicto se emitió sobre el encuadre completo y la aplicación lo advierte.
`frame_scores` es, por fotograma, la mayor probabilidad de manipulación entre
los dos modelos. `models` desglosa la puntuación agregada de cada perito:
`synthesis_gan` (síntesis tipo StyleGAN) y `faceswap_dfdc` (face swap); el
veredicto lo decide el más alto de los dos.

**Errores:** si el video no se puede decodificar (códec no soportado), el
endpoint responde `422` con un campo `detail` que explica la causa; la
aplicación de escritorio muestra ese mensaje tal cual.

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
| La app dice «Backend no disponible» | El backend no está arrancado, o la URL configurada no coincide. Verifica con `curl http://127.0.0.1:8000/` y revísala en `Ctrl/Cmd+,`. |
| `Error: Electron failed to install correctly` | El binario no se descargó. Ejecuta `npx install-electron` dentro de `desktop/`. |
| Un video se analiza como si fuera imagen | La extensión no está en la tabla de MIME de `src/main/api.js`. Añádela allí. |
| Todo video da el mismo veredicto | Revisa el log del backend: `faces_detected` por fotograma y los `p_fake` individuales dicen si el detector encuentra el rostro y cómo puntúa cada fotograma. Si `rostro=no` en todos, el material no tiene caras detectables de frente. |
| El video no se puede decodificar (HTTP 422) | El códec no lo soporta OpenCV. Recodifica a MP4/H.264, por ejemplo: `ffmpeg -i entrada -c:v libx264 -crf 23 salida.mp4`. |
| El análisis de un video se agota por tiempo | En CPU los tres modelos suman ~2 s por fotograma (~45–55 s por video). Si aun así se agota, sube el límite en la llamada a `predict` de `src/main/api.js` o reduce `max_frames` en `extract_frames`. |
| La vista previa aparece en blanco | El formato del contenedor de video no lo soporta Chromium (por ejemplo, ciertos `.mkv`). El análisis sigue funcionando: la vista previa y la inferencia son independientes. |
