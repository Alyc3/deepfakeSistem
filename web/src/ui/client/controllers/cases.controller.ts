import { CASE_SCHEMA, RULES, checkValue } from "@domain/validation";
import { liveValidation, restrictField, restrictForm } from "../validation";
import { busy, loaded, refreshOnReturn, setBusy, skeleton } from "../loading";
import { showToast } from "../toast";
type CaseRow = { id: string; case_number: string; title: string; created_at?: string | null; description?: string | null; evidences?: number; verdict?: string | null };
type CasePage = { items: CaseRow[]; total: number; offset: number; limit: number };
const PAGE_SIZE = 10;
const created_on = new Intl.DateTimeFormat("es", { day: "2-digit", month: "short", year: "numeric" });
/** Estado de un expediente para la lista: dictamen si lo hay; si no, si ya tiene evidencia preservada. */
function caseStatus(row: CaseRow): { label: string; tone: string } {
  if (row.verdict === "MANIPULADO") return { label: "Manipulado", tone: "badge-alert" };
  if (row.verdict === "SIN_MANIPULACION") return { label: "Sin manipulación", tone: "badge-moss" };
  if (row.verdict) return { label: "Indicios", tone: "badge-review" };
  return row.evidences ? { label: "Por analizar", tone: "badge-muted" } : { label: "Sin evidencia", tone: "badge-muted" };
}
type Archive = { case_id: string; evidence_id: string; report_id: string | null; objects: { id: string; kind: string }[] };
type CaseSummary = { id: string; case_number: string; title: string; evidences: { id: string; file_name: string; sha256: string; report: null | { id: string; verdict: string; confidence: number | null; processing_time_seconds: number | null; frames_analyzed: number | null; faces_detected: number | null; completed_at: string | null; expert_conclusions: string | null; pdf_artifact_id: string | null; artifact_issue?: string | null; heatmaps: { image: string; second?: number; signal?: number }[] } }[]; audit: { action: string; timestamp: string; actor: string; hash_verified: boolean }[] };
type JobProgress = { stage?: string; message?: string; current?: number; total?: number; events?: { id: string; message: string; timestamp: string }[] };
const base = "/api/forensics/cases";
const request = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.detail ?? `La solicitud falló (${response.status}).`); }
  return response.json();
};
const id = (value: string) => encodeURIComponent(value);

