"""Regla de dictamen de video: qué señales deciden y con qué umbrales.

Sin dependencias de los modelos (no importa torch): la usan producción
(app.model.predict_video), el script de calibración y las pruebas, así que
los tres aplican exactamente la misma regla.
"""

# Calibrado el 2026-11-11 con 71 videos etiquetados (36 auténticos y 35
# manipulados: face swap sobre metraje real y videos generados por completo),
# todos de redes sociales. Validación cruzada dejando uno fuera: los mismos
# umbrales ganan en 69 de 71 particiones. Resultado sobre el catálogo:
# regla anterior 25 Real→Fake y 0 Fake→Real (52 % de aciertos); esta, 2 y 1
# (66 % de aciertos, 94 % sobre los videos en que se pronuncia).
# Resumen en backend/calibracion/resumen.md (scripts/calibrate_catalog.py).
#
# Qué enseñó la calibración:
# - El detector de difusión facial puntúa MÁS ALTO el material auténtico de
#   redes (mediana 0.73) que el generado (0.34): los filtros y la
#   recompresión imitan su firma. El B0 de síntesis GAN no separa (AUC 0.52).
#   Ninguno de los dos decide ya el dictamen de video; se informan como
#   orientativos.
# - El face swap verdadero es SOSTENIDO: el rostro está intercambiado en
#   todo el plano, así que el B7 se dispara en fotogramas consecutivos. Sus
#   falsas alarmas en video auténtico (perfiles, rostros pequeños,
#   desenfoque) son picos breves: solo 1 de los 36 auténticos encadenó 3
#   disparos seguidos, frente a 9 de los 35 manipulados.
# - La sonda de escena es la única señal que delata el video generado por
#   completo (AUC 0.73 con 4 sondas).
SWAP_FRAME_LIMIT = 0.5     # un fotograma "dispara" el face swap por encima de esto
SWAP_SUSTAIN_FRAMES = 3    # disparos consecutivos que condenan
SCENE_FAKE_LIMIT = 0.8     # mediana de escena que condena en solitario
SCENE_REAL_LIMIT = 0.5     # por debajo, el encuadre se considera limpio
# Salvaguarda: con la mediana del B0 (síntesis GAN) por encima de esto no se
# certifica autenticidad. Solo puede convertir un "Real" en "Suspect", nunca
# condenar: el máximo observado en auténticos fue 0.46.
GAN_GUARD_LIMIT = 0.5
# Encuadres que examina la sonda de escena (~20-27 s cada uno en CPU); decide
# su mediana. Con 4 los falsos positivos del catálogo bajaron a la mitad
# respecto a 2: una lectura aislada alta pesa menos.
SCENE_PROBES = 4

LIMIT_NAMES = ("SWAP_FRAME_LIMIT", "SWAP_SUSTAIN_FRAMES", "SCENE_FAKE_LIMIT",
               "SCENE_REAL_LIMIT", "GAN_GUARD_LIMIT", "SCENE_PROBES")


def _defaults() -> dict:
    return {name: globals()[name] for name in LIMIT_NAMES}


DECISIVE_VIDEO_DETECTORS = ("faceswap_dfdc", "scene_generated")

CAVEAT_SCENE_GRAY = (
    "La sonda de escena dio una lectura intermedia: por encima de lo habitual "
    "en material auténtico limpio y por debajo de lo que exige una condena. "
    "La recompresión, los filtros y los rótulos de las redes sociales "
    "producen lecturas en esta franja, igual que algunos generadores de "
    "video recientes. Requiere revisión humana: examinar la coherencia "
    "física de la escena (manos, texto, reflejos, fondo)."
)

CAVEAT_GAN_GUARD = (
    "El detector de síntesis GAN mantiene una señal alta en la mayoría de los "
    "fotogramas, aunque la escena y el face swap no la corroboran. No basta "
    "para condenar, pero impide certificar autenticidad. Requiere revisión "
    "humana del rostro (simetría, dientes, orejas, fondo junto al contorno)."
)

CAVEAT_SWAP_BRIEF = (
    "El detector de face swap se disparó en dos fotogramas seguidos, pero no "
    "se sostuvo en tres. Los perfiles, los rostros pequeños y el desenfoque "
    "de movimiento producen disparos breves en video auténtico, mientras que "
    "un intercambio de rostro real suele mantenerse a lo largo del plano. "
    "Requiere revisión humana de los segundos señalados."
)


def sustained_level(scores, frames):
    """Nivel que la señal mantiene durante `frames` fotogramas consecutivos.

    Es el máximo, entre todas las ventanas de `frames` fotogramas seguidos,
    de la puntuación MÍNIMA de la ventana: supera un umbral si y solo si hay
    al menos `frames` disparos seguidos por encima de él. 0 si no hay
    fotogramas suficientes para establecer continuidad.
    """
    if frames < 1 or len(scores) < frames:
        return 0.0
    return max(min(scores[i:i + frames]) for i in range(len(scores) - frames + 1))


def current_limits() -> dict:
    """Umbrales vigentes de la regla (los registra la calibración)."""
    return _defaults()


def video_verdict(scene, swap_sustained, swap_pair, gan_median=0.0, *, limits=None):
    """Dictamen de video a partir de las dos señales que separan.

    scene: mediana de la sonda de escena (None si no pudo ejecutarse).
    swap_sustained: nivel sostenido del face swap en SWAP_SUSTAIN_FRAMES
    fotogramas; swap_pair: el sostenido en dos (detecta disparos breves);
    gan_median: mediana del B0 sobre los fotogramas con rostro (salvaguarda).

    - Fake: escena ≥ SCENE_FAKE_LIMIT (generación global) o face swap
      sostenido (≥ SWAP_SUSTAIN_FRAMES disparos seguidos).
    - Real: escena limpia, como mucho disparos aislados de face swap y la
      síntesis GAN por debajo de GAN_GUARD_LIMIT.
    - Suspect: el resto (escena intermedia, disparos breves o GAN alta).

    limits: umbrales alternativos (la calibración prueba variantes); por
    defecto, los de este módulo.

    Devuelve (label, confidence, caveat).
    """
    L = {**_defaults(), **(limits or {})}
    scene_value = 0.0 if scene is None else scene
    convicts = [v for v, hit in ((scene_value, scene_value >= L["SCENE_FAKE_LIMIT"]),
                                 (swap_sustained, swap_sustained > L["SWAP_FRAME_LIMIT"])) if hit]
    if convicts:
        return "Fake", round(max(convicts) * 100, 2), None

    scene_clean = scene is not None and scene < L["SCENE_REAL_LIMIT"]
    brief_swap = swap_pair > L["SWAP_FRAME_LIMIT"]
    gan_high = gan_median >= L["GAN_GUARD_LIMIT"]
    if scene_clean and not brief_swap and not gan_high:
        return "Real", round((1 - max(scene_value, swap_pair)) * 100, 2), None

    caveats = []
    if not scene_clean:
        caveats.append(CAVEAT_SCENE_GRAY)
    if brief_swap:
        caveats.append(CAVEAT_SWAP_BRIEF)
    if gan_high:
        caveats.append(CAVEAT_GAN_GUARD)
    signal = max(scene_value, swap_pair, gan_median if gan_high else 0.0)
    return "Suspect", round(signal * 100, 2), " ".join(caveats)


