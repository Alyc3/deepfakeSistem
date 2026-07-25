// Interfaz de CertiFace. Tres vistas (landing → login → laboratorio) sobre un
// mismo documento. Toda la comunicación con el backend y el disco pasa por
// window.api (preload.js): aquí no hay acceso directo a Node.

const el = {
  views: {
    landing: document.getElementById("view-landing"),
    login: document.getElementById("view-login"),
    app: document.getElementById("view-app"),
  },
  // landing
  landingEnter: document.getElementById("landing-enter"),
  landingEnterTop: document.getElementById("landing-enter-top"),
  landingProtocol: document.getElementById("landing-protocol"),
  // login
  loginForm: document.getElementById("login-form"),
  loginTitle: document.getElementById("login-title"),
  loginHint: document.getElementById("login-hint"),
  loginUser: document.getElementById("login-user"),
  loginPass: document.getElementById("login-pass"),
  loginError: document.getElementById("login-error"),
  loginSubmit: document.getElementById("login-submit"),
  loginBack: document.getElementById("login-back"),
  // app
  analystName: document.getElementById("analyst-name"),
  logout: document.getElementById("logout"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  settingsToggle: document.getElementById("settings-toggle"),
  settingsPanel: document.getElementById("settings-panel"),
  apiUrl: document.getElementById("api-url"),
  settingsSave: document.getElementById("settings-save"),
  dropzone: document.getElementById("dropzone"),
  dropzoneLabel: document.getElementById("dropzone-label"),
  previewFrame: document.getElementById("preview-frame"),
  preview: document.getElementById("preview-container"),
  scanOverlay: document.getElementById("scan-overlay"),
  analyze: document.getElementById("analyze"),
  result: document.getElementById("result"),
  resultStamp: document.getElementById("result-stamp"),
  resultConfidence: document.getElementById("result-confidence"),
  resultModels: document.getElementById("result-models"),
  resultSuspects: document.getElementById("result-suspects"),
  resultCaveat: document.getElementById("result-caveat"),
  resultTitle: document.getElementById("result-title"),
  analysisLog: document.getElementById("analysis-log"),
  analysisElapsed: document.getElementById("analysis-elapsed"),
  checklist: document.getElementById("checklist"),
  checklistItems: document.getElementById("checklist-items"),
  checklistScore: document.getElementById("checklist-score"),
  checklistSubmit: document.getElementById("checklist-submit"),
  resultBar: document.getElementById("result-bar"),
  resultFrames: document.getElementById("result-frames"),
  reset: document.getElementById("reset"),
  historySection: document.getElementById("history-section"),
  historyList: document.getElementById("history-list"),
  historyClear: document.getElementById("history-clear"),
  toast: document.getElementById("toast"),
};

const state = {
  file: null,
  loading: false,
  settings: { apiUrl: "http://127.0.0.1:8000", history: [] },
  auth: { registered: false, loggedIn: false, analyst: null },
  lastResult: null,
  checklistAnswers: {},
};

let toastTimer = null;

function showToast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 3500);
}

/* ---------- registro del análisis (log paso a paso) ---------- */

let pendingLine = null;
let elapsedTimer = null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clearLog(placeholder = "A la espera de material…") {
  stopPending();
  el.analysisLog.replaceChildren();
  if (placeholder) {
    const li = document.createElement("li");
    li.className = "log-line log-line--idle";
    li.textContent = placeholder;
    el.analysisLog.appendChild(li);
  }
  el.analysisElapsed.hidden = true;
}

function addLog(text, status = "done") {
  const idle = el.analysisLog.querySelector(".log-line--idle");
  if (idle) idle.remove();

  const li = document.createElement("li");
  li.className = `log-line log-line--${status}`;

  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString();

  const marker = document.createElement("span");
  marker.className = "log-marker";
  marker.textContent = { done: "✓", pending: "◌", warn: "✗", note: "▸" }[status] || "·";

  const body = document.createElement("span");
  body.className = "log-text";
  body.textContent = text;

  li.append(time, marker, body);
  el.analysisLog.appendChild(li);
  el.analysisLog.scrollTop = el.analysisLog.scrollHeight;
  return li;
}

