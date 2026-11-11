"""Generación del informe pericial PDF a partir del resultado archivado.

Diseño: franja oscura de la aplicación con el logo en la cabecera, cuerpo
claro y sobrio para impresión, tipografías de la interfaz (Chakra Petch,
IBM Plex) y la paleta de CertiFace. Incluye el mapa de calor destacado y la
secuencia completa de fotogramas analizados (24 en video), cada uno con su
propio mapa y su señal, para que el perito vea dónde y cuándo aparece la
manipulación.
"""
from __future__ import annotations

import base64
import logging
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.platypus import (BaseDocTemplate, CondPageBreak, Flowable, Frame, Image, KeepTogether, PageTemplate,
                                Paragraph, Spacer, Table, TableStyle)

logger = logging.getLogger("certiface.report")
ASSETS = Path(__file__).resolve().parent / "assets" / "report"

# ---------- Paleta (web/src/ui/styles/global.css) ----------
BAND = colors.HexColor("#100c0b")        # --smoky: franja de cabecera
BAND_TEXT = colors.HexColor("#ece8df")   # --text
BAND_DIM = colors.HexColor("#938d80")    # --text-dim
ORANGE = colors.HexColor("#eb4604")      # --hot-orange: manipulación, acento
AMBER = colors.HexColor("#f77e0d")       # --orange-wheel: indicios
MOSS = colors.HexColor("#99a57d")        # --moss: autenticidad
MOSS_TEXT = colors.HexColor("#6c7853")   # moss oscurecido para texto sobre papel
INK = colors.HexColor("#171614")         # texto principal sobre papel
MUTED = colors.HexColor("#6f695e")       # texto secundario (legible impreso)
RULE = colors.HexColor("#dcd8cf")        # filetes
TINT = colors.HexColor("#f6f4ef")        # paneles

# Escala de riesgo de los mapas de calor (app/explain.py, en RGB): verde → amarillo → naranja → rojo.
RISK_STOPS = [(0.0, (0, 170, 0)), (0.4, (255, 220, 0)), (0.7, (255, 140, 0)), (1.0, (230, 0, 0))]

VERDICTS = {
    "MANIPULADO": ("MANIPULADO", ORANGE,
                   "Los detectores encontraron indicios de manipulación corroborados, o una generación sintética global confirmada."),
    "ANTECEDENTES": ("INDICIOS", AMBER,
                     "Hay señales que no alcanzan a corroborarse. El material requiere la valoración del perito con las métricas de este informe."),
    "SIN_MANIPULACION": ("SIN MANIPULACIÓN", MOSS_TEXT,
                         "Los detectores no encontraron indicios de manipulación en los fotogramas analizados."),
}
MODELS = {
    "synthesis_gan": ("Síntesis GAN", "Rostros generados por completo (StyleGAN)"),
    "faceswap_dfdc": ("Face swap", "Intercambio de rostro en video (DFDC)"),
    "diffusion_modern": ("Difusión facial", "Rostros de generadores por difusión"),
    "scene_generated": ("Escena generada", "Generación en el encuadre completo"),
}

PAGE_W, PAGE_H = A4
MARGIN = 18 * mm
CONTENT_W = PAGE_W - 2 * MARGIN
FIRST_BAND = 32 * mm
LATER_BAND = 13 * mm
FOOTER_Y = 11 * mm

# ---------- Tipografía ----------
FONT = {"display": "Helvetica-Bold", "display_medium": "Helvetica-Bold", "body": "Helvetica",
        "mono": "Courier", "mono_medium": "Courier-Bold"}


def _register_fonts() -> None:
    """Fuentes de la interfaz; si faltan los archivos, se usan las estándar del PDF."""
    files = {"display": "ChakraPetch-SemiBold", "display_medium": "ChakraPetch-Medium", "body": "IBMPlexSans-Variable",
             "mono": "IBMPlexMono-Regular", "mono_medium": "IBMPlexMono-Medium"}
    for key, name in files.items():
        alias = f"CF-{name}"
        try:
            if alias not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(TTFont(alias, str(ASSETS / f"{name}.ttf")))
            FONT[key] = alias
        except Exception:
            logger.warning("Fuente %s no disponible; se usa la estándar del PDF.", name)


