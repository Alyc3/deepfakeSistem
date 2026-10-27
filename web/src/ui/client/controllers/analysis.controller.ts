/**
 * Interfaz â€” EjecuciÃ³n del anÃ¡lisis.
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

/** Escalonado de lectura del registro: los datos ya estÃ¡n calculados. */
const STEP_MS = 220;

export function setLoading(loading: boolean): void {
  state.loading = loading;
  el.scanOverlay.hidden = !loading || !state.file;
  el.analyze.disabled = loading || !state.file;
  el.analyze.textContent = loading
    ? "Analizandoâ€¦"
    : state.file?.kind === "video"
      ? "Ejecutar anÃ¡lisis de video"
      : "Ejecutar anÃ¡lisis";
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
  // enviar y se contrasta con la de la recepciÃ³n. Una discrepancia bloquea el análisis.
  const integrity = await verifyBeforeAnalysis();
  const line = integrityLogLine(integrity);
  addLog(line.text, line.status);
  if (integrity?.status === "mismatch") {
    showToast(
      "La huella no coincide con la recepción. El análisis se ha bloqueado.",
    );
    setLoading(false);
    return;
  }

  addLog(`Enviado al backend ${state.settings.apiUrl}`);
  startPending(
    file.kind === "video"
      ? "AnÃ¡lisis en curso: extracciÃ³n, rostros y peritos por fotograma"
      : "AnÃ¡lisis en curso",
  );

  const sessionToken = lab().identity.current()?.id;
  const started = performance.now();
  const outcome = await lab().analyzeEvidence({ ...file, expectedSha256: integrity?.algorithm === "SHA-256" ? integrity.declared ?? undefined : undefined });
  if (sessionToken !== lab().identity.current()?.id) { stopPending(); setLoading(false); return; }
  const elapsed = ((performance.now() - started) / 1000).toFixed(0);

  setLoading(false);

  if (!outcome.ok) {
    stopPending();
    addLog(outcome.error, "warn");
    setBackendOffline();
    showToast(outcome.error);
    return;
  }

  stopPending(`AnÃ¡lisis completado en ${elapsed}s`);
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
      `Fotogramas extraÃ­dos: ${result.frames_analyzed}, repartidos por toda la lÃ­nea de tiempo`,
    );
    await wait(STEP_MS);

    addLog(
      `DetecciÃ³n facial (YuNet): rostro en ${result.faces_detected} de ${result.frames_analyzed} fotogramas`,
      result.faces_detected === 0 ? "warn" : "done",
    );
    await wait(STEP_MS);

    const range = frameSignalRange(result);
    if (range) {
      addLog(`SeÃ±al por fotograma: mÃ­n ${pctOf(range.min)} Â· mÃ¡x ${pctOf(range.max)}`);
      await wait(STEP_MS);
    }
  } else {
    addLog(
      `DetecciÃ³n facial (YuNet): ${
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
    addLog(`${MODEL_NAMES[key]}: seÃ±al ${pctOf(signal)}`, signal > 0.5 ? "note" : "done");
    await wait(STEP_MS);
  }

  const suspects = result.suspicious_seconds ?? [];
  if (result.frames_analyzed) {
    addLog(
      suspects.length
        ? `Momentos sospechosos: ${suspects.map((s) => `${s.second}s`).join(" Â· ")}`
        : "Sin momentos sospechosos seÃ±alados",
      suspects.length ? "note" : "done",
    );
    await wait(STEP_MS);
  }

  if (result.caveat) {
    addLog(
      result.prediction === "Suspect"
        ? "Dictamen con reserva: revisar el peritaje manual"
        : "Nota del dictamen: seÃ±al facial atribuida a filtros o procesado de cÃ¡mara",
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