function startPending(text) {
  stopPending();
  pendingLine = addLog(`${text}…`, "pending");
  const started = Date.now();
  el.analysisElapsed.hidden = false;
  elapsedTimer = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    el.analysisElapsed.textContent = `${s}s`;
    pendingLine.querySelector(".log-text").textContent = `${text}… (${s}s)`;
  }, 1000);
}

function stopPending(finalText = null) {
  clearInterval(elapsedTimer);
  elapsedTimer = null;
  if (pendingLine) {
    if (finalText === null) {
      pendingLine.remove();
    } else {
      pendingLine.className = "log-line log-line--done";
      pendingLine.querySelector(".log-marker").textContent = "✓";
      pendingLine.querySelector(".log-text").textContent = finalText;
    }
    pendingLine = null;
  }
}

/* ---------- enrutador de vistas ---------- */

function showView(name) {
  for (const [key, view] of Object.entries(el.views)) {
    view.hidden = key !== name;
  }
  window.scrollTo(0, 0);
  if (name === "app") refreshHealth();
}

/* ---------- login ---------- */

function prepareLoginView() {
  const firstRun = !state.auth.registered;
  el.loginTitle.textContent = firstRun
    ? "Registro del perito"
    : "Identificación del perito";
  el.loginHint.textContent = firstRun
    ? "Primer uso: define tu credencial y una clave de al menos 6 caracteres. Quedan registradas solo en este equipo."
    : "Introduce tu credencial para acceder al laboratorio.";
  el.loginSubmit.textContent = firstRun
    ? "Registrar y acceder"
    : "Acceder al laboratorio";
  el.loginError.hidden = true;
  el.loginPass.value = "";
  if (state.auth.analyst) el.loginUser.value = state.auth.analyst;
}

function goToLogin() {
  // Con sesión ya abierta no se vuelve a pedir la clave.
  if (state.auth.loggedIn) {
    enterLab();
    return;
  }
  prepareLoginView();
  showView("login");
  (el.loginUser.value ? el.loginPass : el.loginUser).focus();
}

function enterLab() {
  el.analystName.textContent = state.auth.analyst || "";
  showView("app");
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const user = el.loginUser.value.trim();
  const pass = el.loginPass.value;

  el.loginSubmit.disabled = true;
  const action = state.auth.registered ? "login" : "register";
  const response = await window.api[action]({ user, pass });
  el.loginSubmit.disabled = false;

  if (!response.ok) {
    el.loginError.textContent = response.error;
    el.loginError.hidden = false;
    el.loginPass.value = "";
    el.loginPass.focus();
    return;
  }

  state.auth = { registered: true, loggedIn: true, analyst: response.analyst };
  enterLab();
}

async function handleLogout() {
  await window.api.logout();
  state.auth.loggedIn = false;
  resetAll();
  showView("landing");
}

/* ---------- estado del backend ---------- */

function setStatus(stateName, text) {
  el.statusDot.dataset.state = stateName;
  el.statusText.textContent = text;
}

async function refreshHealth() {
  setStatus("checking", "Comprobando backend…");
  const health = await window.api.checkHealth(state.settings.apiUrl);
  if (health.online) {
    setStatus("online", `Backend en línea · ${state.settings.apiUrl}`);
  } else {
    setStatus("offline", "Backend fuera de línea — clic para reintentar");
  }
}

/* ---------- selección de material ---------- */

// Blob URL de la vista previa actual; se revoca al sustituirlo para no
// acumular memoria.
let previewObjectUrl = null;

function clearPreviewUrl() {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
}

async function renderPreview(file) {
  el.preview.replaceChildren();
  clearPreviewUrl();
  if (!file) {
    el.previewFrame.hidden = true;
    return;
  }

  // Los bytes llegan por IPC (≤ 10 MB garantizado por la validación) y se
  // reproducen como Blob URL: duración, búsqueda y reproducción nativas.
  const response = await window.api.readPreview(file.path);
  if (state.file !== file) return; // el usuario ya seleccionó otro archivo
  if (!response?.ok) {
    el.previewFrame.hidden = true;
    showToast(response?.error || "No se pudo cargar la vista previa.");
    return;
  }

  previewObjectUrl = URL.createObjectURL(
    new Blob([response.bytes], { type: response.mime || file.mime })
  );

  const node = document.createElement(file.kind === "video" ? "video" : "img");
  node.src = previewObjectUrl;
  if (file.kind === "video") {
    node.controls = true;
    node.preload = "metadata";
  } else {
    node.alt = "Vista previa del material cuestionado";
  }
  el.preview.appendChild(node);
  el.previewFrame.hidden = false;
}

