/**
 * Interfaz — Dictamen preliminar.
 */
import type { AnalysisResult } from "@domain/analysis";
import { lacksFace } from "@domain/analysis";
import { signalLegend, verdictOf, type Prediction } from "@domain/verdict";
import { el } from "../dom";
import { state } from "../state";
import { showToast } from "../toast";

export function renderResult(result: AnalysisResult): void {
  // El backend responde "Real", "Fake" o "Suspect" (backend/app/model.py).
  state.lastResult = result;
  el.resultTitle.textContent = "Dictamen preliminar";

  const verdict = verdictOf(result.prediction);
  el.result.dataset.verdict = verdict.key;
  el.resultStamp.textContent = verdict.stamp;
  el.resultConfidence.textContent = `${verdict.confidenceLabel}: ${result.confidence}%`;
  el.resultBar.style.width = `${result.confidence}%`;

  if (result.caveat) {
    el.resultCaveat.textContent = result.caveat;
    el.resultCaveat.hidden = false;
  } else {
    el.resultCaveat.hidden = true;
  }

  if (result.models) {
    // Orden descendente; la señal que fija el dictamen va marcada con ▸.
    el.resultModels.textContent = signalLegend(result.models as Record<string, number>);
    el.resultModels.hidden = false;
  } else {
    el.resultModels.hidden = true;
  }

  // Momentos del video que superaron el umbral de sospecha: son los puntos
  // que el perito debe revisar a mano en la vista previa.
  const suspects = result.suspicious_seconds ?? [];
  if (suspects.length > 0) {
    const shown = suspects.slice(0, 5).map((s) => `${s.second}s`).join(" · ");
    const extra = suspects.length > 5 ? ` (+${suspects.length - 5} más)` : "";
    el.resultSuspects.textContent = `REVISAR EN: ${shown}${extra}`;
    el.resultSuspects.hidden = false;
  } else {
    el.resultSuspects.hidden = true;
  }

  if (result.frames_analyzed) {
    el.resultFrames.textContent =
      `${result.frames_analyzed} FOTOGRAMAS · ${result.faces_detected ?? "?"} CON ROSTRO`;
    el.resultFrames.hidden = false;
  } else {
    el.resultFrames.hidden = true;
  }

  // Sin rostro detectable el dictamen pierde base metodológica: avisar.
  if (lacksFace(result)) {
    showToast("No se detectó ningún rostro en el material; el dictamen pierde fiabilidad.");
  }

  el.result.hidden = false;
}

/** Reescribe el dictamen con la resolución del peritaje manual. */
export function stampFinalVerdict(
  prediction: Prediction,
  modelConfidence: number,
  explanation: string,
): void {
  const verdict = verdictOf(prediction);
  el.resultTitle.textContent = "Dictamen final del perito";
  el.result.dataset.verdict = verdict.key;
  el.resultStamp.textContent = verdict.stamp;
  el.resultConfidence.textContent =
    `Dictamen combinado · señal de modelos ${modelConfidence}%`;
  el.resultCaveat.textContent = explanation;
  el.resultCaveat.hidden = false;
}

export function clearDictamen(): void {
  el.result.hidden = true;
  el.resultFrames.hidden = true;
  el.resultBar.style.width = "0%";
}
