# Modelos Y Procedimiento De Determinación

Este documento describe, paso a paso, cómo CertiFace determina si un video (o
una imagen) es **real** o **falso**, y cataloga cada modelo de este
directorio con su **Nombre Estándar** — formato de escritura con mayúscula
inicial en cada palabra — que es la forma canónica de referirse a ellos en
documentación, informes periciales y comunicación del equipo.

---

## Catálogo De Modelos

| Nombre Estándar | Archivo | Arquitectura | Entrenado Sobre | Función | Licencia |
|---|---|---|---|---|---|
| **Detector Facial YuNet** | `Detector_Facial_YuNet.onnx` (227 KB) | YuNet (DNN, ONNX) | Rostros en contexto general | Localiza y recorta el rostro más grande de cada fotograma | MIT |
| **Detector De Síntesis GAN** | `Detector_De_Sintesis_GAN.pth` (16 MB) | EfficientNet-B0 | 140k Real and Fake Faces (StyleGAN) | Reconoce rostros 100 % sintéticos de GAN clásica | Propio |
| **Detector De Face Swap** | `Detector_De_Face_Swap.pth` (267 MB) | EfficientNet-B7 noisy-student | DFDC — Deepfake Detection Challenge | Reconoce caras intercambiadas en video | MIT ([ganador del DFDC](https://github.com/selimsef/dfdc_deepfake_challenge)) |
| **Detector De Difusión Facial** | `Detector_De_Difusion_Facial/` (355 MB) | SigLIP2 base, 512 px | OpenDeepfake-Preview (rostros de generación moderna) | Reconoce rostros generados por difusión | Apache 2.0 ([origen](https://huggingface.co/prithivMLmods/deepfake-detector-model-v1)) |
| **Sonda De Escena Generada** | `Sonda_De_Escena_Generada/` (2 GB) | SigLIP2-SO400M + DINOv2-L (LoRA fusionado) | OpenFake — ~100k imágenes generales, 25+ generadores | Reconoce generación en el **encuadre completo**, no solo el rostro | MIT ([origen](https://huggingface.co/Bombek1/ai-image-detector-siglip-dinov2)) |

Correspondencia con las claves de la API (`models` en la respuesta de
`POST /predict`):

| Nombre Estándar | Clave API | Etiqueta En La Interfaz |
|---|---|---|
| Detector De Síntesis GAN | `synthesis_gan` | GAN |
| Detector De Face Swap | `faceswap_dfdc` | FACE SWAP |
| Detector De Difusión Facial | `diffusion_modern` | DIFUSIÓN |
| Sonda De Escena Generada | `scene_generated` | ESCENA |

Las mismas claves se usan en `explanation.weights` (la ponderación del mapa
de calor explicativo, Paso 7).

Todos los pesos se cargan desde este directorio en el arranque, en modo
seguro (`torch.load` con `weights_only`); los checkpoints de terceros se
convirtieron una única vez a archivos de solo-tensores. No hay descargas en
tiempo de ejecución.

> ⚠️ **Los tres pesos grandes no se versionan en git** (límite de 100 MB por
> archivo de GitHub). En un clon nuevo, reconstrúyelos con
> `python scripts/fetch_models.py` desde `backend/` — descarga de las fuentes
> oficiales listadas abajo y aplica las mismas conversiones.

## Enlaces De Origen

Procedencia exacta de cada modelo y qué transformación se le aplicó al
incorporarlo:

| Nombre Estándar | Origen | Transformación aplicada |
|---|---|---|
| **Detector Facial YuNet** | [opencv/opencv_zoo — face_detection_yunet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) (archivo `face_detection_yunet_2023mar.onnx`) | Ninguna; se usa el ONNX oficial tal cual |
| **Detector De Síntesis GAN** | Entrenamiento propio en Google Colab sobre el dataset [140k Real and Fake Faces](https://www.kaggle.com/datasets/xhlulu/140k-real-and-fake-faces) (Kaggle, xhlulu) | Ninguna |
| **Detector De Face Swap** | [selimsef/dfdc_deepfake_challenge — release 0.0.1](https://github.com/selimsef/dfdc_deepfake_challenge/releases/tag/0.0.1), checkpoint `final_888_DeepFakeClassifier_tf_efficientnet_b7_ns_0_40` | Convertido a archivo de solo-tensores (el checkpoint original de 2020 traía metadatos numpy incompatibles con el modo seguro de `torch.load`) |
| **Detector De Difusión Facial** | [prithivMLmods/deepfake-detector-model-v1](https://huggingface.co/prithivMLmods/deepfake-detector-model-v1) (Hugging Face) | Se descartaron los checkpoints intermedios de entrenamiento; se conserva solo `model.safetensors` y sus configs |
| **Sonda De Escena Generada** | [Bombek1/ai-image-detector-siglip-dinov2](https://huggingface.co/Bombek1/ai-image-detector-siglip-dinov2) (Hugging Face) | Convertido a solo-tensores; los adaptadores LoRA se fusionan en los backbones al cargar (equivalente en inferencia). Incluye los configs del backbone [google/siglip2-so400m-patch14-384](https://huggingface.co/google/siglip2-so400m-patch14-384) para construir sin red |

---

## Procedimiento De Determinación En Video

```mermaid
flowchart TD
    A[Video recibido] --> B[Extracción de 24 fotogramas<br/>repartidos, con marca de tiempo]
    B --> C[Detector Facial YuNet<br/>recorta el rostro de cada fotograma]
    C --> D[Cada rostro pasa por los tres peritos]
    D --> E1[Detector De Síntesis GAN<br/>agregación: mediana]
    D --> E2[Detector De Face Swap<br/>agregación: segundo máximo]
    D --> E3[Detector De Difusión Facial<br/>agregación: mediana]
    E1 --> F{Señal máxima > 0.5}
    E2 --> F
    E3 --> F
    F -- "Sí, con corroboración<br/>(GAN o Face Swap ≥ 0.3)" --> G[MANIPULADO]
    F -- "Sí, pero solo difusión" --> H[Sonda De Escena Generada<br/>2 encuadres completos]
    F -- "No supera 0.5:<br/>candidato a REAL" --> H2[Sonda De Escena Generada<br/>verificación sistemática]
    H -- "Escena > 0.6:<br/>generación global" --> G
    H -- "Rostro < 0.7 y<br/>escena < 0.3" --> I2[REAL con nota<br/>patrón de filtro]
    H -- "Rostro ≥ 0.7 o<br/>escena no concluyente" --> J[INDICIOS<br/>filtro o face swap moderno]
    H2 -- "Escena > 0.75:<br/>generación global" --> G
    H2 -- "Escena ≥ 0.55 o<br/>señal facial ≥ 0.25" --> J2[INDICIOS<br/>señal débil]
    H2 -- "Escena limpia y<br/>señal facial baja" --> I[REAL verificado]
```

### Paso 1 — Ingesta Y Extracción

El video se valida (formato, ≤ 10 MB) y se escriben hasta **24 fotogramas
muestreados a intervalos regulares** de toda la línea de tiempo, cada uno con
su marca de tiempo en segundos. Si OpenCV no puede decodificar el códec, el
análisis se detiene con un error explícito (HTTP 422) — nunca se emite
veredicto sobre material ilegible.

### Paso 2 — Recorte Facial

El **Detector Facial YuNet** localiza el rostro más grande de cada fotograma
y lo recorta con un margen del 35 %. Esto es determinante: los peritos fueron
entrenados con rostros que ocupan todo el encuadre, y pasarles el fotograma
entero haría que el fondo dominara el veredicto. Si un fotograma no tiene
rostro detectable se analiza completo y queda registrado; si ningún fotograma
tiene rostro, el dictamen lo advierte (`faces_detected: 0`).

### Paso 3 — Evaluación Por Los Tres Peritos

Cada recorte facial pasa por los tres especialistas, cada uno experto en una
familia de manipulación distinta:

- **Detector De Síntesis GAN** — busca los artefactos de textura de las GAN
  clásicas (StyleGAN).
- **Detector De Face Swap** — busca los bordes de mezcla e inconsistencias
  del intercambio de caras.
- **Detector De Difusión Facial** — busca la firma de los generadores
  modernos por difusión.

Cada uno emite una probabilidad de manipulación **por fotograma**, visible en
el log (`p_gan`, `p_swap`, `p_diff`).

### Paso 4 — Agregación Por Familia

Cada familia resume sus 24 puntuaciones según la naturaleza de su artefacto:

| Familia | Estadística | Razón forense |
|---|---|---|
| Síntesis GAN | **Mediana** | Una cara generada lo es en todos los fotogramas; la mediana resiste picos y valles atípicos |
| Face Swap | **Segundo Máximo** | Los artefactos del swap son intermitentes (pose, expresión, luz); se exigen **dos detecciones independientes** — un pico único de ruido no condena |
| Difusión Facial | **Mediana** | Igual que la GAN: la generación afecta a todo el video por igual |

### Paso 5 — Decisión Y Resolución De Ambigüedad

La señal más alta de las tres decide. Sobre esa base:

1. **Condena corroborada** (la señal ganadora supera 0.5 y GAN o Face Swap
   participan con ≥ 0.3) → **MANIPULADO**, con la confianza de la señal
   ganadora.
2. **Condena solo por difusión** (los otros dos limpios) → ambigüedad
   conocida: los filtros de embellecimiento producen la misma firma facial
   que la generación. Se invoca la **Sonda De Escena Generada** sobre 2
   encuadres completos (solo si hay suficientes fotogramas donde el rostro no
   domina), con cuatro salidas:
   - firma también en el entorno (> 0.5) → **MANIPULADO** (generación global);
   - señal facial **moderada** (< 0.7) y entorno **claramente limpio**
     (< 0.3) → **REAL con nota**: patrón de filtro sobre material auténtico,
     con la confianza apoyada en la evidencia no contaminada (el entorno);
   - señal facial **fuerte** (≥ 0.7) o entorno no concluyente → **INDICIOS**:
     con señal fuerte conviven el filtro extremo y el video generado,
     indistinguibles sin revisión humana;
   - sin encuadres contrastables → **INDICIOS** prudente.

   Las barreras (0.7 y 0.3) están calibradas con casos reales de ambas
   clases: el real filtrado observado da señal facial 0.55 con entorno 0.29,
   mientras que los generados y el filtro extremo dan ≥ 0.88.
3. **Verificación sistemática de todo candidato a REAL** → antes de
   certificar, la Sonda De Escena Generada examina 2 encuadres completos.
   Motivo, verificado empíricamente: un generador reciente dejó el rostro
   casi limpio (mediana facial 0.13, por debajo del real más alto observado,
   0.19) — la única evidencia posible estaba en el encuadre. Salidas:
   - escena > 0.75 → **MANIPULADO** (generación global; el listón alto es
     deliberado — aquí la sonda condena en solitario, y su ruido sobre
     material auténtico llega casi a 0.5: lecturas reales observadas 0.25,
     0.29, 0.47 y 0.48);
   - escena ≥ 0.55, o señal facial en zona gris (0.25–0.5, donde generadores
     recientes han puntuado 0.27 y 0.34) → **INDICIOS** y peritaje manual;
   - escena limpia y señal facial baja → **REAL verificado**, con la lectura
     de escena registrada como evidencia positiva (`scene_generated`).
   En la ruta de reserva (donde la sonda solo *confirma* una condena facial
   ya existente) el listón de confirmación es 0.6. Los tres umbrales quedan
   pendientes de contraste con lecturas de escena sobre video generado, aún
   inexistentes.
   En primeros planos la sonda examina el fotograma tal cual: no puede
   distinguir el entorno, pero aporta la opinión de un modelo independiente
   entrenado en otra distribución — verificado con un fake en primer plano
   que pasó con los tres detectores faciales en silencio y solo el encuadre
   podía delatarlo. (La ruta de reserva, con señal facial alta, sí omite la
   sonda en primeros planos: ahí rostro≈encuadre no separa filtro de
   generación y decide el perito.)

La sonda solo se paga en los casos 2 y 3 (~1 minuto extra); los veredictos
claros no la ejecutan.

### Paso 6 — Dictamen

| Sello | Valor API | Significado |
|---|---|---|
| **MANIPULADO** (naranja) | `Fake` | Manipulación detectada, con corroboración o generación global confirmada |
| **INDICIOS** (ámbar, borde discontinuo) | `Suspect` | Señal sin corroborar o inconclusa; el campo `caveat` explica la reserva y el perito decide con las métricas |
| **REAL** (moss) | `Real` | Los tres peritos limpios; el porcentaje orienta la decisión del perito |

El dictamen incluye siempre el desglose por modelo (la señal decisoria
marcada con ▸), los fotogramas analizados y con rostro, la puntuación por
fotograma (`frame_scores`) y los **momentos sospechosos** con marca de tiempo
(`suspicious_seconds`, fotogramas de face swap > 0.6) para revisión manual
directa en la línea de tiempo.

### Paso 7 — Mapa De Calor Explicativo (EigenCAM)

Para que el perito respalde el dictamen, el sistema genera **un mapa de calor
que fusiona la atención de todos los peritos que participaron**, superpuesto
sobre el fotograma completo. En video no se produce uno solo: se produce
**uno por cada fotograma analizado (los 24)**, cada uno coloreado con la
señal de su propio instante, más el **destacado** — el de mayor señal, el
único que puede incorporar el CAM de la sonda de escena, cuya lectura es
global y no por fotograma. Así el perito no ve una foto fija de la evidencia,
sino cómo evoluciona la atención de los detectores a lo largo del video.
Implementado en `backend/app/explain.py` sin dependencias externas.

**Método.** EigenCAM: primer componente principal (SVD) de las activaciones
de la última capa de cada modelo — sin gradientes, aplicable a CNN y ViT por
igual. Anclajes: `_bn1` + swish del B0 (7×7, el mismo tensor que devuelve
`extract_features`), `encoder.bn2` del B7 (12×12, con el letterbox de entrada
deshecho), `post_layernorm` del SigLIP facial (parches 14×14) y de la torre
SigLIP del ensemble de escena (cuando la sonda participó).

**Coste.** Calcular 24 mapas re-ejecutando los modelos costaría una segunda
pasada de inferencia completa. En su lugar, `FacialCapture` engancha las tres
capas **una sola vez** y congela el EigenCAM de cada fotograma según se
puntúa: lo que se guarda es una rejilla diminuta (7×7, 12×12, 14×14) y el
coste añadido es la SVD por fotograma, del orden de milisegundos. El mapa de
los 24 fotogramas sale, en la práctica, gratis.

**Fusión.** Cada mapa se normaliza 0-1; los faciales se reubican en la caja
del rostro dentro del fotograma completo y el de escena cubre el encuadre
(este último, solo si su lectura fue **relevante para el veredicto** —
≥ 0.5, es decir, confirmó o levantó sospecha; una lectura descartada por la
decisión no pinta el mapa). La fusión es un **máximo ponderado por píxel**:

    fusionado(x) = maxᵢ( wᵢ · camᵢ(x) )

con wᵢ = señal por-fotograma de cada detector. Cada punto refleja así la
evidencia del perito más fuerte en ese punto, en **probabilidad absoluta**,
sin que un promedio la diluya.

**Presentación forense.** La evidencia se convierte a escala de grises
atenuada, de modo que **todo color en el mapa es señal**, nunca color propio
de la imagen. El color codifica la intensidad absoluta con la **escala de
riesgo verde → amarillo → naranja → rojo**: un material auténtico muestra
zonas de atención verdes y suaves; uno manipulado, núcleos rojos. Se
muestran **todas** las zonas de atención (el mapa se suaviza en manchas
orgánicas y solo se descarta el ruido puntual sin área mínima), en degradado
continuo, sin contornos duros; el CAM de escena recibe además un difuminado
agresivo que lava su moteado característico. Recuadro naranja en el rostro
analizado.

La zona se dibuja **siempre que haya atención, por débil que sea la señal**:
lo que cambia con la intensidad es el color (y algo la opacidad), no la
existencia del mapa. Esto es deliberado — un suelo de intensidad alto dejaba
los fotogramas auténticos en gris, sin una sola mancha, y el perito no podía
distinguir «riesgo bajo» de «el mapa no funciona». Que un material auténtico
salga en verde **es** el resultado correcto.

El resultado viaja en el campo `explanation` de la respuesta: el destacado
(JPEG base64, lado ≤ 720 px) más `frames[]`, un mapa por fotograma analizado
(lado ≤ 640 px) con su segundo, su señal y sus ponderaciones. La interfaz
muestra el destacado en grande y la tira completa debajo, recorrible. Un
fallo del mapa —de uno o de todos— nunca afecta al veredicto.

### Imágenes

El procedimiento es el mismo con un solo "fotograma": recorte facial, tres
peritos, y las mismas reglas de reserva y zona gris usando la imagen completa
como encuadre para la Sonda De Escena Generada.

---

## Límites Declarados

Cada perito conoce su familia y su época. Manipulaciones de familias no
vistas en entrenamiento —face swap comercial de última generación,
reenactment, generadores futuros— pueden atenuarse hasta la zona gris o
escapar. El diseño de tres sellos garantiza que la incertidumbre nunca se
presenta como certeza: cuando el sistema no puede corroborar, lo dice
(**INDICIOS**) y entrega las métricas para que decida el perito.