function setFile(file) {
  state.file = file;
  el.dropzoneLabel.textContent = file
    ? file.name
    : "Deposita aquí el material cuestionado";
  el.analyze.disabled = !file || state.loading;
  el.analyze.textContent =
    file?.kind === "video" ? "Ejecutar análisis de video" : "Ejecutar análisis";
  el.reset.hidden = !file;
  renderPreview(file);
}

function handlePrepared(response) {
  if (response?.canceled) return;
  if (!response?.ok) {
    showToast(response?.error || "No se pudo abrir el archivo.");
    return;
  }
  clearResult();
  clearLog("Material cargado. Ejecuta el análisis cuando estés listo.");
  setFile(response.file);
}

async function openFileDialog() {
  handlePrepared(await window.api.pickFile());
}

async function loadSample(which) {
  handlePrepared(await window.api.loadSample(which));
}

function clearResult() {
  el.result.hidden = true;
  el.resultFrames.hidden = true;
  el.resultBar.style.width = "0%";
  el.checklist.hidden = true;
  el.checklistItems.replaceChildren();
  el.checklistScore.textContent = "";
  el.checklistSubmit.disabled = true;
  state.lastResult = null;
  state.checklistAnswers = {};
}

function resetAll() {
  clearResult();
  clearLog();
  setFile(null);
}

/* ---------- análisis ---------- */

function setLoading(loading) {
  state.loading = loading;
  el.scanOverlay.hidden = !loading || !state.file;
  el.analyze.disabled = loading || !state.file;
  el.analyze.textContent = loading
    ? "Analizando…"
    : state.file?.kind === "video"
      ? "Ejecutar análisis de video"
      : "Ejecutar análisis";
}

async function analyze() {
  if (!state.file || state.loading) return;

  setLoading(true);
  clearResult();
  clearLog(null);

  const kb = (state.file.size / 1024).toFixed(0);
  addLog(`Material validado: ${state.file.name} (${state.file.kind}, ${kb} KB)`);
  addLog(`Enviado al backend ${state.settings.apiUrl}`);
  startPending(
    state.file.kind === "video"
      ? "Análisis en curso: extracción, rostros y peritos por fotograma"
      : "Análisis en curso"
  );

  const started = Date.now();
  const response = await window.api.predict(state.settings.apiUrl, state.file.path);
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);

  setLoading(false);

  if (!response.ok) {
    stopPending();
    addLog(response.error, "warn");
    setStatus("offline", "Backend fuera de línea — clic para reintentar");
    showToast(response.error);
    return;
  }

  stopPending(`Análisis completado en ${elapsed}s`);
  setStatus("online", `Backend en línea · ${state.settings.apiUrl}`);

  await renderAnalysisSteps(response.result);
  renderResult(response.result);
  if (response.result.prediction === "Suspect") {
    showChecklist(response.result);
  }

  state.settings.history = await window.api.addHistory({
    name: state.file.name,
    prediction: response.result.prediction,
    confidence: response.result.confidence,
    kind: state.file.kind,
  });
  renderHistory();
}

/* Despliega en el log, con los datos reales de la respuesta, cada etapa del
   procedimiento pericial. El escalonado es solo de lectura: los datos ya
   están calculados. */