_register_fonts()


def _style(name: str, font: str, size: float, color=INK, leading: float | None = None, **extra) -> ParagraphStyle:
    return ParagraphStyle(name, fontName=FONT[font], fontSize=size, leading=leading or size * 1.35, textColor=color, **extra)


S = {
    "eyebrow": _style("eyebrow", "mono_medium", 7.5, ORANGE, 10),
    "title": _style("title", "display", 19, INK, 23),
    "meta": _style("meta", "mono", 7.5, MUTED, 10),
    "body": _style("body", "body", 9, INK, 13),
    "body_muted": _style("body_muted", "body", 8.5, MUTED, 12),
    "small": _style("small", "body", 7.5, MUTED, 10),
    "label": _style("label", "mono", 6.8, MUTED, 9),
    "value": _style("value", "body", 9, INK, 12),
    "mono": _style("mono", "mono", 7.6, INK, 10),
    "metric": _style("metric", "display_medium", 14, INK, 17),
    "caption": _style("caption", "mono", 6.6, INK, 8.5),
    "caption_right": _style("caption_right", "mono", 6.6, INK, 8.5, alignment=TA_RIGHT),
    "th": _style("th", "mono_medium", 6.8, MUTED, 9),
    "td": _style("td", "body", 8, INK, 10.5),
    "td_mono": _style("td_mono", "mono", 7.2, INK, 10),
}


# ---------- Utilidades ----------
def _text(value: Any) -> str:
    return escape(str(value if value not in (None, "") else "—"))


def _risk_color(signal: float) -> colors.Color:
    signal = min(max(float(signal), 0.0), 1.0)
    for (t0, c0), (t1, c1) in zip(RISK_STOPS, RISK_STOPS[1:]):
        if signal <= t1:
            k = (signal - t0) / (t1 - t0)
            return colors.Color(*[(a + (b - a) * k) / 255 for a, b in zip(c0, c1)])
    return colors.Color(*[c / 255 for c in RISK_STOPS[-1][1]])


def _percent(value: Any) -> str:
    try:
        return f"{float(value) * 100:.0f} %"
    except (TypeError, ValueError):
        return "—"


def _timecode(seconds: Any) -> str:
    try:
        total = float(seconds)
    except (TypeError, ValueError):
        return "—"
    minutes, rest = divmod(total, 60)
    return f"{int(minutes):02d}:{rest:04.1f}"


def _hex(color: colors.Color) -> str:
    return color.hexval().replace("0x", "#")


def _image(data: Any) -> bytes | None:
    if isinstance(data, str) and data.startswith("data:image/") and "," in data:
        try:
            return base64.b64decode(data.split(",", 1)[1], validate=True)
        except ValueError:
            return None
    return None


def _fit(raw: bytes, max_w: float, max_h: float) -> Image:
    width, height = ImageReader(BytesIO(raw)).getSize()
    scale = min(max_w / width, max_h / height)
    return Image(BytesIO(raw), width * scale, height * scale)


def _verdict(result: dict) -> tuple[str, colors.Color, str]:
    key = result.get("verdict_forensic")
    if key not in VERDICTS:
        key = {"Fake": "MANIPULADO", "Real": "SIN_MANIPULACION"}.get(result.get("prediction"), "ANTECEDENTES")
    return VERDICTS[key]


# ---------- Elementos gráficos ----------
class SectionTitle(Flowable):
    """Número en naranja, título y filete fino."""

    def __init__(self, number: int, title: str):
        super().__init__()
        self.number, self.title = number, title
        self.width, self.height = CONTENT_W, 9 * mm

    def draw(self):
        c = self.canv
        c.setFont(FONT["mono_medium"], 8)
        c.setFillColor(ORANGE)
        c.drawString(0, 3.2 * mm, f"{self.number:02d}")
        c.setFont(FONT["display"], 11.5)
        c.setFillColor(INK)
        c.drawString(8 * mm, 3 * mm, self.title)
        c.setStrokeColor(RULE)
        c.setLineWidth(0.6)
        c.line(0, 0.6 * mm, self.width, 0.6 * mm)


