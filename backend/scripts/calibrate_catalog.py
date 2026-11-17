"""Calibración sobre un catálogo de videos etiquetados (Real / Fake).

Ejecuta el pipeline REAL de producción (`app.model.predict_video`) sobre cada
video y registra, además del veredicto, todas las señales crudas que la
decisión usa por dentro: las tres probabilidades faciales de cada fotograma,
la calidad del recorte facial, las rejillas de los mapas de calor y la sonda
de escena — esta última SIEMPRE, también cuando producción no la habría
invocado. Con eso cualquier combinación de umbrales o reglas de agregación
puede simularse después sin volver a ejecutar los modelos.

Uso, desde backend/ y con el entorno virtual activado (cierra antes la API y
el worker: los modelos ocupan varios GB de RAM):

    python -m scripts.calibrate_catalog                 # catálogo completo
    python -m scripts.calibrate_catalog --limite 2      # prueba: 2 por clase
    python -m scripts.calibrate_catalog --sondas 6      # más sondas de escena que producción
    python -m scripts.calibrate_catalog --solo-resumen  # rehace el resumen

Es reanudable: cada video se guarda al terminar y una nueva ejecución
continúa donde quedó (Ctrl+C es seguro). Salida en backend/calibracion/:

    senales.jsonl   una línea por video, con todo lo registrado
    resumen.md      matriz de confusión, separabilidad por señal, errores
    config.json     umbrales vigentes y versiones con que se midió
    laminas/        hoja de contacto por video con sus mapas de calor
    cams/           rejillas EigenCAM por fotograma (.npz)

Este script no modifica nada del sistema: solo mide.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app import video_rule  # noqa: E402  (sin torch: solo umbrales y regla)

LABEL_FOLDERS = {
    "Fake": {"fake", "fakes", "falso", "falsos", "manipulado", "manipulados"},
    "Real": {"real", "reales", "reals", "autentico", "autenticos", "auténtico", "auténticos"},
}
VIDEO_SUFFIXES = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}
PRODUCTION_UPLOAD_LIMIT = 10 * 1024 * 1024
MODEL_KEYS = ("synthesis_gan", "faceswap_dfdc", "diffusion_modern")
SCORE_KEYS = ("p_gan", "p_swap", "p_diff")
# El recorte facial añade un 35 % de margen por lado: el rostro ocupa ~1/1.7 del lado del recorte.
FACE_SHARE_OF_CROP = 1 / 1.7
CAM_GRID = 28


# ======================================================================
# Estadística (sin dependencias: el resumen se puede rehacer en cualquier equipo)
# ======================================================================
def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return float("nan")
    position = (len(ordered) - 1) * q
    low, high = math.floor(position), math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def auc(positives: list[float], negatives: list[float]) -> float:
    """Probabilidad de que un Fake puntúe más alto que un Real (empates = 0.5)."""
    if not positives or not negatives:
        return float("nan")
    ordered = sorted(negatives)
    import bisect
    wins = 0.0
    for value in positives:
        below = bisect.bisect_left(ordered, value)
        ties = bisect.bisect_right(ordered, value) - below
        wins += below + 0.5 * ties
    return wins / (len(positives) * len(negatives))


def best_threshold(positives: list[float], negatives: list[float]) -> tuple[float, float, float]:
    """Umbral (señal > umbral ⇒ Fake) que maximiza TPR − FPR. Devuelve (umbral, TPR, FPR)."""
    values = sorted(set(positives) | set(negatives))
    candidates = [(a + b) / 2 for a, b in zip(values, values[1:])] or values
    best = (float("nan"), 0.0, 0.0, -1.0)
    for threshold in candidates:
        tpr = sum(v > threshold for v in positives) / len(positives)
        fpr = sum(v > threshold for v in negatives) / len(negatives)
        if tpr - fpr > best[3]:
            best = (threshold, tpr, fpr, tpr - fpr)
    return best[:3]


def spearman(xs: list[float], ys: list[float]) -> float:
    def ranks(values):
        order = sorted(range(len(values)), key=values.__getitem__)
        result = [0.0] * len(values)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
                j += 1
            for k in range(i, j + 1):
                result[order[k]] = (i + j) / 2 + 1
            i = j + 1
        return result
    if len(xs) < 3:
        return float("nan")
    rx, ry = ranks(xs), ranks(ys)
    mx, my = statistics.fmean(rx), statistics.fmean(ry)
    sx = math.sqrt(sum((a - mx) ** 2 for a in rx))
    sy = math.sqrt(sum((b - my) ** 2 for b in ry))
    if sx == 0 or sy == 0:
        return float("nan")
    return sum((a - mx) * (b - my) for a, b in zip(rx, ry)) / (sx * sy)


def second_max(scores: list[float]) -> float:
    """Segunda puntuación más alta (agregado de face swap de la regla anterior)."""
    if not scores:
        return 0.0
    return scores[0] if len(scores) == 1 else sorted(scores, reverse=True)[1]


# La regla de dictamen de video vive en app.video_rule, sin dependencias de los
# modelos: este script aplica exactamente la de producción, sin copiarla.
RULE_KEYS = video_rule.LIMIT_NAMES
sustained_level = video_rule.sustained_level


def current_thresholds() -> dict:
    return video_rule.current_limits()


# ======================================================================
# Señales por video y simulador de la decisión
# ======================================================================
def video_signals(record: dict, probes: int = 4) -> dict[str, float]:
    """Agregados candidatos de un video; los marcados (prod) son los que decide la regla vigente.

    La escena de producción es la mediana de las primeras `probes` sondas registradas (las de
    producción primero; si se midió con una versión de menos sondas, se completan con las extra).
    """
    frames = record["frames"]
    with_face = [f for f in frames if f["found"]]
    gan = [f["p_gan"] for f in frames]
    swap = [f["p_swap"] for f in frames]
    diff = [f["p_diff"] for f in frames]
    face_swap = [f["p_swap"] for f in with_face]
    ordered = sorted(record["scene"]["probes"], key=lambda p: not p["production"])
    production = [p["score"] for p in ordered[:probes]]
    every = [p["score"] for p in ordered]
    signals = {
        "swap_sostenido3 (prod)": sustained_level(face_swap, 3), "swap_sostenido2": sustained_level(face_swap, 2),
        "swap_2max": second_max(swap), "swap_max": max(swap), "swap_p90": percentile(swap, 0.9),
        "swap_media": statistics.fmean(swap), "swap_mediana": statistics.median(swap),
        "swap_frac>0.5": sum(v > 0.5 for v in swap) / len(swap),
        "escena_prod (prod)": statistics.median(production), "escena_media": statistics.fmean(every),
        "escena_min": min(every), "escena_max": max(every),
        "gan_mediana_con_rostro": statistics.median([f["p_gan"] for f in with_face] or gan),
        "gan_mediana": statistics.median(gan), "gan_media": statistics.fmean(gan),
        "gan_p90": percentile(gan, 0.9), "gan_max": max(gan),
        "dif_mediana": statistics.median(diff), "dif_media": statistics.fmean(diff),
        "dif_p25": percentile(diff, 0.25), "dif_p90": percentile(diff, 0.9), "dif_max": max(diff),
        "dif_mediana_con_rostro": statistics.median([f["p_diff"] for f in with_face] or diff),
    }
    signals["max3_anterior"] = max(signals["gan_mediana"], signals["swap_2max"], signals["dif_mediana"])
    return signals


def simulate(record: dict, T: dict | None = None) -> str:
    """Dictamen de `app.video_rule.video_verdict` recalculado con las señales registradas.

    `T`: umbrales a probar (por defecto, los vigentes). La escena es la mediana de las
    primeras SCENE_PROBES sondas registradas (las de producción primero).
    """
    L = {**video_rule.current_limits(), **(T or {})}
    with_face = [f for f in record["frames"] if f["found"]]
    face_swap = [f["p_swap"] for f in with_face]
    gan = statistics.median([f["p_gan"] for f in with_face] or [f["p_gan"] for f in record["frames"]])
    probes = sorted(record["scene"]["probes"], key=lambda p: not p["production"])[:int(L["SCENE_PROBES"])]
    scene = statistics.median([p["score"] for p in probes]) if probes else None
    label, _confidence, _caveat = video_rule.video_verdict(
        scene, sustained_level(face_swap, int(L["SWAP_SUSTAIN_FRAMES"])), sustained_level(face_swap, 2), gan, limits=L)
    return label


# ======================================================================
# Resumen
# ======================================================================
def _fmt(value: float, digits: int = 3) -> str:
    return "—" if value is None or (isinstance(value, float) and math.isnan(value)) else f"{value:.{digits}f}"


def _pct(part: int, whole: int) -> str:
    return f"{part}/{whole} ({part / whole * 100:.0f} %)" if whole else "0/0"


def _confusion(out: list[str], real: list[dict], fake: list[dict], verdict) -> None:
    """Matriz de confusión y métricas de un criterio de dictamen (`verdict(record) -> etiqueta`)."""
    out += ["| Etiqueta | → Real | → Suspect | → Fake |", "|---|---|---|---|"]
    counts = {label: {p: sum(verdict(r) == p for r in group) for p in ("Real", "Suspect", "Fake")}
              for label, group in (("Real", real), ("Fake", fake))}
    for label, group in (("Real", real), ("Fake", fake)):
        out.append(f"| **{label}** ({len(group)}) | {counts[label]['Real']} | {counts[label]['Suspect']} | {counts[label]['Fake']} |")
    total = len(real) + len(fake)
    correct = counts["Real"]["Real"] + counts["Fake"]["Fake"]
    decided = total - counts["Real"]["Suspect"] - counts["Fake"]["Suspect"]
    out += ["",
            f"- Aciertos estrictos (Suspect cuenta como fallo): {_pct(correct, total)}",
            f"- Aciertos sobre los que el sistema se pronunció: {_pct(correct, decided)}",
            f"- Falsos positivos graves (Real → Fake): {_pct(counts['Real']['Fake'], len(real))}",
            f"- Falsos negativos graves (Fake → Real): {_pct(counts['Fake']['Real'], len(fake))}",
            f"- Sin pronunciarse (Suspect): Real {_pct(counts['Real']['Suspect'], len(real))}, Fake {_pct(counts['Fake']['Suspect'], len(fake))}"]


def build_summary(records: list[dict], config: dict, current: dict | None = None) -> str:
    """`config`: lo registrado al medir; `current`: umbrales vigentes (por defecto, los de app/model.py)."""
    done = [r for r in records if r.get("ok")]
    failed = [r for r in records if not r.get("ok")]
    real = [r for r in done if r["label"] == "Real"]
    fake = [r for r in done if r["label"] == "Fake"]
    measured = config.get("thresholds", {})
    T = current if current is not None else current_thresholds()
    probes = int(T.get("SCENE_PROBES", 4))
    out: list[str] = ["# Calibración — resumen", ""]
    out.append(f"Generado {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC · {len(done)} videos analizados "
               f"({len(real)} Real, {len(fake)} Fake){f' · {len(failed)} con error' if failed else ''}.")
    if not real or not fake:
        return "\n".join(out + ["", "Faltan videos de alguna de las dos clases: no se puede calcular el resto."])

    # ---- 1. Veredicto registrado y regla vigente
    out += ["", "## 1. Veredicto registrado al medir", ""]
    _confusion(out, real, fake, lambda r: r["production"]["prediction"])
    same_rule = all(measured.get(key) == T.get(key) for key in RULE_KEYS)
    if same_rule:
        agree = sum(simulate(r, T) == r["production"]["prediction"] for r in done)
        out.append(f"- Autocomprobación del simulador: coincide con producción en {_pct(agree, len(done))}"
                   + ("" if agree == len(done) else " ← **revisar: el espejo de la decisión está desactualizado**"))
    else:
        rule = ", ".join(f"{key}={T.get(key)}" for key in RULE_KEYS)
        out += ["", "## 1b. Regla vigente, simulada sobre estas mediciones", "",
                "Estas mediciones se tomaron con otra versión de la regla de dictamen. Esta tabla aplica la regla vigente "
                f"({rule}) a las señales registradas; vuelve a medir con `--rehacer` para confirmarla.", ""]
        _confusion(out, real, fake, lambda r: simulate(r, T))

    # ---- 2. Separabilidad por señal (nivel video)
    names = list(video_signals(done[0], probes))
    table = []
    for name in names:
        pos = [video_signals(r, probes)[name] for r in fake]
        neg = [video_signals(r, probes)[name] for r in real]
        threshold, tpr, fpr = best_threshold(pos, neg)
        safe = max(neg)  # primer umbral sin ningún falso positivo
        table.append((auc(pos, neg), name, neg, pos, threshold, tpr, fpr, safe, sum(v > safe for v in pos) / len(pos)))
    out += ["", "## 2. Separabilidad de cada señal (por video)", "",
            "AUC: probabilidad de que un Fake puntúe más que un Real (1.0 = separa perfecto; 0.5 = no informa). "
            "«Umbral óptimo» maximiza aciertos Fake − falsas alarmas; «sin falsas alarmas» es el máximo observado en Real.", "",
            "| Señal | AUC | Real p10 / p50 / p90 / máx | Fake mín / p10 / p50 / p90 | Umbral óptimo → detecta / falsa alarma | Sin falsas alarmas → detecta |",
            "|---|---|---|---|---|---|"]
    for score, name, neg, pos, threshold, tpr, fpr, safe, safe_tpr in sorted(table, key=lambda row: -abs(row[0] - 0.5)):
        out.append(f"| {name} | {_fmt(score)} | {_fmt(percentile(neg, .1))} / {_fmt(percentile(neg, .5))} / {_fmt(percentile(neg, .9))} / {_fmt(max(neg))} "
                   f"| {_fmt(min(pos))} / {_fmt(percentile(pos, .1))} / {_fmt(percentile(pos, .5))} / {_fmt(percentile(pos, .9))} "
                   f"| {_fmt(threshold)} → {tpr * 100:.0f} % / {fpr * 100:.0f} % | {_fmt(safe)} → {safe_tpr * 100:.0f} % |")

    # ---- 3. Nivel fotograma
    out += ["", "## 3. Detectores por fotograma", "", "| Detector | AUC por fotograma | Real p50 / p90 / p99 | Fake p10 / p50 / p90 | Fotogramas Real > 0.5 | Fotogramas Fake > 0.5 |", "|---|---|---|---|---|---|"]
    for key in SCORE_KEYS:
        pos = [f[key] for r in fake for f in r["frames"]]
        neg = [f[key] for r in real for f in r["frames"]]
        out.append(f"| {key} | {_fmt(auc(pos, neg))} | {_fmt(percentile(neg, .5))} / {_fmt(percentile(neg, .9))} / {_fmt(percentile(neg, .99))} "
                   f"| {_fmt(percentile(pos, .1))} / {_fmt(percentile(pos, .5))} / {_fmt(percentile(pos, .9))} "
                   f"| {_pct(sum(v > .5 for v in neg), len(neg))} | {_pct(sum(v > .5 for v in pos), len(pos))} |")
    faces = {label: (sum(f["found"] for r in group for f in r["frames"]), sum(len(r["frames"]) for r in group)) for label, group in (("Real", real), ("Fake", fake))}
    out += ["", f"Rostro detectado: Real {_pct(*faces['Real'])} de los fotogramas, Fake {_pct(*faces['Fake'])}."]

    # ---- 4. Qué condiciona las puntuaciones
    out += ["", "## 4. Qué acompaña a las puntuaciones (correlación de Spearman, por fotograma)", "",
            "Valores lejos de 0 señalan un sesgo: p. ej. negativo en «lado del rostro» sobre Real = los rostros pequeños disparan falsas alarmas.", "",
            "| Clase | Detector | Lado del rostro (px) | Nitidez | Brillo | Fracción del encuadre |", "|---|---|---|---|---|---|"]
    for label, group in (("Real", real), ("Fake", fake)):
        rows = [f for r in group for f in r["frames"] if f["found"]]
        for key in SCORE_KEYS:
            scores = [f[key] for f in rows]
            cells = [spearman([feature(f) for f in rows], scores) for feature in (
                lambda f: min(f["face_px"]), lambda f: f["sharp"], lambda f: f["bright"], lambda f: f["face_fraction"])]
            out.append(f"| {label} | {key} | " + " | ".join(_fmt(c, 2) for c in cells) + " |")

    # ---- 5. Sonda de escena
    out += ["", "## 5. Sonda de escena", "", "| Clase | Lectura de producción p10 / p50 / p90 / máx | Diferencia entre sus 2 sondas (media / máx) | Dispersión entre todas las sondas (media) | Encuadres de contexto (mediana) |", "|---|---|---|---|---|"]
    for label, group in (("Real", real), ("Fake", fake)):
        prod = [video_signals(r, probes)["escena_prod (prod)"] for r in group]
        gaps, spreads = [], []
        for r in group:
            p = [x["score"] for x in r["scene"]["probes"] if x["production"]]
            if len(p) >= 2:
                gaps.append(max(p) - min(p))
            every = [x["score"] for x in r["scene"]["probes"]]
            if len(every) >= 2:
                spreads.append(statistics.pstdev(every))
        out.append(f"| {label} | {_fmt(percentile(prod, .1))} / {_fmt(percentile(prod, .5))} / {_fmt(percentile(prod, .9))} / {_fmt(max(prod))} "
                   f"| {_fmt(statistics.fmean(gaps)) if gaps else '—'} / {_fmt(max(gaps)) if gaps else '—'} | {_fmt(statistics.fmean(spreads)) if spreads else '—'} "
                   f"| {statistics.median(r['scene']['n_context'] for r in group):.0f} de {statistics.median(len(r['frames']) for r in group):.0f} |")

    # ---- 6. Mapas de calor
    out += ["", "## 6. Mapas de calor", "",
            "«En el rostro»: parte de la atención que cae sobre el rostro y no sobre el margen del recorte (más = mejor localizado). "
            "«Área»: fracción del recorte que se pinta. «Estabilidad»: parecido entre fotogramas consecutivos (1 = el mapa no salta).", "",
            "| Clase | Detector | En el rostro | Área pintada | Estabilidad |", "|---|---|---|---|---|"]
    for label, group in (("Real", real), ("Fake", fake)):
        for key in MODEL_KEYS:
            cams = [f["cam"][key] for r in group for f in r["frames"] if f["found"] and f.get("cam", {}).get(key)]
            stability = [r["heatmap"]["stability"][key] for r in group if r["heatmap"]["stability"].get(key) is not None]
            if cams:
                out.append(f"| {label} | {key} | {_fmt(statistics.fmean(c['on_face'] for c in cams), 2)} | {_fmt(statistics.fmean(c['area25'] for c in cams), 2)} "
                           f"| {_fmt(statistics.fmean(stability), 2) if stability else '—'} |")
    out += ["", "Color dominante de cada fotograma en la tira del informe (la pinta solo el face swap, y solo con rostro):", "",
            "| Clase | Verde (< 0.4) | Amarillo (0.4–0.7) | Naranja/rojo (≥ 0.7) | Videos con algún fotograma rojo | Videos enteramente verdes |",
            "|---|---|---|---|---|---|"]
    def painted(frame):
        return frame["p_swap"] if frame["found"] else 0.0
    for label, group in (("Real", real), ("Fake", fake)):
        peaks = [painted(f) for r in group for f in r["frames"]]
        any_red = sum(any(painted(f) >= .7 for f in r["frames"]) for r in group)
        all_green = sum(all(painted(f) < .4 for f in r["frames"]) for r in group)
        out.append(f"| {label} | {_pct(sum(p < .4 for p in peaks), len(peaks))} | {_pct(sum(.4 <= p < .7 for p in peaks), len(peaks))} "
                   f"| {_pct(sum(p >= .7 for p in peaks), len(peaks))} | {_pct(any_red, len(group))} | {_pct(all_green, len(group))} |")

    # ---- 7. Errores de la regla vigente
    wrong = [r for r in done if simulate(r, T) != r["label"]]
    out += ["", f"## 7. Videos donde la regla vigente no coincide con la etiqueta ({len(wrong)})", "",
            "«Registrado» es el veredicto que dio producción al medir; «Vigente», el de la regla actual."]
    if wrong:
        out += ["", "| Etiqueta | Vigente | Registrado | Archivo | Swap sostenido | Escena | GAN | Difusión | Rostros | Lado rostro (px) |",
                "|---|---|---|---|---|---|---|---|---|---|"]
        order = {"Fake": 0, "Real": 1, "Suspect": 2}
        for r in sorted(wrong, key=lambda r: (r["label"], order[simulate(r, T)], r["file"])):
            s = video_signals(r, probes)
            sides = [min(f["face_px"]) for f in r["frames"] if f["found"]]
            out.append(f"| {r['label']} | {simulate(r, T)} | {r['production']['prediction']} | {r['file']} "
                       f"| {_fmt(s['swap_sostenido3 (prod)'], 2)} | {_fmt(s['escena_prod (prod)'], 2)} | {_fmt(s['gan_mediana'], 2)} "
                       f"| {_fmt(s['dif_mediana'], 2)} | {len(sides)}/{len(r['frames'])} | {f'{statistics.median(sides):.0f}' if sides else '—'} |")
    else:
        out.append("Ninguno.")

    # ---- 8. Catálogo y tiempos
    out += ["", "## 8. Catálogo y tiempos", ""]
    for label, group in (("Real", real), ("Fake", fake)):
        durations = [r["meta"]["duration_s"] for r in group if r["meta"].get("duration_s")]
        sides = [min(r["meta"]["width"], r["meta"]["height"]) for r in group if r["meta"].get("width")]
        over = sum(r["meta"]["over_upload_limit"] for r in group)
        out.append(f"- {label}: duración mediana {_fmt(statistics.median(durations), 1) if durations else '—'} s, lado menor mediano "
                   f"{statistics.median(sides):.0f} px" + (f", {over} superan los 10 MB que acepta la API" if over else "") if sides else f"- {label}: sin metadatos")
    seconds = [r["timing"]["total_s"] for r in done]
    out.append(f"- Tiempo por video: mediana {_fmt(statistics.median(seconds), 0)} s (total {sum(seconds) / 60:.0f} min).")
    if failed:
        out += ["", "Con error: " + "; ".join(f"{r['file']} ({r.get('error')})" for r in failed)]
    return "\n".join(out) + "\n"


# ======================================================================
# Recolección (carga los modelos: solo se importa al analizar)
# ======================================================================
class Collector:
    """Instala espías sobre el pipeline real: producción decide; aquí solo se anota lo que ve."""

    def __init__(self, sheets_dir: Path | None, cams_dir: Path, probes: int):
        import cv2
        import numpy as np
        from app import diffusion_model, explain, faceswap_model, preprocessing, scene_model
        from app import model as M
        self.cv2, self.np, self.M, self.explain, self.scene_model, self.preprocessing = cv2, np, M, explain, scene_model, preprocessing
        self.sheets_dir, self.cams_dir, self.probes = sheets_dir, cams_dir, max(probes, M.SCENE_PROBES)
        self.recording = False
        self.frames: list[dict] = []
        self.cams: list[dict] = []
        self.scene_cache: dict[int, tuple[float, float]] = {}

        original_crop = M.crop_largest_face

        def crop(image, *args, **kwargs):
            face, found, bbox = original_crop(image, *args, **kwargs)
            if self.recording:
                self.frames.append(self._frame_stats(image, face, found, bbox))
            return face, found, bbox
        M.crop_largest_face = crop

        def spy(module, name, key):
            original = getattr(module, name)

            def wrapper(image):
                value = original(image)
                if self.recording and self.frames and key not in self.frames[-1]:
                    self.frames[-1][key] = float(value)
                return value
            setattr(module, name, wrapper)
        spy(M, "_fake_probability", "p_gan")
        spy(faceswap_model, "fake_probability", "p_swap")
        spy(diffusion_model, "fake_probability", "p_diff")

        original_snapshot = explain.FacialCapture.snapshot

        def snapshot(capture, face_size):
            cams = original_snapshot(capture, face_size)
            if self.recording:
                self.cams.append({key: np.array(value, dtype=np.float32) for key, value in cams.items()})
            return cams
        explain.FacialCapture.snapshot = snapshot

        original_scene = scene_model.fake_probability

        def scene(image):
            # Caché por objeto de imagen: lo que producción ya sondeó no se vuelve a pagar.
            if id(image) not in self.scene_cache:
                started = time.perf_counter()
                self.scene_cache[id(image)] = (float(original_scene(image)), time.perf_counter() - started)
            return self.scene_cache[id(image)][0]
        scene_model.fake_probability = scene

    def thresholds(self) -> dict:
        return {**video_rule.current_limits(),
                **{name: getattr(self.M, name) for name in ("CONTEXT_FACE_MAX_FRACTION", "SUSPECT_THRESHOLD")}}

    def heatmap_settings(self) -> dict:
        names = ["DRAW_FLOOR", "ZONE_LEVEL", "MIN_ZONE_AREA", "SMOOTH_FRACTION", "ALPHA_MIN", "ALPHA_MAX", "ALPHA_FULL_AT", "SCENE_CAM_MIN_WEIGHT", "GRAY_DIM"]
        return {name: getattr(self.explain, name) for name in names}

    def _frame_stats(self, image, face, found, bbox) -> dict:
        cv2, np = self.cv2, self.np
        width, height = image.size
        count, score = 0, None
        try:
            detector = self.preprocessing._detector
            detector.setInputSize((width, height))
            _, faces = detector.detect(cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR))
            if faces is not None and len(faces):
                count = int(len(faces))
                score = float(faces[int(np.argmax(faces[:, 2] * faces[:, 3]))][-1])
        except Exception:
            pass
        gray = cv2.cvtColor(np.array(face.convert("RGB").resize((256, 256))), cv2.COLOR_RGB2GRAY)
        return {"found": bool(found), "n_faces": count, "det_score": score, "bbox": [int(v) for v in bbox],
                "face_px": [face.width, face.height], "face_fraction": face.width * face.height / (width * height),
                "sharp": float(cv2.Laplacian(gray, cv2.CV_64F).var()), "bright": float(gray.mean()), "contrast": float(gray.std())}

    def _grid(self, cam):
        return self.np.clip(self.cv2.resize(cam, (CAM_GRID, CAM_GRID), interpolation=self.cv2.INTER_LINEAR), 0, None)

    def _cam_stats(self, cam) -> dict | None:
        np = self.np
        grid = self._grid(cam)
        total = float(grid.sum())
        if total < 1e-8:
            return None
        ys, xs = np.mgrid[0:CAM_GRID, 0:CAM_GRID]
        peak_y, peak_x = np.unravel_index(int(grid.argmax()), grid.shape)
        margin = round(CAM_GRID * (1 - FACE_SHARE_OF_CROP) / 2)
        p = grid / total
        return {"on_face": float(grid[margin:CAM_GRID - margin, margin:CAM_GRID - margin].sum() / total),
                "area25": float((grid >= 0.25 * grid.max()).mean()), "area50": float((grid >= 0.5 * grid.max()).mean()),
                "cx": float((grid * xs).sum() / total / (CAM_GRID - 1)), "cy": float((grid * ys).sum() / total / (CAM_GRID - 1)),
                "px": peak_x / (CAM_GRID - 1), "py": peak_y / (CAM_GRID - 1),
                "entropy": float(-(p * np.log(p + 1e-12)).sum() / math.log(CAM_GRID * CAM_GRID))}

    def _stability(self, grids: list) -> float | None:
        np = self.np
        values = []
        for a, b in zip(grids, grids[1:]):
            if a is None or b is None or a.std() < 1e-8 or b.std() < 1e-8:
                continue
            values.append(float(np.corrcoef(a.ravel(), b.ravel())[0, 1]))
        return statistics.fmean(values) if values else None

    def _production_picks(self, indices: list[int]) -> list[int]:
        """Espejo del muestreo de app.model._scene_probe."""
        n = self.M.SCENE_PROBES
        if len(indices) > n:
            return indices[::len(indices) // n][:n]
        return list(indices)

    def _sheet(self, record: dict, explanation: dict, target: Path) -> None:
        import base64
        import io
        from PIL import Image, ImageDraw
        strip = [f for f in explanation.get("frames", []) if f.get("image")]
        if not strip:
            return
        count = min(6, len(strip))
        chosen = [strip[round(i * (len(strip) - 1) / max(count - 1, 1))] for i in range(count)]
        tiles = []
        for frame in chosen:
            image = Image.open(io.BytesIO(base64.b64decode(frame["image"].split(",", 1)[1]))).convert("RGB")
            image.thumbnail((300, 300))
            tiles.append((image, f"F{frame.get('index', 0) + 1:02d} | {frame.get('second')} s | senal {frame.get('signal') or 0:.2f}"))
        cell_w, cell_h = max(t[0].width for t in tiles), max(t[0].height for t in tiles) + 14
        columns = 3
        rows = math.ceil(len(tiles) / columns)
        sheet = Image.new("RGB", (cell_w * columns, cell_h * rows + 34), (16, 12, 11))
        draw = ImageDraw.Draw(sheet)
        s, prod = video_signals(record, self.M.SCENE_PROBES), record["production"]
        draw.text((6, 4), f"{record['label'].upper()} -> {prod['prediction']} ({prod['confidence']}%)  {record['file']}"[:150], fill=(236, 232, 223))
        draw.text((6, 18), f"SWAP SOSTENIDO {s['swap_sostenido3 (prod)']:.2f}  ESCENA {s['escena_prod (prod)']:.2f}  ·  orientativos: GAN {s['gan_mediana']:.2f}  DIF {s['dif_mediana']:.2f}", fill=(247, 126, 13))
        for position, (image, caption) in enumerate(tiles):
            x, y = position % columns * cell_w, position // columns * cell_h + 34
            sheet.paste(image, (x, y))
            draw.text((x + 4, y + cell_h - 13), caption, fill=(147, 141, 128))
        sheet.save(target, "JPEG", quality=72)

    def analyze(self, path: Path, label: str, relative: str, progress) -> dict:
        from app.preprocessing import extract_frames
        np, M = self.np, self.M
        started = time.perf_counter()
        data = path.read_bytes()
        record: dict = {"file": relative, "label": label, "size_bytes": len(data)}
        frames = extract_frames(data)
        if not frames:
            return {**record, "ok": False, "error": "OpenCV no pudo decodificar el video"}
        meta = {"size_bytes": len(data), "over_upload_limit": len(data) > PRODUCTION_UPLOAD_LIMIT,
                "width": frames[0][0].width, "height": frames[0][0].height, "frames_extracted": len(frames)}
        stamps = [t for _, t in frames if t is not None]
        if len(stamps) >= 2:
            meta["duration_s"] = round(stamps[-1] + (stamps[-1] - stamps[0]) / (len(stamps) - 1), 2)

        self.frames, self.cams, self.scene_cache = [], [], {}
        self.recording = True
        try:
            result = M.predict_video(frames, progress_callback=lambda current, total, *_: progress(f"fotograma {current}/{total}"))
        finally:
            self.recording = False
        predict_seconds = time.perf_counter() - started
        if len(self.frames) != len(frames) or any(key not in f for f in self.frames for key in SCORE_KEYS):
            return {**record, "ok": False, "error": "los espías no cuadran con el pipeline (¿cambió predict_video?)"}

        # Sonda de escena en TODOS los videos: las sondas de producción (ya en caché si corrieron) más las extra.
        context = [i for i, f in enumerate(self.frames) if f["found"] and f["face_fraction"] <= M.CONTEXT_FACE_MAX_FRACTION]
        pool = context or list(range(len(frames)))
        picks = self._production_picks(pool)
        rest = [i for i in pool if i not in picks]
        extra_count = min(self.probes - len(picks), len(rest))
        extras = [rest[int((j + 0.5) * len(rest) / extra_count)] for j in range(extra_count)]
        probes = []
        for number, index in enumerate([*picks, *extras]):
            progress(f"sonda de escena {number + 1}/{len(picks) + len(extras)}")
            ran_in_production = id(frames[index][0]) in self.scene_cache
            score = self.scene_model.fake_probability(frames[index][0])
            probes.append({"frame": index, "production": index in picks, "ran_in_production": ran_in_production,
                           "score": round(score, 5), "seconds": round(self.scene_cache[id(frames[index][0])][1], 1)})

        # Mapas de calor: estadísticas de cada rejilla y estabilidad temporal.
        grids: dict[str, list] = {key: [] for key in (*MODEL_KEYS, "fused")}
        arrays = {}
        for index, (stats, cams) in enumerate(zip(self.frames, self.cams)):
            weights = dict(zip(MODEL_KEYS, (stats[k] for k in SCORE_KEYS)))
            stats.update(i=index, t=frames[index][1], cam={})
            fused = np.zeros((CAM_GRID, CAM_GRID), dtype=np.float32)
            for key in MODEL_KEYS:
                cam = cams.get(key)
                grids[key].append(self._grid(cam) if cam is not None and stats["found"] else None)
                if cam is None:
                    continue
                # Rejilla normalizada al recorte (28×28, float16): el CAM del B7 llega ampliado a cientos de píxeles.
                arrays[f"{index:02d}_{key}"] = self._grid(cam).astype(np.float16)
                stats["cam"][key] = self._cam_stats(cam)
                fused = np.maximum(fused, weights[key] * self._grid(cam) / max(float(self._grid(cam).max()), 1e-8))
            grids["fused"].append(fused if stats["found"] else None)
            stats["fused"] = {"peak": float(fused.max()), "area_yellow": float((fused >= 0.4).mean()), "area_red": float((fused >= 0.7).mean())}
        cam_file = self.cams_dir / (re.sub(r"[^A-Za-z0-9_.-]+", "_", f"{label}__{path.stem}") + ".npz")
        np.savez_compressed(cam_file, **arrays)

        caveats = {getattr(M, name): name.removeprefix("CAVEAT_") for name in dir(M) if name.startswith("CAVEAT_")}
        explanation = result.get("explanation") or {}
        record.update(ok=True, meta=meta, frames=[_rounded(f) for f in self.frames],
                      production={"prediction": result["prediction"], "confidence": result["confidence"], "models": result["models"],
                                  "caveat": caveats.get(result.get("caveat")), "faces_detected": result["faces_detected"],
                                  "suspicious_seconds": result.get("suspicious_seconds", []),
                                  "featured_index": explanation.get("featured_index"), "heatmaps": len(explanation.get("frames", []))},
                      scene={"pool": "context" if context else "all_frames", "n_context": len(context), "probes": probes},
                      heatmap={"stability": {key: self._stability(values) for key, values in grids.items()}, "cams_file": cam_file.name})
        if self.sheets_dir is not None:
            try:
                sheet = self.sheets_dir / (cam_file.stem + ".jpg")
                self._sheet(record, explanation, sheet)
                record["heatmap"]["sheet"] = sheet.name
            except Exception as error:  # la lámina es accesoria: nunca invalida la medición
                record["heatmap"]["sheet_error"] = type(error).__name__
        record["timing"] = {"total_s": round(time.perf_counter() - started, 1), "predict_video_s": round(predict_seconds, 1),
                            "scene_s": round(sum(p["seconds"] for p in probes), 1)}
        return record


def _rounded(value):
    if isinstance(value, float):
        return round(value, 5)
    if isinstance(value, dict):
        return {key: _rounded(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_rounded(item) for item in value]
    return value


# ======================================================================
# Ejecución
# ======================================================================
def find_videos(catalog: Path) -> tuple[list[Path], list[Path]]:
    """Videos de las carpetas Real y Fake del catálogo, en orden natural (1, 2, … 10)."""
    found: dict[str, list[Path]] = {"Real": [], "Fake": []}
    for folder in sorted(p for p in catalog.iterdir() if p.is_dir()):
        label = next((name for name, aliases in LABEL_FOLDERS.items() if folder.name.strip().lower() in aliases), None)
        if label:
            found[label] += sorted((p for p in folder.rglob("*") if p.suffix.lower() in VIDEO_SUFFIXES),
                                   key=lambda p: [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.name)])
    if not found["Real"] or not found["Fake"]:
        raise SystemExit(f"En «{catalog}» se esperan dos carpetas con videos: Real y Fake.")
    return found["Real"], found["Fake"]


def free_memory_gb() -> float | None:
    if sys.platform != "win32":
        return None
    import ctypes

    class Status(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
    status = Status(dwLength=ctypes.sizeof(Status))
    return status.ullAvailPhys / 1024 ** 3 if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)) else None


def load_records(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    latest: dict[str, dict] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            record = json.loads(line)
            latest[record["file"]] = record  # si un video se repitió, vale la última medición
    return list(latest.values())


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Mide el pipeline de detección sobre un catálogo etiquetado.")
    parser.add_argument("--catalogo", default=str(BACKEND / "Catologo de videos"), help="Carpeta con las subcarpetas Real y Fake")
    parser.add_argument("--salida", default=str(BACKEND / "calibracion"), help="Carpeta de resultados")
    parser.add_argument("--sondas", type=int, default=4, help="Sondas de escena por video (mínimo las de producción, 4). Cada una tarda ~20-30 s en CPU")
    parser.add_argument("--limite", type=int, default=0, help="Analiza solo N videos por clase (para probar)")
    parser.add_argument("--sin-laminas", action="store_true", help="No guarda las hojas de contacto de mapas de calor")
    parser.add_argument("--rehacer", action="store_true", help="Ignora lo ya medido y empieza de cero")
    parser.add_argument("--solo-resumen", action="store_true", help="No ejecuta modelos: rehace resumen.md con senales.jsonl")
    args = parser.parse_args()

    output = Path(args.salida)
    output.mkdir(parents=True, exist_ok=True)
    signals_path, config_path, summary_path = output / "senales.jsonl", output / "config.json", output / "resumen.md"

    if not args.solo_resumen:
        real, fake = find_videos(Path(args.catalogo))
        if args.limite:
            real, fake = real[:args.limite], fake[:args.limite]
        # Intercalados: si se interrumpe, lo medido queda equilibrado entre clases.
        queue = [item for pair in zip(real, fake) for item in ((pair[0], "Real"), (pair[1], "Fake"))]
        queue += [(p, "Real") for p in real[len(fake):]] + [(p, "Fake") for p in fake[len(real):]]
        if args.rehacer and signals_path.exists():
            signals_path.rename(signals_path.with_name(f"senales.{datetime.now():%Y%m%d-%H%M%S}.jsonl"))
        measured = {r["file"] for r in load_records(signals_path) if r.get("ok")}
        catalog = Path(args.catalogo)
        pending = [(p, label) for p, label in queue if p.relative_to(catalog).as_posix() not in measured]
        print(f"Catálogo: {len(real)} Real, {len(fake)} Fake · ya medidos {len(queue) - len(pending)} · pendientes {len(pending)}")
        if pending:
            free = free_memory_gb()
            if free is not None and free < 6:
                print(f"AVISO: solo hay {free:.1f} GB de RAM libres y los modelos necesitan ~5 GB. "
                      "Cierra la API, el worker de Celery y lo que no uses, o irá muy lento.")
            print("Cargando modelos (1-3 min)…", flush=True)
            import logging
            logging.basicConfig(level=logging.WARNING)
            sheets = None if args.sin_laminas else output / "laminas"
            for folder in (sheets, output / "cams"):
                if folder is not None:
                    folder.mkdir(exist_ok=True)
            collector = Collector(sheets, output / "cams", args.sondas)
            import torch
            config_path.write_text(json.dumps({
                "generated_at": datetime.now(timezone.utc).isoformat(), "thresholds": collector.thresholds(),
                "heatmap": collector.heatmap_settings(), "scene_probes_recorded": collector.probes,
                "torch": torch.__version__, "device": str(collector.M.device), "threads": torch.get_num_threads(),
                "python": sys.version.split()[0]}, indent=2, ensure_ascii=False), encoding="utf-8")
            durations: list[float] = []
            try:
                for number, (path, label) in enumerate(pending, 1):
                    relative = path.relative_to(catalog).as_posix()
                    head = f"[{number}/{len(pending)}] {relative}"
                    began = time.perf_counter()
                    try:
                        record = collector.analyze(path, label, relative, lambda text: print(f"\r{head} · {text}      ", end="", flush=True))
                    except Exception as error:  # un video ilegible no detiene el catálogo
                        record = {"file": relative, "label": label, "ok": False, "error": f"{type(error).__name__}: {error}"[:300]}
                    with signals_path.open("a", encoding="utf-8") as handle:
                        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                    durations.append(time.perf_counter() - began)
                    remaining = statistics.fmean(durations) * (len(pending) - number) / 60
                    verdict = f"{record['production']['prediction']} ({record['production']['confidence']} %)" if record.get("ok") else f"ERROR: {record.get('error')}"
                    mark = "" if not record.get("ok") or record["production"]["prediction"] == label else "  ✗" if record["production"]["prediction"] != "Suspect" else "  ?"
                    print(f"\r{head} → {verdict}{mark} · {durations[-1]:.0f} s · faltan ~{remaining:.0f} min" + " " * 12)
            except KeyboardInterrupt:
                print("\nInterrumpido. Lo medido está guardado: vuelve a ejecutar el mismo comando para continuar.")

    records = load_records(signals_path)
    if not records:
        raise SystemExit("Aún no hay mediciones en " + str(signals_path))
    config = json.loads(config_path.read_text(encoding="utf-8")) if config_path.is_file() else {}
    summary = build_summary(records, config)
    summary_path.write_text(summary, encoding="utf-8")
    print("\n" + summary.split("## 2.")[0].strip())
    print(f"\nResumen completo: {summary_path}\nSeñales por video: {signals_path}")


if __name__ == "__main__":
    main()