async function renderAnalysisSteps(result) {
  const STEP = 220;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;

  if (result.frames_analyzed) {
    addLog(`Fotogramas extraídos: ${result.frames_analyzed}, repartidos por toda la línea de tiempo`);
    await wait(STEP);
    const status = result.faces_detected === 0 ? "warn" : "done";
    addLog(
      `Detección facial (YuNet): rostro en ${result.faces_detected} de ${result.frames_analyzed} fotogramas`,
      status
    );
    await wait(STEP);
    if (result.frame_scores?.length) {
      const min = Math.min(...result.frame_scores);
      const max = Math.max(...result.frame_scores);
      addLog(`Señal por fotograma: mín ${pct(min)} · máx ${pct(max)}`);
      await wait(STEP);
    }
  } else {
    addLog(
      `Detección facial (YuNet): ${result.faces_detected ? "rostro localizado y recortado" : "sin rostro detectable"}`,
      result.faces_detected ? "done" : "warn"
    );
    await wait(STEP);
  }

  const m = result.models || {};
  const modelSteps = [
    ["synthesis_gan", "Detector De Síntesis GAN"],
    ["faceswap_dfdc", "Detector De Face Swap"],
    ["diffusion_modern", "Detector De Difusión Facial"],
    ["scene_generated", "Sonda De Escena Generada"],
  ];
  for (const [key, name] of modelSteps) {
    if (m[key] === undefined) continue;
    addLog(`${name}: señal ${pct(m[key])}`, m[key] > 0.5 ? "note" : "done");
    await wait(STEP);
  }

  const suspects = result.suspicious_seconds || [];
  if (result.frames_analyzed) {
    addLog(
      suspects.length
        ? `Momentos sospechosos: ${suspects.map((s) => `${s.second}s`).join(" · ")}`
        : "Sin momentos sospechosos señalados",
      suspects.length ? "note" : "done"
    );
    await wait(STEP);
  }

  if (result.caveat) {
    addLog(
      result.prediction === "Suspect"
        ? "Dictamen con reserva: revisar el peritaje manual"
        : "Nota del dictamen: señal facial atribuida a filtros o procesado de cámara",
      "note"
    );
    await wait(STEP);
  }

  const verdict = VERDICTS[result.prediction] || VERDICTS.Real;
  addLog(
    `Dictamen: ${verdict.stamp} (${result.confidence}%)`,
    result.prediction === "Fake" ? "warn" : result.prediction === "Suspect" ? "note" : "done"
  );
}

const VERDICTS = {
  Fake: { key: "fake", stamp: "MANIPULADO", confidenceLabel: "Confianza" },
  Real: { key: "real", stamp: "REAL", confidenceLabel: "Confianza" },
  // Condena sin corroboración (solo el detector de difusión): el sistema no
  // dictamina; señala y deja la decisión al perito.
  Suspect: { key: "suspect", stamp: "INDICIOS", confidenceLabel: "Señal de generación" },
};

function renderResult(result) {
  // El backend responde "Real", "Fake" o "Suspect" (backend/app/model.py).
  state.lastResult = result;
  el.resultTitle.textContent = "Dictamen preliminar";
  const verdict = VERDICTS[result.prediction] || VERDICTS.Real;
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
    const pct = (v) => `${(v * 100).toFixed(1)}%`;
    const names = {
      synthesis_gan: "GAN",
      faceswap_dfdc: "FACE SWAP",
      diffusion_modern: "DIFUSIÓN",
      scene_generated: "ESCENA",
    };
    // Orden descendente; la señal que fija el dictamen va marcada con ▸.
    const entries = Object.entries(result.models)
      .filter(([key]) => names[key])
      .sort((a, b) => b[1] - a[1]);
    el.resultModels.textContent = entries
      .map(([key, value], i) => `${i === 0 ? "▸ " : ""}${names[key]} ${pct(value)}`)
      .join(" · ");
    el.resultModels.hidden = false;
  } else {
    el.resultModels.hidden = true;
  }

  // Momentos del video que superaron el umbral de sospecha: son los puntos
  // que el perito debe revisar a mano en la vista previa.
  const suspects = result.suspicious_seconds || [];
  if (suspects.length > 0) {
    const shown = suspects
      .slice(0, 5)
      .map((s) => `${s.second}s`)
      .join(" · ");
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
  if (result.faces_detected === 0) {
    showToast("No se detectó ningún rostro en el material; el dictamen pierde fiabilidad.");
  }

  el.result.hidden = false;
}

/* ---------- peritaje manual: checklist para resolver INDICIOS ---------- */