class ScoreBar(Flowable):
    """Barra horizontal con el color de la escala de riesgo."""

    def __init__(self, value: Any, width: float, height: float = 2.2 * mm):
        super().__init__()
        try:
            self.value = min(max(float(value), 0.0), 1.0)
        except (TypeError, ValueError):
            self.value = 0.0
        self.width, self.height = width, height

    def draw(self):
        c = self.canv
        c.setFillColor(TINT)
        c.setStrokeColor(RULE)
        c.setLineWidth(0.4)
        c.rect(0, 0, self.width, self.height, fill=1, stroke=1)
        if self.value > 0:
            c.setFillColor(_risk_color(self.value))
            c.rect(0, 0, self.width * self.value, self.height, fill=1, stroke=0)
        c.setStrokeColor(MUTED)
        c.setLineWidth(0.5)
        c.line(self.width * 0.5, -0.6 * mm, self.width * 0.5, self.height + 0.6 * mm)  # umbral de decisión


class RiskLegend(Flowable):
    """Degradado verde → rojo de los mapas de calor, con sus extremos rotulados."""

    def __init__(self, width: float = 70 * mm):
        super().__init__()
        self.width, self.height = width, 8 * mm

    def draw(self):
        c = self.canv
        steps = 120
        bar_y, bar_h = 3.6 * mm, 2.2 * mm
        for i in range(steps):
            c.setFillColor(_risk_color(i / (steps - 1)))
            c.rect(self.width * i / steps, bar_y, self.width / steps + 0.3, bar_h, fill=1, stroke=0)
        c.setFont(FONT["mono"], 6.2)
        c.setFillColor(MUTED)
        c.drawString(0, 0.6 * mm, "RIESGO BAJO")
        c.drawCentredString(self.width / 2, 0.6 * mm, "50 %")
        c.drawRightString(self.width, 0.6 * mm, "RIESGO ALTO")


class Dot(Flowable):
    def __init__(self, color: colors.Color, size: float = 2 * mm):
        super().__init__()
        self.color, self.width, self.height = color, size, size

    def draw(self):
        self.canv.setFillColor(self.color)
        self.canv.circle(self.width / 2, self.height / 2, self.width / 2, fill=1, stroke=0)


# ---------- Páginas ----------
def _canvas_factory(footer_left: str):
    """Canvas que conoce el total de páginas para numerar «Página X de Y»."""

    class NumberedCanvas(pdfcanvas.Canvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._pages: list[dict] = []

        def showPage(self):
            self._pages.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._pages)
            for state in self._pages:
                self.__dict__.update(state)
                self.setFont(FONT["mono"], 6.8)
                self.setFillColor(MUTED)
                self.setStrokeColor(RULE)
                self.setLineWidth(0.5)
                self.line(MARGIN, FOOTER_Y + 3.5 * mm, PAGE_W - MARGIN, FOOTER_Y + 3.5 * mm)
                self.drawString(MARGIN, FOOTER_Y, footer_left)
                self.drawRightString(PAGE_W - MARGIN, FOOTER_Y, f"Página {self._pageNumber} de {total}")
                super().showPage()
            super().save()

    return NumberedCanvas


def _wordmark(c: pdfcanvas.Canvas, x: float, y: float, size: float, spacing: float) -> None:
    """«CERTIFACE» espaciado. El espaciado vive en el estado gráfico: se aísla para no afectar al resto del texto."""
    c.saveState()
    text = c.beginText(x, y)
    text.setFont(FONT["display"], size)
    text.setCharSpace(spacing)
    text.setFillColor(BAND_TEXT)
    text.textLine("CERTIFACE")
    c.drawText(text)
    c.restoreState()


