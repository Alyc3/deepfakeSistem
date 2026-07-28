/**
 * Interfaz — Arranque del laboratorio.
 *
 * Carga el estado persistido, conecta los controladores con el documento y
 * muestra la primera vista. Toda la comunicación con el backend y con el
 * almacenamiento pasa por los casos de uso: aquí no hay ni una llamada a
 * `fetch` ni a `localStorage`.
 */
import { el } from "./dom";
import { state } from "./state";
import { lab } from "./lab";
import { showView } from "./view-router";
import { wireAuth, loadSession } from "./controllers/auth.controller";
import { wireEvidence, setFile } from "./controllers/evidence.controller";
import { wireAnalysis } from "./controllers/analysis.controller";
import { wireSettings, loadSettings } from "./controllers/settings.controller";
import { wireShortcuts } from "./controllers/shortcuts";
import { renderHistory } from "./presenters/history.presenter";
import { emitFinalVerdict } from "./presenters/checklist.presenter";
import { toggleHeatmapZoom } from "./presenters/heatmap.presenter";

function wireOutputs(): void {
  el.checklistSubmit.addEventListener("click", emitFinalVerdict);
  el.heatmapFigure.addEventListener("click", () => toggleHeatmapZoom());
  el.historyClear.addEventListener("click", () => {
    state.history = lab().clearCases();
    renderHistory();
  });
}

export function startLab(): void {
  loadSettings();
  loadSession();
  state.history = lab().listCases();

  renderHistory();
  setFile(null);

  wireAuth();
  wireEvidence();
  wireAnalysis();
  wireSettings();
  wireOutputs();
  wireShortcuts();

  showView("landing");
}