// Cada pregunta declara qué respuesta apunta a manipulación. "No concluyente"
// no suma en ninguna dirección.
const CHECKLIST_ITEMS = [
  {
    id: "bordes",
    text: "¿Los bordes del rostro (mandíbula, línea del pelo, orejas) muestran transiciones extrañas, dobles contornos o parpadeos?",
    fakeAnswer: "si",
  },
  {
    id: "gestos",
    text: "¿El parpadeo, la mirada, los dientes y las manos se comportan con naturalidad?",
    fakeAnswer: "no",
  },
  {
    id: "luz",
    text: "¿La iluminación y las sombras del rostro son coherentes con el resto de la escena?",
    fakeAnswer: "no",
  },
  {
    id: "filtros",
    text: "¿Se aprecian filtros de embellecimiento o procesado de cámara evidentes (piel uniformemente alisada)? Un filtro explica la señal de generación en material auténtico.",
    fakeAnswer: "no",
  },
  {
    id: "momentos",
    text: "¿Los momentos sospechosos señalados en el registro (si los hay) muestran artefactos visibles al revisarlos a mano en el reproductor?",
    fakeAnswer: "si",
  },
  {
    id: "origen",
    text: "¿El origen del material es verificable (fuente conocida, cadena de custodia)?",
    fakeAnswer: "no",
  },
];

const ANSWER_LABELS = { si: "Sí", no: "No", nc: "No concluyente" };

function showChecklist(result) {
  state.checklistAnswers = {};
  el.checklistItems.replaceChildren();

  for (const item of CHECKLIST_ITEMS) {
    const wrap = document.createElement("div");
    wrap.className = "checklist-item";

    const q = document.createElement("p");
    q.className = "checklist-question";
    q.textContent = item.text;

    const options = document.createElement("div");
    options.className = "checklist-options";
    for (const value of ["si", "no", "nc"]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "check-option";
      btn.textContent = ANSWER_LABELS[value];
      btn.addEventListener("click", () => {
        state.checklistAnswers[item.id] = value;
        for (const sibling of options.children) sibling.classList.remove("selected");
        btn.classList.add("selected");
        updateChecklistScore();
      });
      options.appendChild(btn);
    }

    wrap.append(q, options);
    el.checklistItems.appendChild(wrap);
  }

  el.checklist.hidden = false;
  updateChecklistScore();
}

function computeChecklistScores() {
  // La señal de los modelos entra en el cómputo: fuerte (≥50 %) pesa doble.
  const modelPoints = (state.lastResult?.confidence ?? 0) >= 50 ? 2 : 1;
  let fake = modelPoints;
  let real = 0;
  for (const item of CHECKLIST_ITEMS) {
    const answer = state.checklistAnswers[item.id];
    if (!answer || answer === "nc") continue;
    if (answer === item.fakeAnswer) fake += 1;
    else real += 1;
  }
  return { fake, real, modelPoints };
}

function updateChecklistScore() {
  const answered = CHECKLIST_ITEMS.filter((i) => state.checklistAnswers[i.id]).length;
  const { fake, real, modelPoints } = computeChecklistScores();
  el.checklistScore.textContent =
    `${answered}/${CHECKLIST_ITEMS.length} RESPONDIDAS · ` +
    `MANIPULACIÓN ${fake} (MODELOS ${modelPoints}) · AUTENTICIDAD ${real}`;
  el.checklistSubmit.disabled = answered < CHECKLIST_ITEMS.length;
}

function emitFinalVerdict() {
  if (!state.lastResult) return;
  const { fake, real } = computeChecklistScores();

  if (fake === real) {
    addLog(
      `Peritaje manual: empate técnico (${fake} · ${real}); los indicios se mantienen — amplía la revisión o incorpora más material`,
      "note"
    );
    showToast("Empate técnico: el dictamen se mantiene en INDICIOS.");
    return;
  }

  const final = fake > real ? "Fake" : "Real";
  const verdict = VERDICTS[final];

  el.resultTitle.textContent = "Dictamen final del perito";
  el.result.dataset.verdict = verdict.key;
  el.resultStamp.textContent = verdict.stamp;
  el.resultConfidence.textContent =
    `Dictamen combinado · señal de modelos ${state.lastResult.confidence}%`;
  el.resultCaveat.textContent =
    `Resolución del peritaje manual: ${fake} puntos de manipulación frente a ` +
    `${real} de autenticidad (los modelos aportan la señal inicial). Este ` +
    `dictamen combina las métricas con la observación directa del perito.`;
  el.resultCaveat.hidden = false;
  el.checklist.hidden = true;

  addLog(
    `Dictamen final del perito: ${verdict.stamp} (manipulación ${fake} · autenticidad ${real})`,
    final === "Fake" ? "warn" : "done"
  );

  window.api
    .addHistory({
      name: `${state.file?.name || "material"} · peritaje`,
      prediction: final,
      confidence: state.lastResult.confidence,
      kind: state.file?.kind || "image",
    })
    .then((history) => {
      state.settings.history = history;
      renderHistory();
    });
}