def _band(c: pdfcanvas.Canvas, *, first: bool, report_id: str, issued: str) -> None:
    height = FIRST_BAND if first else LATER_BAND
    top = PAGE_H
    c.saveState()
    c.setFillColor(BAND)
    c.rect(0, top - height, PAGE_W, height, fill=1, stroke=0)
    c.setFillColor(ORANGE)
    c.rect(0, top - height - 0.8 * mm, PAGE_W, 0.8 * mm, fill=1, stroke=0)
    logo_size = (22 if first else 8.6) * mm
    logo = ASSETS / "logo-band.png"
    x = MARGIN
    if logo.is_file():
        c.drawImage(str(logo), x, top - height + (height - logo_size) / 2, logo_size, logo_size,
                    preserveAspectRatio=True, anchor="c")
        x += logo_size + (5 if first else 3) * mm
    if first:
        mid = top - height / 2
        _wordmark(c, x, mid + 1.2 * mm, 17, 2.2)
        c.setFont(FONT["mono"], 7)
        c.setFillColor(BAND_DIM)
        c.drawString(x, mid - 4.2 * mm, "Laboratorio pericial de medios digitales")
        c.setFont(FONT["mono_medium"], 7.5)
        c.setFillColor(ORANGE)
        c.drawRightString(PAGE_W - MARGIN, mid + 2.2 * mm, "INFORME PERICIAL")
        c.setFont(FONT["mono"], 6.8)
        c.setFillColor(BAND_DIM)
        c.drawRightString(PAGE_W - MARGIN, mid - 1.6 * mm, f"N.º {report_id}")
        c.drawRightString(PAGE_W - MARGIN, mid - 5.2 * mm, issued)
    else:
        base = top - height / 2 - 1.2 * mm
        _wordmark(c, x, base, 10, 1.4)
        c.setFont(FONT["mono"], 6.8)
        c.setFillColor(BAND_DIM)
        c.drawRightString(PAGE_W - MARGIN, base, f"INFORME PERICIAL · N.º {report_id}")
    c.restoreState()


# ---------- Secciones ----------
def _kv_table(rows: list[tuple[str, Any]], value_style: str = "value") -> Table:
    data = [[Paragraph(label.upper(), S["label"]), value if isinstance(value, Flowable) else Paragraph(_text(value), S[value_style])]
            for label, value in rows]
    table = Table(data, colWidths=[46 * mm, CONTENT_W - 46 * mm])
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    return table