export function wireCases() {
  const casesBrowser = document.getElementById("cases-browser")!;
  const analysisView = document.getElementById("analysis-view")!;
  const closeAnalysisButton = document.getElementById("close-analysis-view") as HTMLButtonElement;
  const analysisBackButton = document.getElementById("analysis-back") as HTMLButtonElement;
  const list = document.getElementById("cases-list")!;
  const form = document.getElementById("case-create-form") as HTMLFormElement;
  const message = document.getElementById("case-message")!;
  const workflow = document.getElementById("evidence-workflow")!;
  const fileInput = document.getElementById("case-evidence-file") as HTMLInputElement;
  const evidencePreview = document.getElementById("evidence-preview")!;
  const videoPreview = document.getElementById("evidence-video-preview") as HTMLVideoElement;
  const imagePreview = document.getElementById("evidence-image-preview") as HTMLImageElement;
  const previewCaption = document.getElementById("evidence-preview-caption")!;
  const hashState = document.getElementById("evidence-hash-state")!;
  const referenceHash = document.getElementById("reference-hash") as HTMLInputElement;
  const preserveButton = document.getElementById("create-evidence-copy") as HTMLButtonElement;
  const analyzeButton = document.getElementById("analyze-case-evidence") as HTMLButtonElement;
  const notes = document.getElementById("expert-observations") as HTMLTextAreaElement;
  const finalize = document.getElementById("finalize-case-report") as HTMLButtonElement;
  const reviewPane = document.getElementById("analysis-review")!;
  const reviewMessage = document.getElementById("analysis-review-message")!;
  const reportPane = document.getElementById("analysis-report")!;
  const reportViewer = document.getElementById("analysis-report-viewer") as HTMLIFrameElement;
  const reportLoading = document.getElementById("analysis-report-loading")!;
  const reportState = document.getElementById("analysis-report-state")!;
  const reportOpen = document.getElementById("analysis-report-open") as HTMLAnchorElement;
  const reportDownload = document.getElementById("analysis-report-download") as HTMLAnchorElement;
  const statusCard = document.getElementById("analysis-status-card")!;
  const verdictBadge = document.getElementById("analysis-verdict-badge")!;
  let reportUrl: string | null = null;
  const analysisScreen = document.getElementById("analysis-screen")!;
  const analysisLog = document.getElementById("analysis-live-log")!;
  const analysisProgress = document.getElementById("analysis-progress")!;
  const progressFill = document.getElementById("analysis-progress-fill")!;
  const progressCaption = document.getElementById("analysis-progress-caption")!;
  const progressEvents = new Set<string>();
  const currentRole = (JSON.parse(document.getElementById("view-app")!.getAttribute("data-user") ?? "{}")?.role?.name ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  let selected: CaseRow | null = null; let file: File | null = null; let hash = ""; let archive: Archive | null = null; let reportId = "";
  let previewUrl: string | null = null;
  let analysisInFlight = false;

  /** `done`: el paso ya terminó (marca ✓); si no, queda como paso en curso con el indicador giratorio. */
  const appendAnalysisLog = (message: string, timestamp = new Date().toISOString(), failed = false, done = false) => {
    analysisLog.querySelector(".is-current")?.classList.remove("is-current");
    const entry = document.createElement("li"); entry.className = `analysis-log-entry${failed ? " is-error" : done ? "" : " is-current"}`;
    const time = document.createElement("time"); time.dateTime = timestamp; time.textContent = new Date(timestamp).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const text = document.createElement("span"); text.textContent = message; entry.append(time, text); analysisLog.append(entry); analysisLog.scrollTop = analysisLog.scrollHeight;
  };
  const showProgress = (progress: JobProgress | null, status = "queued") => {
    const stages: Record<string, [string, string]> = {
      queued: ["EN COLA", "Esperando al motor de análisis…"], verification: ["VERIFICACIÓN FORENSE", "Comprobando la copia preservada…"],
      extracting: ["PREPARACIÓN DEL VIDEO", "Extrayendo fotogramas para el análisis…"], inference: ["MODELOS EN EJECUCIÓN", "Analizando la evidencia…"],
      scene: ["SONDA DE ESCENA", "Examinando el encuadre completo…"],
      heatmaps: ["MAPAS DE CALOR", "Preparando las explicaciones visuales…"], archive: ["ARCHIVO FORENSE", "Sellando y guardando el informe…"],
      completed: ["ANÁLISIS COMPLETADO", "El dictamen está listo para revisión pericial."],
    };
    const [label, title] = stages[progress?.stage ?? status] ?? stages.queued;
    document.getElementById("analysis-phase-label")!.textContent = label;
    document.getElementById("analysis-status-title")!.textContent = title;
    document.getElementById("analysis-status-detail")!.textContent = progress?.message ?? (status === "queued" ? "El análisis está en cola y comenzará en cuanto el motor quede libre." : "Consultando el estado del trabajo…");
    if (progress?.current != null && progress.total != null && progress.total > 0) {
      const percent = Math.max(0, Math.min(100, Math.round(progress.current / progress.total * 100)));
      analysisProgress.classList.remove("is-indeterminate"); analysisProgress.setAttribute("aria-valuenow", String(percent)); progressFill.style.width = `${percent}%`;
      progressCaption.textContent = `${progress.stage === "scene" ? "Sonda" : "Fotograma"} ${progress.current} de ${progress.total} · ${percent}%`;
    } else if (progress?.stage === "completed" || status === "completed") {
      analysisProgress.classList.remove("is-indeterminate"); analysisProgress.setAttribute("aria-valuenow", "100"); progressFill.style.width = "100%"; progressCaption.textContent = "Proceso completado";
    } else {
      analysisProgress.classList.add("is-indeterminate"); analysisProgress.removeAttribute("aria-valuenow"); progressCaption.textContent = "Proceso activo · la duración depende del archivo y del equipo";
    }
    for (const event of progress?.events ?? []) if (!progressEvents.has(event.id)) { progressEvents.add(event.id); appendAnalysisLog(event.message, event.timestamp); }
  };
  const VERDICT_TEXT: Record<string, [string, string]> = {
    MANIPULADO: ["Manipulado", ""], SIN_MANIPULACION: ["Sin manipulación", " is-real"], ANTECEDENTES: ["Indicios", " is-review"],
  };
  /** Resumen de una línea en la tarjeta de estado; el detalle completo está en el informe PDF de la derecha. */
  const renderVerdict = (data: any) => {
    const key = data.verdict_forensic ?? (data.prediction === "Fake" ? "MANIPULADO" : data.prediction === "Real" ? "SIN_MANIPULACION" : "ANTECEDENTES");
    const [label, tone] = VERDICT_TEXT[key] ?? VERDICT_TEXT.ANTECEDENTES;
    verdictBadge.textContent = label.toUpperCase(); verdictBadge.className = `verdict-badge${tone}`; verdictBadge.hidden = false;
    document.getElementById("analysis-status-title")!.textContent = `Dictamen: ${label.toLowerCase()}`;
    document.getElementById("analysis-status-detail")!.textContent = `Confianza del modelo: ${data.confidence == null ? "no disponible" : `${data.confidence} %`}. Revisa el informe y registra tu conclusión para emitir la versión final.`;
    statusCard.classList.add("is-complete");
  };
  /** Descarga el PDF con la sesión y lo muestra en el visor como blob (sin abrir pestañas ni descargas). */
  const showReport = async (caseId: string, artifactId: string, final: boolean, caseNumber: string) => {
    reportPane.hidden = false; reportLoading.hidden = false; reportLoading.textContent = "Cargando informe…"; setBusy(reportLoading, true);
    try {
      const response = await fetch(`${base}/${id(caseId)}/artifacts/${id(artifactId)}/download`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) { const failure = await response.json().catch(() => ({})); throw new Error(failure.detail ?? "No se pudo cargar el informe."); }
      const pdf = new Blob([await response.arrayBuffer()], { type: "application/pdf" });
      if (reportUrl) URL.revokeObjectURL(reportUrl);
      reportUrl = URL.createObjectURL(pdf);
      reportViewer.src = `${reportUrl}#view=FitH`;
      reportOpen.href = reportUrl; reportDownload.href = reportUrl;
      reportDownload.download = `informe-${caseNumber}${final ? "" : "-borrador"}.pdf`;
      reportState.textContent = final ? "Versión final" : "Borrador"; reportState.className = `badge ${final ? "badge-moss" : "badge-muted"}`;
      reportLoading.hidden = true;
    } catch (error) { reportLoading.textContent = error instanceof Error ? error.message : "No se pudo cargar el informe."; }
    finally { setBusy(reportLoading, false); }
  };
  /** Identificador del PDF más reciente del informe: el del recibo o, si no viene, el del resumen del expediente. */
  const reportPdf = async (caseId: string, receipt: Archive | null) => {
    const fromReceipt = receipt?.objects.filter(row => row.kind === "pdf").at(-1)?.id;
    if (fromReceipt) return fromReceipt;
    const summary = await request(`${base}/${id(caseId)}/summary`) as CaseSummary;
    return summary.evidences.find(item => item.report?.pdf_artifact_id)?.report?.pdf_artifact_id ?? null;
  };
  const resetReport = () => {
    reportPane.hidden = true; reviewPane.hidden = true; verdictBadge.hidden = true; statusCard.classList.remove("is-complete");
    reportViewer.removeAttribute("src"); if (reportUrl) URL.revokeObjectURL(reportUrl); reportUrl = null;
    notes.value = ""; reviewMessage.hidden = true; finalize.disabled = true;
  };

  const search = document.getElementById("cases-search") as HTMLInputElement;
  const pager = document.getElementById("cases-pager")!;
  const prevPage = document.getElementById("cases-prev") as HTMLButtonElement;
  const nextPage = document.getElementById("cases-next") as HTMLButtonElement;
  const cell = (tag: string, className: string, text = "") => { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; };
  /** Toda la fila abre el expediente: un clic, sin buscar un botón. */
  const caseRow = (row: CaseRow, isNew = false) => {
    const button = document.createElement("button"); button.type = "button"; button.className = `case-row${isNew ? " is-new" : ""}`;
    button.setAttribute("aria-label", `Abrir expediente ${row.case_number}: ${row.title}`);
    const main = cell("span", "case-row-main");
    main.append(cell("span", "case-row-number", row.case_number), cell("strong", "case-row-title", row.title));
    if (row.description) main.append(cell("span", "case-row-description", row.description));
    const status = caseStatus(row);
    const evidences = cell("span", "case-row-evidences", String(row.evidences ?? 0)); evidences.dataset.label = "Evidencias";
    const badge = cell("span", "case-row-status"); badge.append(cell("span", `badge ${status.tone}`, status.label));
    const date = cell("span", "case-row-date", row.created_at ? created_on.format(new Date(row.created_at)) : "—");
    const open = cell("span", "case-row-open", "Abrir");
    button.append(main, evidences, badge, date, open);
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true; setBusy(open, true); open.textContent = "Abriendo";
      try { await openCase(row); } finally { button.disabled = false; setBusy(open, false); open.textContent = "Abrir"; }
    });
    return button;
  };
  let listGeneration = 0; let listLoaded = false; let offset = 0; let term = "";
  /**
   * Recarga la página actual de la lista. Solo pinta la respuesta más reciente: una carga anterior que
   * llegue tarde (p. ej. la inicial, si la base tardó en responder) no borra un expediente recién creado.
   * `created` se garantiza en la primera página y se resalta al aparecer.
   */
  const refresh = async (created?: CaseRow) => {
    const request_id = ++listGeneration;
    if (!listLoaded) skeleton(list, 4, "card");
    const params = new URLSearchParams({ offset: String(offset), limit: String(PAGE_SIZE) });
    if (term) params.set("q", term);
    try {
      const page = await request(`${base}?${params}`) as CasePage;
      if (request_id !== listGeneration) return;
      const rows = page.items;
      if (created && offset === 0 && !term && !rows.some(row => row.id === created.id)) { rows.unshift(created); if (rows.length > PAGE_SIZE) rows.pop(); page.total += 1; }
      // Si la página quedó vacía (p. ej. tras una búsqueda), se vuelve a la anterior.
      if (!rows.length && offset > 0) { offset = Math.max(0, offset - PAGE_SIZE); return refresh(); }
      listLoaded = true; loaded(list);
      document.getElementById("cases-count")!.textContent = page.total ? String(page.total) : "";
      if (!rows.length) {
        const empty = cell("div", "empty-state case-empty");
        empty.append(cell("h3", "", term ? "Sin resultados" : "Aún no hay expedientes"), cell("p", "", term ? `Ningún expediente coincide con «${term}».` : "Crea el primero con el formulario de arriba."));
        list.replaceChildren(empty); pager.hidden = true; return;
      }
      list.replaceChildren(...rows.map(row => caseRow(row, row.id === created?.id)));
      const pages = Math.max(1, Math.ceil(page.total / PAGE_SIZE));
      pager.hidden = page.total <= PAGE_SIZE;
      document.getElementById("cases-range")!.textContent = `${offset + 1}–${offset + rows.length} de ${page.total}`;
      document.getElementById("cases-page-label")!.textContent = `${Math.floor(offset / PAGE_SIZE) + 1} / ${pages}`;
      prevPage.disabled = offset === 0; nextPage.disabled = offset + rows.length >= page.total;
    } catch (error) {
      if (request_id !== listGeneration) return;
      loaded(list); pager.hidden = true;
      list.replaceChildren(cell("p", "inline-message", error instanceof Error ? error.message : "No se pudieron cargar los casos."));
    }
  };
  prevPage.addEventListener("click", () => { offset = Math.max(0, offset - PAGE_SIZE); void refresh(); });
  nextPage.addEventListener("click", () => { offset += PAGE_SIZE; void refresh(); });
  let typing: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(() => { const next = search.value.trim(); if (next === term) return; term = next; offset = 0; void refresh(); }, 300);
  });
  const openCase = async (row: CaseRow) => {
    selected = row; file = null; hash = ""; archive = null; fileInput.value = ""; preserveButton.disabled = true; analyzeButton.disabled = true;
    referenceHash.value = ""; reportId = ""; resetReport();
    if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; evidencePreview.hidden = true;
    workflow.hidden = true; analysisScreen.hidden = true; const summaryPanel = document.getElementById("case-summary")!; summaryPanel.hidden = true;
    document.getElementById("case-view-number")!.textContent = row.case_number;
    document.getElementById("case-view-title")!.textContent = row.title;
    message.textContent = "";
    try {
      // La vista cambia cuando el expediente ya está cargado; mientras, el botón «Abriendo…» indica la espera.
      const summary = await request(`${base}/${id(row.id)}/summary`) as CaseSummary;
      casesBrowser.hidden = true; analysisView.hidden = false;
      const completed = summary.evidences.find(item => item.report)?.report;
      if (completed) { renderSummary(summary, summaryPanel); summaryPanel.hidden = false; summaryPanel.scrollIntoView({ behavior: "smooth" }); return; }
      workflow.hidden = false;
      const pending = summary.evidences[0];
      if (pending) { archive = { case_id: row.id, evidence_id: pending.id, report_id: null, objects: [] }; analyzeButton.disabled = false; preserveButton.hidden = true; fileInput.disabled = true; referenceHash.disabled = true; hashState.textContent = `Evidencia ${pending.file_name} ya preservada · SHA-256 ${pending.sha256}`; previewCaption.textContent = "El original continúa bajo custodia; el análisis utiliza únicamente su copia de trabajo."; evidencePreview.hidden = false; }
      else { archive = null; preserveButton.hidden = false; fileInput.disabled = false; referenceHash.disabled = false; previewCaption.textContent = ""; updatePreserve(); }
      workflow.scrollIntoView({ behavior: "smooth" });
    } catch (error) { message.textContent = error instanceof Error ? error.message : "No se pudo abrir el caso."; analysisView.hidden = true; casesBrowser.hidden = false; }
  };
  void refresh();
  // Sin botón «Actualizar»: la lista se recarga sola al volver a la pestaña y tras cada acción.
  refreshOnReturn(() => { if (!casesBrowser.hidden) void refresh(); });
  closeAnalysisButton.addEventListener("click", () => { if (analysisInFlight) return; analysisView.hidden = true; casesBrowser.hidden = false; if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; void refresh(); });
  restrictForm(form, CASE_SCHEMA);
  restrictField(referenceHash, RULES.sha256);
  const liveCase = liveValidation(form, CASE_SCHEMA, { required: ["case_number", "title"] });
  // La descripción ocupa una línea y crece con el texto (sin barra de scroll ni alto fijo).
  const description = form.elements.namedItem("description") as HTMLTextAreaElement;
  const grow = () => { description.style.height = "auto"; description.style.height = `${Math.min(description.scrollHeight + 2, 160)}px`; };
  description.addEventListener("input", grow);
  form.addEventListener("input", () => { message.textContent = ""; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!liveCase.validate()) return;
    const data = new FormData(form); message.textContent = "";
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]');
    try {
      const created = await busy(submit, () => request(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(data)) }), "Creando…") as CaseRow;
      form.reset(); description.style.height = ""; showToast(`Expediente ${created.case_number} creado.`);
      // El nuevo aparece arriba del todo: se vuelve a la primera página y se limpia la búsqueda.
      offset = 0; term = ""; search.value = "";
      await refresh({ ...created, evidences: 0, verdict: null, created_at: new Date().toISOString() });
    }
    catch (error) { message.textContent = error instanceof Error ? error.message : "No se pudo crear el caso."; }
  });
  fileInput.addEventListener("change", async () => {
    file = fileInput.files?.[0] ?? null; hash = ""; archive = null; analyzeButton.disabled = true; preserveButton.disabled = true;
    if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null;
    if (!file) { hashState.textContent = "Selecciona una evidencia para calcular SHA-256."; return; }
    previewUrl = URL.createObjectURL(file); evidencePreview.hidden = false;
    videoPreview.hidden = !file.type.startsWith("video/"); imagePreview.hidden = !file.type.startsWith("image/");
    if (videoPreview.hidden) videoPreview.removeAttribute("src"); else { videoPreview.src = previewUrl; videoPreview.load(); }
    if (imagePreview.hidden) imagePreview.removeAttribute("src"); else imagePreview.src = previewUrl;
    previewCaption.textContent = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(2)} MB`;
    hashState.textContent = "Calculando huella SHA-256…"; setBusy(hashState, true);
    try { const bytes = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); hash = [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, "0")).join(""); hashState.textContent = `SHA-256 calculado: ${hash}. Ingresa el hash de referencia para habilitar la preservación.`; updatePreserve(); }
    catch { hashState.textContent = "No fue posible calcular el hash. Se requiere un navegador con Web Crypto."; }
    finally { setBusy(hashState, false); }
  });
  document.getElementById("analysis-back")!.addEventListener("click", () => { analysisScreen.hidden = true; workflow.hidden = false; });
  const updatePreserve = () => { const same = referenceHash.value.trim().toLowerCase() === hash && /^[0-9a-f]{64}$/.test(hash); preserveButton.disabled = !selected || !file || !same; if (file && hash && referenceHash.value && !same) hashState.textContent = `Hash no coincide. Calculado: ${hash}`; else if (same) hashState.textContent = `Hash SHA-256 coincide: ${hash}. El servidor volverá a verificarlo al recibir el archivo.`; };
  referenceHash.addEventListener("input", updatePreserve);
  preserveButton.addEventListener("click", async () => {
    if (!selected || !file || !hash) return; preserveButton.disabled = true; preserveButton.textContent = "Preservando…"; setBusy(preserveButton, true);
    const body = new FormData(); body.append("file", file); body.append("expected_sha256", hash);
    try { archive = await request(`${base}/${id(selected.id)}/ingest`, { method: "POST", body }) as Archive; hashState.textContent = `Hash verificado por el servidor. Original y copia de trabajo preservados. SHA-256 ${hash}`; analyzeButton.disabled = false;
      const original = archive.objects.find(row => row.kind === "original"); const originalArea = document.getElementById("case-original-download")!;
      if (original && ["ADMIN", "ADMINISTRADOR", "GERENTE_GENERAL"].includes(currentRole)) { const link = document.createElement("a"); link.className = "ghost-button"; link.href = `${base}/${id(archive.case_id)}/artifacts/${id(original.id)}/download`; link.textContent = "Descargar original (administración)"; link.setAttribute("download", ""); originalArea.replaceChildren(link); }
      else originalArea.textContent = "Original preservado. Su descarga requiere autorización administrativa.";
      await refresh(); }
    catch (error) { hashState.textContent = error instanceof Error ? error.message : "No se pudo preservar la evidencia."; preserveButton.disabled = false; }
    finally { preserveButton.textContent = "Guardar original y crear copia"; setBusy(preserveButton, false); }
  });
  analyzeButton.addEventListener("click", async () => {
    if (!selected || !archive) return; analysisInFlight = true; closeAnalysisButton.disabled = true; analysisBackButton.disabled = true; analyzeButton.disabled = true; analyzeButton.textContent = "Analizando copia…";
    const activeCase = selected;
    progressEvents.clear(); analysisLog.replaceChildren(); resetReport();
    document.getElementById("analysis-case-number")!.textContent = activeCase.case_number;
    document.getElementById("analysis-case-title")!.textContent = activeCase.title;
    document.getElementById("analysis-job-label")!.textContent = "ENVIANDO TAREA";
    document.getElementById("analysis-phase-label")!.textContent = "EN COLA";
    document.getElementById("analysis-status-title")!.textContent = "Enviando el análisis al motor…";
    document.getElementById("analysis-status-detail")!.textContent = "La tarea analizará exclusivamente la copia preservada.";
    analysisProgress.classList.add("is-indeterminate"); analysisProgress.removeAttribute("aria-valuenow"); progressFill.style.width = "";
    progressCaption.textContent = "Esperando confirmación del motor…";
    appendAnalysisLog("Solicitud enviada; esperando confirmación del motor de análisis.");
    workflow.hidden = true; analysisScreen.hidden = false; analysisScreen.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      const body = new FormData(); body.append("evidence_id", archive.evidence_id);
      const queued = await request(`${base}/${id(activeCase.id)}/analyze-async`, { method: "POST", body });
      document.getElementById("analysis-job-label")!.textContent = `TRABAJO ${queued.job_id}`;
      showProgress(queued.progress ?? null, queued.status ?? "queued");
      const deadline = Date.now() + 15 * 60_000; let data: any;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        data = await request(`/api/forensics/jobs/${id(queued.job_id)}`); showProgress(data.progress ?? null, data.status);
        if (data.status === "completed" && data.result) break;
        if (data.status === "failed") throw new Error(data.detail ?? "El motor reportó un fallo durante el análisis.");
      }
      if (!data?.result) throw new Error("Se agotó el tiempo de espera visual. Revisa el estado del trabajo antes de volver a iniciarlo.");
      reportId = data.result.report_id; archive = data.result.archive ?? archive;
      showProgress({ stage: "completed", message: "Resultado guardado; está listo para la revisión del perito." }, "completed");
      appendAnalysisLog("Dictamen disponible. El informe completo está en el panel derecho.", undefined, false, true); renderVerdict(data.result);
      reviewPane.hidden = false; finalize.disabled = true;
      const pdfId = await reportPdf(activeCase.id, archive);
      if (pdfId) await showReport(activeCase.id, pdfId, false, activeCase.case_number);
      else { reportPane.hidden = false; reportLoading.textContent = "El informe se archivó, pero no se encontró su PDF."; }
      reportPane.scrollIntoView({ behavior: "smooth", block: "nearest" });
      document.getElementById("analysis-job-label")!.textContent = `TRABAJO ${queued.job_id} · COMPLETADO`;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Falló el análisis.";
      document.getElementById("analysis-phase-label")!.textContent = "REQUIERE ATENCIÓN";
      document.getElementById("analysis-status-title")!.textContent = "No se pudo confirmar el resultado";
      document.getElementById("analysis-status-detail")!.textContent = detail;
      analysisProgress.classList.remove("is-indeterminate"); appendAnalysisLog(detail, new Date().toISOString(), true);
    }
    finally { analysisInFlight = false; closeAnalysisButton.disabled = false; analysisBackButton.disabled = false; analyzeButton.disabled = false; analyzeButton.textContent = "Analizar copia"; }
  });
  notes.addEventListener("input", () => { notes.setCustomValidity(""); reviewMessage.hidden = true; finalize.disabled = !reportId || notes.value.trim().length < 10; });
  finalize.addEventListener("click", async () => {
    if (!selected || !archive || !reportId) return;
    const conclusions = checkValue(RULES.conclusions, notes.value, true);
    notes.setCustomValidity(conclusions.error ?? "");
    if (conclusions.error) { notes.reportValidity(); return; } finalize.disabled = true; finalize.textContent = "Generando informe…"; setBusy(finalize, true); reviewMessage.hidden = true;
    const activeCase = selected;
    try {
      const finalizedArchive = await request(`${base}/${id(activeCase.id)}/reports/${id(reportId)}/finalize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expert_conclusions: notes.value.trim() }) }) as Archive; archive = finalizedArchive;
      const pdf = finalizedArchive.objects.find(row => row.kind === "pdf"); if (!pdf) throw new Error("El reporte fue archivado, pero la respuesta no incluyó el PDF.");
      // El visor pasa del borrador a la versión final, que ya incluye la conclusión y la cadena de custodia.
      await showReport(finalizedArchive.case_id, pdf.id, true, activeCase.case_number);
      reviewMessage.textContent = "Revisión guardada. El informe final reemplaza al borrador."; reviewMessage.classList.add("form-success"); reviewMessage.hidden = false;
      appendAnalysisLog("Revisión pericial archivada; informe final emitido.", undefined, false, true);
    } catch (error) { reviewMessage.classList.remove("form-success"); reviewMessage.textContent = error instanceof Error ? error.message : "No se pudo generar el informe."; reviewMessage.hidden = false; }
    finally { finalize.textContent = "Guardar revisión"; finalize.disabled = false; setBusy(finalize, false); }
  });

  function renderSummary(summary: CaseSummary, target: HTMLElement) {
    target.replaceChildren(); target.className = "surface case-summary";
    const header = document.createElement("div"); header.className = "surface-heading";
    const title = document.createElement("div"); const eyebrow = document.createElement("span"); eyebrow.className = "metric-label"; eyebrow.textContent = summary.case_number; const heading = document.createElement("h2"); heading.textContent = summary.title; title.append(eyebrow, heading);
    const close = document.createElement("button"); close.className = "ghost-button"; close.textContent = "Volver a casos"; close.addEventListener("click", () => { analysisView.hidden = true; casesBrowser.hidden = false; }); header.append(title, close); target.append(header);
    for (const evidence of summary.evidences) {
      const section = document.createElement("section"); section.className = "case-summary-evidence"; const name = document.createElement("h3"); name.textContent = evidence.file_name; section.append(name);
      if (!evidence.report) { const pending = document.createElement("p"); pending.textContent = "Evidencia preservada; análisis pendiente."; section.append(pending); continue; }
      const report = evidence.report; const metrics = document.createElement("div"); metrics.className = "metric-row summary-metrics";
      const metricValues: [string, string | number][] = [["Dictamen", report.verdict], ["Confianza", report.confidence == null ? "—" : `${report.confidence}%`], ["Tiempo", report.processing_time_seconds == null ? "—" : `${report.processing_time_seconds} s`], ["Fotogramas", report.frames_analyzed ?? "—"], ["Rostros", report.faces_detected ?? "—"]];
      for (const [label, value] of metricValues) { const cell = document.createElement("div"); const cap = document.createElement("span"); cap.className = "metric-label"; cap.textContent = label; const val = document.createElement("strong"); val.textContent = String(value); cell.append(cap, val); metrics.append(cell); }
      section.append(metrics);
      if (report.artifact_issue) { const warning = document.createElement("p"); warning.className = "form-error"; warning.textContent = report.artifact_issue; section.append(warning); }
      const who = document.createElement("p"); who.className = "case-summary-meta"; who.textContent = `Perito: ${summary.audit.find(event => event.action === "EVIDENCE_ANALYSIS_QUEUED")?.actor ?? "Perito del expediente"} · Finalizado: ${report.completed_at ? new Date(report.completed_at).toLocaleString() : "—"}`; section.append(who);
      if (report.expert_conclusions) { const notes = document.createElement("p"); notes.className = "case-summary-notes"; notes.textContent = report.expert_conclusions; section.append(notes); }
      if (report.pdf_artifact_id) { const pdf = document.createElement("a"); pdf.className = "primary-button"; pdf.href = `${base}/${id(summary.id)}/artifacts/${id(report.pdf_artifact_id)}/download`; pdf.textContent = "Abrir informe PDF"; pdf.target = "_blank"; pdf.rel = "noreferrer"; section.append(pdf); }
      const heatmaps = document.createElement("div"); heatmaps.className = "summary-heatmaps"; for (const frame of report.heatmaps) { const figure = document.createElement("figure"); const img = document.createElement("img"); img.src = frame.image; img.alt = `Fotograma con mapa de calor${frame.second == null ? "" : ` en ${frame.second} segundos`}`; const caption = document.createElement("figcaption"); caption.textContent = frame.second == null ? "Fotograma destacado" : `Tiempo ${frame.second} s`; figure.append(img, caption); heatmaps.append(figure); } if (report.heatmaps.length) section.append(heatmaps);
      target.append(section);
    }
    const auditTitle = document.createElement("h3"); auditTitle.textContent = "Trazabilidad del caso"; target.append(auditTitle); const audit = document.createElement("ol"); audit.className = "summary-audit";
    for (const event of summary.audit) { const item = document.createElement("li"); item.textContent = `${new Date(event.timestamp).toLocaleString()} · ${event.actor} · ${event.action}`; audit.append(item); } target.append(audit);
  }
}