/* ---------- registro de casos ---------- */

function renderHistory() {
  const history = state.settings.history || [];
  el.historySection.hidden = history.length === 0;
  el.historyList.replaceChildren();

  for (const item of history) {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "case-name";
    name.textContent = item.name;
    name.title = item.name;

    const verdict = document.createElement("span");
    verdict.className = "case-verdict";
    verdict.dataset.prediction = item.prediction;
    verdict.textContent = `${(VERDICTS[item.prediction] || VERDICTS.Real).stamp} ${item.confidence}%`;

    li.append(name, verdict);
    el.historyList.appendChild(li);
  }
}

async function clearHistory() {
  state.settings.history = await window.api.clearHistory();
  renderHistory();
}

/* ---------- configuración ---------- */

function toggleSettings(force) {
  const nextHidden = force === undefined ? !el.settingsPanel.hidden : !force;
  el.settingsPanel.hidden = nextHidden;
  if (!nextHidden) el.apiUrl.focus();
}

async function saveApiUrl() {
  const value = el.apiUrl.value.trim();
  if (!/^https?:\/\/.+/i.test(value)) {
    showToast("Introduce una URL válida que empiece por http:// o https://");
    return;
  }
  state.settings = await window.api.saveSettings({ apiUrl: value });
  toggleSettings(false);
  showToast("Configuración guardada.");
  refreshHealth();
}

/* ---------- arrastrar y soltar ---------- */

function wireDragAndDrop() {
  // Sin esto, soltar un archivo haría que la ventana navegase hacia él.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  el.dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.dropzone.classList.add("dragging");
  });

  el.dropzone.addEventListener("dragleave", () => {
    el.dropzone.classList.remove("dragging");
  });

  el.dropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    el.dropzone.classList.remove("dragging");

    const dropped = e.dataTransfer.files[0];
    if (!dropped) return;

    const filePath = window.api.pathForFile(dropped);
    if (!filePath) {
      showToast("No se pudo determinar la ruta del archivo.");
      return;
    }
    handlePrepared(await window.api.prepareFile(filePath));
  });
}

/* ---------- arranque ---------- */

function wireEvents() {
  el.landingEnter.addEventListener("click", goToLogin);
  el.landingEnterTop.addEventListener("click", goToLogin);
  el.landingProtocol.addEventListener("click", () => {
    document.getElementById("protocol").scrollIntoView({ behavior: "smooth" });
  });

  el.loginForm.addEventListener("submit", handleLoginSubmit);
  el.loginBack.addEventListener("click", () => showView("landing"));

  el.logout.addEventListener("click", handleLogout);
  el.dropzone.addEventListener("click", openFileDialog);
  el.analyze.addEventListener("click", analyze);
  el.reset.addEventListener("click", resetAll);
  el.checklistSubmit.addEventListener("click", emitFinalVerdict);
  el.historyClear.addEventListener("click", clearHistory);
  el.settingsToggle.addEventListener("click", () => toggleSettings());
  el.settingsSave.addEventListener("click", saveApiUrl);
  el.statusText.addEventListener("click", refreshHealth);

  el.apiUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveApiUrl();
  });

  for (const button of document.querySelectorAll("[data-sample]")) {
    button.addEventListener("click", () => loadSample(button.dataset.sample));
  }

  window.api.onMenuAction((action) => {
    const inLab = !el.views.app.hidden;
    if (action === "open" && inLab) openFileDialog();
    if (action === "analyze" && inLab) analyze();
    if (action === "reset" && inLab) resetAll();
    if (action === "settings" && inLab) toggleSettings(true);
    if (action === "logout" && inLab) handleLogout();
  });

  wireDragAndDrop();
}

async function init() {
  const [settings, auth] = await Promise.all([
    window.api.getSettings(),
    window.api.authStatus(),
  ]);
  state.settings = settings;
  state.auth = auth;

  el.apiUrl.value = settings.apiUrl;
  renderHistory();
  setFile(null);
  wireEvents();
  showView("landing");
}

init();
