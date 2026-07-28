/**
 * Interfaz — Borrado de todo lo que produjo un análisis.
 *
 * Vive aparte para que los presentadores no tengan que conocerse entre sí.
 */
import { state } from "../state";
import { clearDictamen } from "./result.presenter";
import { clearHeatmap } from "./heatmap.presenter";
import { clearChecklist } from "./checklist.presenter";

export function clearAnalysisOutputs(): void {
  clearDictamen();
  clearHeatmap();
  clearChecklist();
  state.lastResult = null;
}