def _verdict_panel(result: dict) -> list[Flowable]:
    label, color, description = _verdict(result)
    left = [Paragraph("RESULTADO DEL ANÁLISIS", S["label"]), Spacer(1, 1.5 * mm),
            Paragraph(f'<font color="{_hex(color)}">{escape(label)}</font>', _style("verdict", "display", 22, INK, 25)),
            Spacer(1, 2 * mm), Paragraph(escape(description), S["body_muted"])]
    metrics = [("CONFIANZA", f"{result.get('confidence')} %" if result.get("confidence") is not None else "—"),
               ("FOTOGRAMAS", result.get("frames_analyzed", 1)), ("ROSTROS", result.get("faces_detected", 0)),
               ("TIEMPO", f"{result.get('processing_time_seconds')} s" if result.get("processing_time_seconds") is not None else "—")]
    cells = [[Paragraph(name, S["label"]), Paragraph(_text(value), S["metric"])] for name, value in metrics]
    grid = Table([[cells[0], cells[1]], [cells[2], cells[3]]], colWidths=[30 * mm, 30 * mm])
    grid.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 2),
                              ("BOTTOMPADDING", (0, 0), (-1, -1), 5), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
    panel = Table([["", left, grid]], colWidths=[1.6 * mm, CONTENT_W - 1.6 * mm - 66 * mm, 66 * mm])
    panel.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), color), ("BACKGROUND", (1, 0), (-1, 0), TINT),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (1, 0), (1, 0), 6 * mm), ("RIGHTPADDING", (1, 0), (1, 0), 6 * mm),
        ("TOPPADDING", (1, 0), (-1, 0), 5 * mm), ("BOTTOMPADDING", (1, 0), (-1, 0), 5 * mm),
        ("LINEBEFORE", (2, 0), (2, 0), 0.4, RULE), ("LEFTPADDING", (2, 0), (2, 0), 5 * mm),
    ]))
    story: list[Flowable] = [panel]
    caveat = result.get("caveat")
    if caveat:
        note = Table([["", Paragraph(f"<b>Reserva.</b> {_text(caveat)}", S["body"])]], colWidths=[0.8 * mm, CONTENT_W - 0.8 * mm])
        note.setStyle(TableStyle([("BACKGROUND", (0, 0), (0, 0), AMBER), ("LEFTPADDING", (1, 0), (1, 0), 4 * mm),
                                  ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
        story += [Spacer(1, 3 * mm), note]
    return story


def _models_table(models: dict) -> Table:
    winner = max(models, key=lambda key: models[key] or 0) if models else None
    rows = [[Paragraph("DETECTOR", S["th"]), Paragraph("ESPECIALIDAD", S["th"]), Paragraph("SEÑAL", S["th"]), ""]]
    for key, score in models.items():
        name, detail = MODELS.get(key, (key, ""))
        label = Paragraph(escape(name), _style("winner", "display_medium", 8.5, ORANGE, 10.5)) if key == winner \
            else Paragraph(escape(name), S["td"])
        rows.append([label, Paragraph(escape(detail), S["body_muted"]),
                     ScoreBar(score, 42 * mm), Paragraph(_percent(score), _style("pct", "mono_medium", 8, INK, 10, alignment=TA_RIGHT))])
    table = Table(rows, colWidths=[36 * mm, CONTENT_W - 36 * mm - 46 * mm - 16 * mm, 46 * mm, 16 * mm])
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def _featured(explanation: dict) -> list[Flowable]:
    raw = _image(explanation.get("image"))
    if not raw:
        return [Paragraph("El mapa de calor destacado no está disponible en este documento; se conserva como artefacto sellado del expediente.", S["body_muted"])]
    weights = explanation.get("weights") or {}
    signal = max([float(v) for v in weights.values()] or [0])
    caption = f"FOTOGRAMA DESTACADO · t = {_timecode(explanation.get('second'))} · SEÑAL {_percent(signal)}" \
        if explanation.get("second") is not None else f"MAPA DE CALOR · SEÑAL {_percent(signal)}"
    image = _fit(raw, CONTENT_W, 105 * mm)
    framed = Table([[image]], colWidths=[CONTENT_W])
    framed.setStyle(TableStyle([("ALIGN", (0, 0), (-1, -1), "CENTER"), ("BACKGROUND", (0, 0), (-1, -1), BAND),
                                ("TOPPADDING", (0, 0), (-1, -1), 2 * mm), ("BOTTOMPADDING", (0, 0), (-1, -1), 2 * mm)]))
    legend = Table([[Paragraph(caption, S["caption"]), RiskLegend()]], colWidths=[CONTENT_W - 72 * mm, 72 * mm])
    legend.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 2 * mm)]))
    return [KeepTogether([framed, legend]), Spacer(1, 2 * mm),
            Paragraph("Cada color es señal de los detectores sobre la imagen en escala de grises: verde indica atención con riesgo bajo; "
                      "amarillo, naranja y rojo, intensidad creciente. El recuadro naranja marca el rostro analizado.", S["small"])]


