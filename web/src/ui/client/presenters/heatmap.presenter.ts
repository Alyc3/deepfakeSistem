/**
 * Interfaz — Mapa de calor explicativo.
 *
 * El backend entrega las imágenes ya compuestas (EigenCAM fusionado por
 * máximo ponderado, coloreado en escala de riesgo): la del fotograma
 * destacado y la de **cada fotograma analizado**. Aquí se muestran, se
 * etiquetan con la ponderación de cada perito y se deja recorrer la
 * secuencia completa para ver cómo evoluciona la atención a lo largo del
 * video.
 */
import type { AnalysisResult, Explanation, ExplanationFrame } from "@domain/analysis";
import { signalLegend, pctOf } from "@domain/verdict";
import { riskClass, RISK_LABELS, riskBand } from "@domain/risk";
import { el } from "../dom";

interface HeatmapView {
  explanation: Explanation;
  frames: ExplanationFrame[];
  selected: number;
}

let view: HeatmapView | null = null;

const secondLabel = (second: number | null): string =>
  second != null ? `t=${second}s` : "IMAGEN";

/** Pinta en el visor grande el fotograma `position` de la tira. */
function showFrame(position: number): void {
  if (!view || !view.frames.length) return;
  const total = view.frames.length;
  const index = ((position % total) + total) % total;
  const frame = view.frames[index]!;
  view.selected = index;

  el.heatmapImage.src = frame.image;
  el.heatmapFrame.textContent =
    frame.index === view.explanation.featured_index
      ? `${secondLabel(frame.second)} — EL DE MAYOR SEÑAL`
      : `${secondLabel(frame.second)} — FOTOGRAMA ${index + 1}/${total}`;
  el.heatmapWeights.textContent = `PONDERACIÓN: ${signalLegend(frame.weights ?? {})}`;

  for (const button of el.heatmapStrip.children) {
    const isSelected = Number((button as HTMLElement).dataset.position) === index;
    button.classList.toggle("selected", isSelected);
    button.setAttribute("aria-selected", String(isSelected));
    if (isSelected) {
      (button as HTMLElement).scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
}

function buildStrip(frames: ExplanationFrame[], featuredIndex?: number): void {
  el.heatmapStrip.replaceChildren();

  frames.forEach((frame, position) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "heat-thumb";
    button.dataset.position = String(position);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", "false");

    const isFeatured = frame.index === featuredIndex;
    if (isFeatured) button.classList.add("is-featured");

    const image = document.createElement("img");
    image.src = frame.image;
    image.loading = "lazy";
    image.alt = `Mapa de calor del fotograma ${secondLabel(frame.second)}`;

    const meta = document.createElement("span");
    meta.className = "heat-thumb-meta";

    // El destacado se marca con una insignia sobre la miniatura, no en la
    // línea de datos: así todas las celdas miden lo mismo.
    const time = document.createElement("span");
    time.className = "heat-thumb-time";
    time.textContent = secondLabel(frame.second);

    const signal = document.createElement("span");
    signal.className = `heat-thumb-signal ${riskClass(frame.signal)}`;
    signal.textContent = pctOf(frame.signal);

    button.title =
      `Fotograma ${secondLabel(frame.second)} · señal ${pctOf(frame.signal)} ` +
      `(${RISK_LABELS[riskBand(frame.signal)]})`;

    meta.append(time, signal);
    button.append(image, meta);
    button.addEventListener("click", () => showFrame(position));
    el.heatmapStrip.appendChild(button);
  });
}

export function renderHeatmap(result: AnalysisResult): void {
  const explanation = result.explanation;
  if (!explanation?.image) {
    clearHeatmap();
    return;
  }

  // En imagen no hay tira: el único mapa es el de la propia imagen. En video
  // el destacado se muestra a través de la tira, para que el visor grande y
  // la selección compartan una sola fuente de verdad.
  const frames = explanation.frames ?? [];
  view = { explanation, frames, selected: 0 };

  if (frames.length > 1) {
    buildStrip(frames, explanation.featured_index);
    el.heatmapStripTitle.textContent = `Fotogramas analizados (${frames.length})`;
    el.heatmapStripWrap.hidden = false;
    const featured = frames.findIndex((f) => f.index === explanation.featured_index);
    showFrame(featured >= 0 ? featured : 0);
  } else {
    el.heatmapStrip.replaceChildren();
    el.heatmapStripWrap.hidden = true;
    el.heatmapImage.src = explanation.image;
    el.heatmapFrame.textContent =
      explanation.second != null
        ? `FOTOGRAMA t=${explanation.second}s — EL DE MAYOR SEÑAL`
        : "IMAGEN ANALIZADA";
    el.heatmapWeights.textContent =
      `PONDERACIÓN: ${signalLegend(explanation.weights ?? {})}`;
  }

  el.heatmap.hidden = false;
}

/** Recorre la tira con el teclado (← →). */
export function stepHeatmapFrame(delta: number): boolean {
  if (!view || view.frames.length <= 1 || el.heatmap.hidden) return false;
  showFrame(view.selected + delta);
  return true;
}

export const heatmapHasStrip = (): boolean =>
  Boolean(view && view.frames.length > 1) && !el.heatmap.hidden;

export function toggleHeatmapZoom(force?: boolean): void {
  el.heatmapFigure.classList.toggle("expanded", force);
}

export const heatmapIsExpanded = (): boolean =>
  el.heatmapFigure.classList.contains("expanded");

export function clearHeatmap(): void {
  view = null;
  el.heatmap.hidden = true;
  el.heatmapImage.removeAttribute("src");
  el.heatmapFigure.classList.remove("expanded");
  el.heatmapStrip.replaceChildren();
  el.heatmapStripWrap.hidden = true;
}
