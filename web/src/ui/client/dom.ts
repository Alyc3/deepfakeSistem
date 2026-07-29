/**
 * Interfaz — Acceso al documento.
 *
 * Único lugar donde se buscan nodos por identificador. Los accesos son
 * perezosos y memorizados: si el guion se evalúa antes de que exista un
 * nodo, no se rompe nada, y si un identificador desaparece del HTML el
 * fallo salta con el nombre exacto en lugar de un `null` silencioso.
 */

const cache = new Map<string, HTMLElement>();

function need<T extends HTMLElement>(id: string): T {
  const cached = cache.get(id);
  if (cached?.isConnected) return cached as T;
  const node = document.getElementById(id);
  if (!node) throw new Error(`CertiFace: falta el elemento #${id} en el documento.`);
  cache.set(id, node);
  return node as T;
}

export const el = {
  // vistas
  get viewLanding() { return need<HTMLElement>("view-landing"); },
  get viewLogin() { return need<HTMLElement>("view-login"); },
  get viewApp() { return need<HTMLElement>("view-app"); },

  // portada
  get landingEnter() { return need<HTMLButtonElement>("landing-enter"); },
  get landingEnterTop() { return need<HTMLButtonElement>("landing-enter-top"); },
  get landingProtocol() { return need<HTMLButtonElement>("landing-protocol"); },
  get protocol() { return need<HTMLElement>("protocol"); },

  // acceso
  get loginForm() { return need<HTMLFormElement>("login-form"); },
  get loginTitle() { return need<HTMLElement>("login-title"); },
  get loginHint() { return need<HTMLElement>("login-hint"); },
  get loginUser() { return need<HTMLInputElement>("login-user"); },
  get loginPass() { return need<HTMLInputElement>("login-pass"); },
  get loginError() { return need<HTMLElement>("login-error"); },
  get loginSubmit() { return need<HTMLButtonElement>("login-submit"); },
  get loginBack() { return need<HTMLButtonElement>("login-back"); },

  // laboratorio
  get analystName() { return need<HTMLElement>("analyst-name"); },
  get logout() { return need<HTMLButtonElement>("logout"); },
  get statusDot() { return need<HTMLElement>("status-dot"); },
  get statusText() { return need<HTMLButtonElement>("status-text"); },
  get settingsToggle() { return need<HTMLButtonElement>("settings-toggle"); },
  get settingsPanel() { return need<HTMLElement>("settings-panel"); },
  get apiUrl() { return need<HTMLInputElement>("api-url"); },
  get settingsSave() { return need<HTMLButtonElement>("settings-save"); },

  // cámara de evidencia
  get fileInput() { return need<HTMLInputElement>("file-input"); },
  get dropzone() { return need<HTMLButtonElement>("dropzone"); },
  get dropzoneLabel() { return need<HTMLElement>("dropzone-label"); },
  get previewFrame() { return need<HTMLElement>("preview-frame"); },
  get preview() { return need<HTMLElement>("preview-container"); },
  get scanOverlay() { return need<HTMLElement>("scan-overlay"); },
  get analyze() { return need<HTMLButtonElement>("analyze"); },
  get custody() { return need<HTMLElement>("custody"); },
  get custodyState() { return need<HTMLElement>("custody-state"); },
  get custodyDigest() { return need<HTMLElement>("custody-digest"); },
  get custodyCopy() { return need<HTMLButtonElement>("custody-copy"); },
  get custodyExpected() { return need<HTMLInputElement>("custody-expected"); },
  get custodyNote() { return need<HTMLElement>("custody-note"); },
  get reset() { return need<HTMLButtonElement>("reset"); },
  get historySection() { return need<HTMLElement>("history-section"); },
  get historyList() { return need<HTMLUListElement>("history-list"); },
  get historyClear() { return need<HTMLButtonElement>("history-clear"); },

  // registro del análisis y dictamen
  get analysisLog() { return need<HTMLOListElement>("analysis-log"); },
  get analysisElapsed() { return need<HTMLElement>("analysis-elapsed"); },
  get result() { return need<HTMLElement>("result"); },
  get resultTitle() { return need<HTMLElement>("result-title"); },
  get resultStamp() { return need<HTMLElement>("result-stamp"); },
  get resultConfidence() { return need<HTMLElement>("result-confidence"); },
  get resultBar() { return need<HTMLElement>("result-bar"); },
  get resultModels() { return need<HTMLElement>("result-models"); },
  get resultSuspects() { return need<HTMLElement>("result-suspects"); },
  get resultCaveat() { return need<HTMLElement>("result-caveat"); },
  get resultFrames() { return need<HTMLElement>("result-frames"); },
  get resultIntegrity() { return need<HTMLElement>("result-integrity"); },

  // mapa de calor
  get heatmap() { return need<HTMLElement>("heatmap"); },
  get heatmapFigure() { return need<HTMLElement>("heatmap-figure"); },
  get heatmapImage() { return need<HTMLImageElement>("heatmap-image"); },
  get heatmapFrame() { return need<HTMLElement>("heatmap-frame"); },
  get heatmapWeights() { return need<HTMLElement>("heatmap-weights"); },
  get heatmapStripWrap() { return need<HTMLElement>("heatmap-strip-wrap"); },
  get heatmapStrip() { return need<HTMLElement>("heatmap-strip"); },
  get heatmapStripTitle() { return need<HTMLElement>("heatmap-strip-title"); },

  // peritaje manual
  get checklist() { return need<HTMLElement>("checklist"); },
  get checklistItems() { return need<HTMLElement>("checklist-items"); },
  get checklistScore() { return need<HTMLElement>("checklist-score"); },
  get checklistSubmit() { return need<HTMLButtonElement>("checklist-submit"); },

  get toast() { return need<HTMLElement>("toast"); },
};