def _frames_grid(explanation: dict) -> list[Flowable]:
    frames = explanation.get("frames") or []
    featured = explanation.get("featured_index")
    columns = 4
    gap = 2.5 * mm
    cell_w = (CONTENT_W - gap * (columns - 1)) / columns
    cells, highlighted = [], []
    for position, frame in enumerate(frames):
        index = frame.get("index", position)
        signal = frame.get("signal") or 0
        raw = _image(frame.get("image"))
        box_w = cell_w - 1 * mm
        box_h = box_w * 9 / 16  # proporción del video: la lámina llena el recuadro sin franjas
        picture: Flowable = _fit(raw, box_w, box_h) if raw else \
            Paragraph("Lámina no disponible", _style("na", "mono", 6.5, BAND_DIM, 9, alignment=1))
        holder = Table([[picture]], colWidths=[box_w], rowHeights=[box_h])
        holder.setStyle(TableStyle([("ALIGN", (0, 0), (-1, -1), "CENTER"), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                                    ("BACKGROUND", (0, 0), (-1, -1), BAND), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                    ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0),
                                    ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))
        caption = Table([[Paragraph(f"F{index + 1:02d} · {_timecode(frame.get('second'))}", S["caption"]),
                          Dot(_risk_color(signal)), Paragraph(_percent(signal), S["caption_right"])]],
                        colWidths=[cell_w - 1 * mm - 15 * mm, 3 * mm, 12 * mm])
        caption.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                     ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 1.5)]))
        cells.append([holder, caption])
        if index == featured:
            slot = len(cells) - 1
            highlighted.append((slot % columns * 2, slot // columns))  # columna real (hay columnas de separación) y fila
    rows = []
    for start in range(0, len(cells), columns):
        row = []
        for cell in cells[start:start + columns]:
            row += [cell, ""]
        row += [""] * (columns * 2 - len(row))
        rows.append(row[:-1])
    widths = []
    for col in range(columns):
        widths += [cell_w] + ([gap] if col < columns - 1 else [])
    grid = Table(rows, colWidths=widths)
    commands = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0.5 * mm),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0.5 * mm), ("TOPPADDING", (0, 0), (-1, -1), 0.5 * mm),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3 * mm)]
    for cell in highlighted:
        commands.append(("BOX", cell, cell, 1, ORANGE))
    grid.setStyle(TableStyle(commands))
    high = sum(1 for frame in frames if (frame.get("signal") or 0) >= 0.5)
    intro = (f"Se analizaron {len(frames)} fotogramas repartidos a lo largo del video. Cada lámina muestra el mapa de calor de "
             f"ese instante, coloreado con su propia señal; el punto y el porcentaje resumen la señal máxima de los detectores "
             f"faciales en el fotograma. {high} de {len(frames)} superan el umbral de decisión (50 %).")
    if featured is not None:
        intro += " El recuadro naranja señala el fotograma destacado."
    return [Paragraph(escape(intro), S["body_muted"]), Spacer(1, 3 * mm), grid]


def _suspicious(result: dict) -> list[Flowable]:
    items = result.get("suspicious_seconds") or []
    if not items:
        return [Paragraph("El detector de face swap no señaló instantes por encima de su umbral (60 %).", S["body_muted"])]
    rows = [[Paragraph("INSTANTE", S["th"]), Paragraph("SEÑAL FACE SWAP", S["th"]), ""]]
    for item in items:
        rows.append([Paragraph(_timecode(item.get("second")), S["td_mono"]), ScoreBar(item.get("score"), 60 * mm),
                     Paragraph(_percent(item.get("score")), S["td_mono"])])
    table = Table(rows, colWidths=[30 * mm, 66 * mm, CONTENT_W - 96 * mm])
    table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
                               ("LEFTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 3),
                               ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    return [Paragraph("Instantes con artefactos de intercambio de rostro, para revisión manual en la línea de tiempo.", S["body_muted"]),
            Spacer(1, 2 * mm), table]


def _perito_name(perito: Any) -> str:
    if perito is None:
        return ""
    name = " ".join(part for part in [getattr(perito, "first_name", None), getattr(perito, "last_name", None)] if part)
    return name or getattr(perito, "email", "") or ""


def _conclusions(expert_conclusions: str | None, perito: Any) -> list[Flowable]:
    if expert_conclusions:
        story: list[Flowable] = [Paragraph(_text(expert_conclusions).replace("\n", "<br/>"), S["body"])]
    else:
        story = [Paragraph("Pendiente de revisión pericial. Este informe se emitió automáticamente al terminar el análisis; "
                           "la versión definitiva incluye las observaciones y la conclusión del perito.", S["body_muted"])]
    name = _perito_name(perito)
    identifier = getattr(perito, "identifier", None) if perito is not None else None
    signer = [Paragraph("PERITO RESPONSABLE", S["label"])]
    if name:
        signer.append(Paragraph(escape(name) + (f" · {escape(identifier)}" if identifier else ""), S["value"]))
    # Fila vacía alta para firmar a mano, con el filete debajo; las conclusiones y la firma no se separan.
    signatures = Table([["", "", ""], [signer, "", [Paragraph("FECHA Y LUGAR", S["label"])]]],
                       colWidths=[CONTENT_W * 0.52, CONTENT_W * 0.1, CONTENT_W * 0.38], rowHeights=[16 * mm, None])
    signatures.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                    ("LINEBELOW", (0, 0), (0, 0), 0.6, INK), ("LINEBELOW", (2, 0), (2, 0), 0.6, INK),
                                    ("TOPPADDING", (0, 1), (-1, 1), 2)]))
    return [KeepTogether([*story, Spacer(1, 4 * mm), signatures])]


