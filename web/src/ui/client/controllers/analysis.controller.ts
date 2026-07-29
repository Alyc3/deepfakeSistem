/**
 * Interfaz — Ejecución del análisis.
 *
 * Somete el material al ensamble pericial y despliega la traza del
 * procedimiento con los datos reales de la respuesta.
 */
import {
  MODEL_SEQUENCE,
  frameSignalRange,
  type AnalysisResult,
} from "@domain/analysis";
import { MODEL_NAMES, pctOf, verdictOf } from "@domain/verdict";
import { el } from "../dom";
import { state } from "../state";
import { lab } from "../lab";
import { showToast } from "../toast";
import { addLog, clearLog, startPending, stopPending, wait } from "../analysis-log";
import { clearAnalysisOutputs } from "../presenters/clear";
import { renderResult } from "../presenters/result.presenter";
import { renderHeatmap } from "../presenters/heatmap.presenter";
import { showChecklist } from "../presenters/checklist.presenter";
import { renderHistory } from "../presenters/history.presenter";
import { setBackendOffline, setBackendOnline } from "./settings.controller";
import { integrityLogLine, verifyBeforeAnalysis } from "./custody.controller";

/** Escalonado de lectura del registro: los datos ya están calculados. */
const STEP_MS = 220;

export function setLoading(loading: boolean): void {
  state.loading = loading;
  el.scanOverlay.hidden = !loading || !state.file;
  el.analyze.disabled = loading || !state.file;
  el.analyze.textContent = loading
    ? "Analizando…"
    : state.file?.kind === "video"
      ? "Ejecutar análisis de video"
      : "Ejecutar análisis";
}

export async function analyze(): Promise<void> {
  const file = state.file;
  if (!file || state.loading) return;

  setLoading(true);
  clearAnalysisOutputs();
  clearLog(null);

  const kb = (file.size / 1024).toFixed(0);
  addLog(`Material validado: ${file.name} (${file.kind}, ${kb} KB)`);

  // Cadena de custodia: la huella se recalcula sobre el archivo que se va a
  // enviar y se contrasta con la de la recepción. Advierte, no bloquea.
  const integrity = await verifyBeforeAnalysis();
  const line = integrityLogLine(integrity);
  addLog(line.text, line.status);
  if (integrity?.status === "mismatch") {
    showToast(
      "La huella no coincide con la registrada en la recepción: el material fue alterado. El análisis continúa.",
    );
  }

  addLog(`Enviado al backend ${state.settings.apiUrl}`);
  startPending(
    file.kind === "video"
      ? "Análisis en curso: extracción, rostros y peritos por fotograma"
      : "Análisis en curso",
  );

  const started = performance.now();
  const outcome = await lab().analyzeEvidence(file);
  const elapsed = ((performance.now() - started) / 1000).toFixed(0);

  setLoading(false);

  if (!outcome.ok) {
    stopPending();
    addLog(outcome.error, "warn");
    setBackendOffline();
    showToast(outcome.error);
    return;
  }

  stopPending(`Análisis completado en ${elapsed}s`);
  setBackendOnline();

  await renderAnalysisSteps(outcome.result);
  renderResult(outcome.result);
  renderHeatmap(outcome.result);
  if (outcome.result.prediction === "Suspect") showChecklist();

  state.history = lab().recordCase({
    name: file.name,
    prediction: outcome.result.prediction,
    confidence: outcome.result.confidence,
    kind: file.kind,
  });
  renderHistory();
}

/* Despliega en el log, con los datos reales de la respuesta, cada etapa del
   procedimiento pericial. */
async function renderAnalysisSteps(result: AnalysisResult): Promise<void> {
  if (result.frames_analyzed) {
    addLog(
      `Fotogramas extraídos: ${result.frames_analyzed}, repartidos por toda la línea de tiempo`,
    );
    await wait(STEP_MS);

    addLog(
      `Detección facial (YuNet): rostro en ${result.faces_detected} de ${result.frames_analyzed} fotogramas`,
      result.faces_detected === 0 ? "warn" : "done",
    );
    await wait(STEP_MS);

    const range = frameSignalRange(result);
    if (range) {
      addLog(`Señal por fotograma: mín ${pctOf(range.min)} · máx ${pctOf(range.max)}`);
      await wait(STEP_MS);
    }
  } else {
    addLog(
      `Detección facial (YuNet): ${
        result.faces_detected ? "rostro localizado y recortado" : "sin rostro detectable"
      }`,
      result.faces_detected ? "done" : "warn",
    );
    await wait(STEP_MS);
  }

  const models = result.models ?? {};
  for (const key of MODEL_SEQUENCE) {
    const signal = models[key];
    if (signal === undefined) continue;
    addLog(`${MODEL_NAMES[key]}: señal ${pctOf(signal)}`, signal > 0.5 ? "note" : "done");
    await wait(STEP_MS);
  }

  const suspects = result.suspicious_seconds ?? [];
  if (result.frames_analyzed) {
    addLog(
      suspects.length
        ? `Momentos sospechosos: ${suspects.map((s) => `${s.second}s`).join(" · ")}`
        : "Sin momentos sospechosos señalados",
      suspects.length ? "note" : "done",
    );
    await wait(STEP_MS);
  }

  if (result.caveat) {
    addLog(
      result.prediction === "Suspect"
        ? "Dictamen con reserva: revisar el peritaje manual"
        : "Nota del dictamen: señal facial atribuida a filtros o procesado de cámara",
      "note",
    );
    await wait(STEP_MS);
  }

  if (result.explanation) {
    const maps = result.explanation.frames?.length ?? 0;
    addLog(
      maps > 1
        ? `Mapas de calor explicativos: ${maps}, uno por fotograma analizado (EigenCAM fusionado de los peritos)`
        : "Mapa de calor explicativo generado (EigenCAM fusionado de los peritos)",
    );
    await wait(STEP_MS);
  }

  addLog(
    `Dictamen: ${verdictOf(result.prediction).stamp} (${result.confidence}%)`,
    result.prediction === "Fake" ? "warn" : result.prediction === "Suspect" ? "note" : "done",
  );
}

export function wireAnalysis(): void {
  el.analyze.addEventListener("click", () => void analyze());
}
