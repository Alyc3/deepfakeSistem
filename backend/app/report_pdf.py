"""Generación del informe pericial PDF a partir del resultado archivado."""
from __future__ import annotations

from io import BytesIO
from typing import Any

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table
from reportlab.lib import colors
from xml.sax.saxutils import escape


def _text(value: Any) -> str:
    return str(value if value is not None else "—")


def build_forensic_pdf(*, case: Any, evidence: Any, report_id: str, result: dict,
                       original_sha256: str, working_sha256: str,
                       expert_conclusions: str | None = None) -> bytes:
    """Construye un PDF reproducible con observaciones y análisis.

    Las láminas JPEG se conservan como artefactos independientes; el PDF lleva
    el resultado estructurado y sus hashes para que pueda verificarse junto al
    manifiesto de custodia.
    """
    output = BytesIO()
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="Small", parent=styles["BodyText"], fontSize=8, leading=10))
    styles.add(ParagraphStyle(name="Section", parent=styles["Heading2"], spaceBefore=10, spaceAfter=5))
    doc = SimpleDocTemplate(output, pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm,
                            topMargin=16 * mm, bottomMargin=16 * mm,
                            title="CertiFace — Informe pericial")
    story = [Paragraph("CERTIFACE — INFORME PERICIAL DE ANÁLISIS", styles["Title"]),
             Paragraph(f"Reporte: {_text(report_id)}", styles["Small"]), Spacer(1, 8)]

    story.append(Paragraph("Identificación del expediente", styles["Section"]))
    story.append(Table([
        ["Expediente", _text(getattr(case, "case_number", None))],
        ["Título", _text(getattr(case, "title", None))],
        ["Evidencia", _text(getattr(evidence, "file_name", None))],
        ["Tipo", _text(getattr(evidence, "mime_type", None))],
        ["SHA-256 original", original_sha256],
        ["SHA-256 copia de trabajo", working_sha256],
    ], colWidths=[48 * mm, 125 * mm], style=[("GRID", (0, 0), (-1, -1), .35, colors.grey),
                                             ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#eeeeee")),
                                             ("VALIGN", (0, 0), (-1, -1), "TOP")]))

    story.append(Paragraph("Dictamen automatizado", styles["Section"]))
    story.append(Table([
        ["Resultado", _text(result.get("prediction"))],
        ["Confianza orientativa", f"{_text(result.get('confidence'))}%"],
        ["Fotogramas analizados", _text(result.get("frames_analyzed", 1))],
        ["Rostros detectados", _text(result.get("faces_detected", 0))],
        ["Tiempo de procesamiento", f"{_text(result.get('processing_time_seconds'))} s"],
    ], colWidths=[48 * mm, 125 * mm], style=[("GRID", (0, 0), (-1, -1), .35, colors.grey),
                                             ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#eeeeee"))]))

    story.append(Paragraph("Señales por modelo", styles["Section"]))
    model_rows = [["Modelo", "Señal"]]
    for name, score in (result.get("models") or {}).items():
        model_rows.append([name, _text(score)])
    story.append(Table(model_rows, colWidths=[100 * mm, 73 * mm], style=[("GRID", (0, 0), (-1, -1), .35, colors.grey),
                                                                          ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee"))]))

    caveat = result.get("caveat")
    if caveat:
        story.append(Paragraph("Reserva y limitaciones", styles["Section"]))
        story.append(Paragraph(escape(_text(caveat)), styles["BodyText"]))

    suspicious = result.get("suspicious_seconds") or []
    story.append(Paragraph("Observaciones del análisis", styles["Section"]))
    if suspicious:
        story.append(Paragraph("Momentos sospechosos: " + ", ".join(
            f"{_text(item.get('second'))} s (señal {_text(item.get('score'))})" for item in suspicious
        ), styles["BodyText"]))
    else:
        story.append(Paragraph("No se señalaron momentos sospechosos por el detector temporal.", styles["BodyText"]))

    if expert_conclusions:
        story.append(Paragraph("Observaciones y conclusión del perito", styles["Section"]))
        story.append(Paragraph(escape(_text(expert_conclusions)).replace("\n", "<br/>"), styles["BodyText"]))

    story.append(Spacer(1, 12))
    story.append(Paragraph("Este documento resume el análisis asistido por IA. La decisión pericial debe considerar la cadena de custodia, las limitaciones del modelo y la revisión humana.", styles["Small"]))
    doc.build(story)
    return output.getvalue()