def _audit(audit_events: list[dict]) -> Table:
    rows = [[Paragraph("FECHA Y HORA (UTC)", S["th"]), Paragraph("ACTOR", S["th"]), Paragraph("ACCIÓN", S["th"])]]
    for item in audit_events:
        stamp = str(item.get("timestamp") or "")
        try:
            stamp = datetime.fromisoformat(stamp).astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            pass
        rows.append([Paragraph(_text(stamp), S["td_mono"]), Paragraph(_text(item.get("actor")), S["td_mono"]),
                     Paragraph(_text(item.get("action")), S["td_mono"])])
    table = Table(rows, colWidths=[38 * mm, 52 * mm, CONTENT_W - 90 * mm], repeatRows=1)
    table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
                               ("LINEBELOW", (0, 0), (-1, 0), 0.8, INK), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                               ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    return table


# ---------- Documento ----------
def build_forensic_pdf(*, case: Any, evidence: Any, report_id: str, result: dict,
                       original_sha256: str, working_sha256: str,
                       expert_conclusions: str | None = None,
                       audit_events: list[dict] | None = None,
                       perito: Any = None, issued_at: datetime | None = None) -> bytes:
    """Construye el informe pericial.

    `result` debe traer las láminas en línea (`explanation.image` y
    `explanation.frames[].image` como data URI JPEG). Las que falten se
    indican en el documento; nunca impiden emitirlo.
    """
    issued = (issued_at or datetime.now(timezone.utc)).astimezone(timezone.utc)
    issued_text = issued.strftime("Emitido %d/%m/%Y %H:%M UTC")
    case_number = str(getattr(case, "case_number", None) or "—")
    output = BytesIO()
    doc = BaseDocTemplate(output, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
                          topMargin=LATER_BAND + 9 * mm, bottomMargin=FOOTER_Y + 8 * mm,
                          title=f"CertiFace — Informe pericial {case_number}", author="CertiFace",
                          subject="Informe pericial de análisis de autenticidad", creator="CertiFace")
    first_frame = Frame(MARGIN, doc.bottomMargin, CONTENT_W, PAGE_H - FIRST_BAND - 10 * mm - doc.bottomMargin, id="first",
                        leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    later_frame = Frame(MARGIN, doc.bottomMargin, CONTENT_W, PAGE_H - doc.topMargin - doc.bottomMargin, id="later",
                        leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    short_id = str(report_id)
    doc.addPageTemplates([
        PageTemplate(id="first", frames=[first_frame], autoNextPageTemplate="later",
                     onPage=lambda c, d: _band(c, first=True, report_id=short_id, issued=issued_text)),
        PageTemplate(id="later", frames=[later_frame],
                     onPage=lambda c, d: _band(c, first=False, report_id=short_id, issued=issued_text)),
    ])

    explanation = result.get("explanation") or {}
    story: list[Flowable] = [
        Paragraph("DICTAMEN TÉCNICO · ANÁLISIS DE AUTENTICIDAD DE MEDIOS DIGITALES", S["eyebrow"]), Spacer(1, 2 * mm),
        Paragraph(_text(getattr(case, "title", None)), S["title"]), Spacer(1, 1.5 * mm),
        Paragraph(f"Expediente {_text(case_number)} · Evidencia {_text(getattr(evidence, 'file_name', None))}", S["meta"]),
        Spacer(1, 6 * mm),
        *_verdict_panel(result),
    ]

    number = 0

    def section(title: str, *content: Flowable, keep: bool = False) -> None:
        nonlocal number
        number += 1
        block = [Spacer(1, 7 * mm), SectionTitle(number, title), Spacer(1, 3 * mm), *content]
        story.extend([KeepTogether(block)] if keep else [CondPageBreak(40 * mm), *block])

    size = getattr(evidence, "file_size_bytes", None)
    uploaded = getattr(evidence, "uploaded_at", None)
    section("Identificación del expediente", _kv_table([
        ("Expediente", case_number),
        ("Nombre del caso", getattr(case, "title", None)),
        ("Evidencia", getattr(evidence, "file_name", None)),
        ("Tipo de archivo", getattr(evidence, "mime_type", None)),
        ("Tamaño", f"{size / (1024 * 1024):.2f} MB" if isinstance(size, (int, float)) else None),
        ("Recepción", uploaded.strftime("%d/%m/%Y %H:%M UTC") if isinstance(uploaded, datetime) else None),
        ("Perito responsable", _perito_name(perito) or None),
    ]), keep=True)

    match = original_sha256 == working_sha256
    status = (f'<font color="{_hex(MOSS_TEXT)}">Coinciden</font>: la copia analizada es idéntica al original preservado.' if match
              else "La copia de trabajo tiene su propia huella; ambas se verificaron contra el manifiesto firmado.")
    section("Integridad de la evidencia", _kv_table([
        ("SHA-256 original", Paragraph(escape(original_sha256), S["mono"])),
        ("SHA-256 copia de trabajo", Paragraph(escape(working_sha256), S["mono"])),
        ("Verificación", Paragraph(status, S["value"])),
    ]), Spacer(1, 2 * mm),
        Paragraph("El análisis se ejecutó exclusivamente sobre la copia de trabajo. El original permanece cifrado y sellado bajo "
                  "custodia; cualquier alteración posterior de la evidencia cambiaría estas huellas.", S["small"]), keep=True)

    models = result.get("models") or {}
    if models:
        section("Señales por detector", _models_table(models), Spacer(1, 2 * mm),
                Paragraph("La barra muestra la probabilidad de manipulación de cada detector; la línea vertical marca el umbral de "
                          "decisión (50 %). En naranja, el detector con la señal decisoria.", S["small"]), keep=True)

    if explanation:
        section("Mapa de calor destacado", *_featured(explanation))
    if explanation.get("frames"):
        # Título, introducción y cuadrícula juntos: 24 láminas caben en una página.
        section("Secuencia de fotogramas analizados", *_frames_grid(explanation), keep=True)
    if result.get("frames_analyzed", 1) > 1 or result.get("suspicious_seconds"):
        section("Momentos sospechosos", *_suspicious(result), keep=True)
    section("Observaciones y conclusión del perito", *_conclusions(expert_conclusions, perito))
    if audit_events:
        section("Trazabilidad de la cadena de custodia", _audit(audit_events))

    story += [Spacer(1, 8 * mm), Paragraph(
        "Metodología: detección asistida por modelos de aprendizaje profundo especializados por familia de manipulación "
        "(GAN, face swap, difusión y generación de escena) y mapas de atención EigenCAM. Los mapas indican qué regiones "
        "influyeron en los detectores; no son una segmentación ni una probabilidad por píxel. Este documento resume un "
        "análisis asistido por IA: la decisión pericial debe considerar la cadena de custodia, las limitaciones de los "
        "modelos y la revisión humana.", S["small"])]

    doc.build(story, canvasmaker=_canvas_factory(f"CertiFace · Expediente {case_number} · {issued_text}"))
    return output.getvalue()
