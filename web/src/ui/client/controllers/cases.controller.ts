type CaseRow = { id: string; case_number: string; title: string; created_at?: string };
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
  const output = document.getElementById("case-analysis-output")!;
  const result = document.getElementById("case-analysis-result")!;
  const notes = document.getElementById("expert-observations") as HTMLTextAreaElement;
  const finalize = document.getElementById("finalize-case-report") as HTMLButtonElement;
  const auditLog = document.getElementById("case-audit-log")!;
  const analysisScreen = document.getElementById("analysis-screen")!;
  const analysisLog = document.getElementById("analysis-live-log")!;
  const analysisProgress = document.getElementById("analysis-progress")!;
  const progressFill = document.getElementById("analysis-progress-fill")!;
  const progressCaption = document.getElementById("analysis-progress-caption")!;
  const analysisVerdict = document.getElementById("analysis-verdict")!;
  const progressEvents = new Set<string>();
  const currentRole = (JSON.parse(document.getElementById("view-app")!.getAttribute("data-user") ?? "{}")?.role?.name ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  let selected: CaseRow | null = null; let file: File | null = null; let hash = ""; let archive: Archive | null = null; let reportId = "";
  let previewUrl: string | null = null;
  let analysisInFlight = false;

  const appendAnalysisLog = (message: string, timestamp = new Date().toISOString(), failed = false) => {
    analysisLog.querySelector(".is-current")?.classList.remove("is-current");
    const entry = document.createElement("li"); entry.className = `analysis-log-entry${failed ? " is-error" : " is-current"}`;
    const time = document.createElement("time"); time.dateTime = timestamp; time.textContent = new Date(timestamp).toLocaleTimeString();
    const text = document.createElement("span"); text.textContent = message; entry.append(time, text); analysisLog.append(entry); analysisLog.scrollTop = analysisLog.scrollHeight;
  };
  const showProgress = (progress: JobProgress | null, status = "queued") => {
    const stages: Record<string, [string, string]> = {
      queued: ["EN COLA", "Esperando al worker de inferencia…"], verification: ["VERIFICACIÓN FORENSE", "Comprobando la copia preservada…"],
      extracting: ["PREPARACIÓN DEL VIDEO", "Extrayendo fotogramas para el análisis…"], inference: ["MODELOS EN EJECUCIÓN", "Analizando la evidencia…"],
      heatmaps: ["MAPAS DE CALOR", "Preparando las explicaciones visuales…"], archive: ["ARCHIVO FORENSE", "Sellando y guardando el informe…"],
      completed: ["ANÁLISIS COMPLETADO", "El dictamen está listo para revisión pericial."],
    };
    const [label, title] = stages[progress?.stage ?? status] ?? stages.queued;
    document.getElementById("analysis-phase-label")!.textContent = label;
    document.getElementById("analysis-status-title")!.textContent = title;
    document.getElementById("analysis-status-detail")!.textContent = progress?.message ?? (status === "queued" ? "La tarea está en cola y se ejecutará cuando Celery la reciba." : "Consultando el estado del trabajo…");
    if (progress?.current != null && progress.total != null && progress.total > 0) {
      const percent = Math.max(0, Math.min(100, Math.round(progress.current / progress.total * 100)));
      analysisProgress.classList.remove("is-indeterminate"); analysisProgress.setAttribute("aria-valuenow", String(percent)); progressFill.style.width = `${percent}%`;
      progressCaption.textContent = `Fotograma ${progress.current} de ${progress.total} · ${percent}%`;
    } else if (progress?.stage === "completed" || status === "completed") {
      analysisProgress.classList.remove("is-indeterminate"); analysisProgress.setAttribute("aria-valuenow", "100"); progressFill.style.width = "100%"; progressCaption.textContent = "Proceso completado";
    } else {
      analysisProgress.classList.add("is-indeterminate"); analysisProgress.removeAttribute("aria-valuenow"); progressCaption.textContent = "Proceso activo · la duración depende del archivo y del equipo";
    }
    for (const event of progress?.events ?? []) if (!progressEvents.has(event.id)) { progressEvents.add(event.id); appendAnalysisLog(event.message, event.timestamp); }
  };
  const renderAnalysisVerdict = (data: any) => {
    analysisVerdict.hidden = false;
    const verdict = data.verdict_forensic ?? (data.prediction === "Fake" ? "MANIPULADO" : data.prediction === "Real" ? "SIN MANIPULACIÓN" : "ANTECEDENTES");
    const badge = document.getElementById("analysis-verdict-badge")!; badge.textContent = verdict;
    badge.className = `verdict-badge${verdict === "SIN_MANIPULACION" || verdict === "SIN MANIPULACIÓN" ? " is-real" : verdict === "ANTECEDENTES" ? " is-review" : ""}`;
    document.getElementById("analysis-verdict-copy")!.textContent = `Confianza del modelo: ${data.confidence == null ? "No disponible" : `${data.confidence}%`}. El resultado requiere revisión del perito.`;
    const metrics = document.getElementById("analysis-verdict-metrics")!; metrics.replaceChildren();
    for (const [label, value] of [["Confianza", data.confidence == null ? "—" : `${data.confidence}%`], ["Fotogramas", data.frames_analyzed ?? "—"], ["Rostros", data.faces_detected ?? "—"], ["Tiempo", data.processing_time_seconds == null ? "—" : `${data.processing_time_seconds} s`]] as [string, string | number][]) {
      const cell = document.createElement("div"); const dt = document.createElement("dt"); dt.textContent = label; const dd = document.createElement("dd"); dd.textContent = String(value); cell.append(dt, dd); metrics.append(cell);
    }
    const heatmaps = document.getElementById("analysis-heatmaps")!; heatmaps.replaceChildren();
    const frames = data.explanation?.frames ?? [];
    const visuals = frames.length ? frames.slice(0, 12) : data.explanation?.image ? [{ image: data.explanation.image }] : [];
    for (const [index, frame] of visuals.entries()) {
      if (!frame.image) continue;
      const figure = document.createElement("figure"); const image = document.createElement("img"); image.src = frame.image;
      image.alt = `Fotograma ${index + 1} con mapa de calor`;
      const caption = document.createElement("figcaption"); caption.textContent = frame.second == null ? `Fotograma destacado ${index + 1}` : `Fotograma ${index + 1} · ${frame.second} s`;
      figure.append(image, caption); heatmaps.append(figure);
    }
    heatmaps.hidden = visuals.length === 0;
    document.getElementById("analysis-result-note")!.textContent = data.suspicious_seconds?.length ? `Momentos señalados: ${data.suspicious_seconds.map((item: { second: number }) => `${item.second} s`).join(" · ")}` : "No se señalaron momentos específicos; revisa el fotograma destacado y el expediente.";
  };

  const refresh = async () => {
    try {
      const cases = await request(base) as CaseRow[];
      list.replaceChildren();
      if (!cases.length) { list.innerHTML = '<p class="empty-state">Aún no hay expedientes. Crea el primero para comenzar.</p>'; return; }
      for (const row of cases) {
        const card = document.createElement("article"); card.className = "case-card";
        const details = document.createElement("div"); const strong = document.createElement("strong"); strong.textContent = row.title; const small = document.createElement("small"); small.textContent = row.case_number; details.append(strong, small);
        const button = document.createElement("button"); button.className = "ghost-button"; button.textContent = "Abrir caso"; button.addEventListener("click", () => void openCase(row)); card.append(details, button); list.append(card);
      }
    } catch (error) { list.textContent = error instanceof Error ? error.message : "No se pudieron cargar los casos."; }
  };
  const openCase = async (row: CaseRow) => {
    selected = row; file = null; hash = ""; archive = null; fileInput.value = ""; preserveButton.disabled = true; analyzeButton.disabled = true;
    referenceHash.value = ""; reportId = ""; output.hidden = true;
    if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; evidencePreview.hidden = true;
    workflow.hidden = true; analysisScreen.hidden = true; const summaryPanel = document.getElementById("case-summary")!; summaryPanel.hidden = true;
    document.getElementById("case-view-number")!.textContent = row.case_number;
    document.getElementById("case-view-title")!.textContent = row.title;
    casesBrowser.hidden = true; analysisView.hidden = false;
    try {
      const summary = await request(`${base}/${id(row.id)}/summary`) as CaseSummary;
      const completed = summary.evidences.find(item => item.report)?.report;
      if (completed) { renderSummary(summary, summaryPanel); summaryPanel.hidden = false; summaryPanel.scrollIntoView({ behavior: "smooth" }); return; }
      workflow.hidden = false;
      const pending = summary.evidences[0];
      if (pending) { archive = { case_id: row.id, evidence_id: pending.id, report_id: null, objects: [] }; analyzeButton.disabled = false; preserveButton.hidden = true; fileInput.disabled = true; referenceHash.disabled = true; hashState.textContent = `Evidencia ${pending.file_name} ya preservada · SHA-256 ${pending.sha256}`; previewCaption.textContent = "El original continúa bajo custodia; el análisis utiliza únicamente su copia de trabajo."; evidencePreview.hidden = false; }
      else { archive = null; preserveButton.hidden = false; fileInput.disabled = false; referenceHash.disabled = false; previewCaption.textContent = ""; updatePreserve(); }
      workflow.scrollIntoView({ behavior: "smooth" });
    } catch (error) { message.textContent = error instanceof Error ? error.message : "No se pudo abrir el caso."; analysisView.hidden = true; casesBrowser.hidden = false; }
  };
  void refresh(); document.getElementById("cases-refresh")!.addEventListener("click", () => void refresh());
  closeAnalysisButton.addEventListener("click", () => { if (analysisInFlight) return; analysisView.hidden = true; casesBrowser.hidden = false; if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; void refresh(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); const data = new FormData(form);
    try { const response = await request(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(data)) }); message.textContent = `Expediente ${response.case_number} creado.`; form.reset(); await refresh(); }
    catch (error) { message.textContent = error instanceof Error ? error.message : "No se pudo crear el caso."; }
  });
  fileInput.addEventListener("change", async () => {
    file = fileInput.files?.[0] ?? null; hash = ""; archive = null; analyzeButton.disabled = true; preserveButton.disabled = true; output.hidden = true;
    if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null;
    if (!file) { hashState.textContent = "Selecciona una evidencia para calcular SHA-256."; return; }
    previewUrl = URL.createObjectURL(file); evidencePreview.hidden = false;
    videoPreview.hidden = !file.type.startsWith("video/"); imagePreview.hidden = !file.type.startsWith("image/");
    if (videoPreview.hidden) videoPreview.removeAttribute("src"); else { videoPreview.src = previewUrl; videoPreview.load(); }
    if (imagePreview.hidden) imagePreview.removeAttribute("src"); else imagePreview.src = previewUrl;
    previewCaption.textContent = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(2)} MB`;
    hashState.textContent = "Calculando huella SHA-256…";
    try { const bytes = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); hash = [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, "0")).join(""); hashState.textContent = `SHA-256 calculado: ${hash}. Ingresa el hash de referencia para habilitar la preservación.`; updatePreserve(); }
    catch { hashState.textContent = "No fue posible calcular el hash. Se requiere un navegador con Web Crypto."; }
  });
  document.getElementById("analysis-back")!.addEventListener("click", () => { analysisScreen.hidden = true; workflow.hidden = false; });
  document.getElementById("analysis-review-button")!.addEventListener("click", () => { analysisScreen.hidden = true; workflow.hidden = false; output.hidden = false; output.scrollIntoView({ behavior: "smooth", block: "start" }); });
  const updatePreserve = () => { const same = referenceHash.value.trim().toLowerCase() === hash && /^[0-9a-f]{64}$/.test(hash); preserveButton.disabled = !selected || !file || !same; if (file && hash && referenceHash.value && !same) hashState.textContent = `Hash no coincide. Calculado: ${hash}`; else if (same) hashState.textContent = `Hash SHA-256 coincide: ${hash}. El servidor volverá a verificarlo al recibir el archivo.`; };
  referenceHash.addEventListener("input", updatePreserve);
  preserveButton.addEventListener("click", async () => {
    if (!selected || !file || !hash) return; preserveButton.disabled = true; preserveButton.textContent = "Preservando…";
    const body = new FormData(); body.append("file", file); body.append("expected_sha256", hash);
    try { archive = await request(`${base}/${id(selected.id)}/ingest`, { method: "POST", body }) as Archive; hashState.textContent = `Hash verificado por el servidor. Original y copia de trabajo preservados. SHA-256 ${hash}`; analyzeButton.disabled = false;
      const original = archive.objects.find(row => row.kind === "original"); const originalArea = document.getElementById("case-report-download")!;
      if (original && ["ADMIN", "ADMINISTRADOR", "GERENTE_GENERAL"].includes(currentRole)) { const link = document.createElement("a"); link.className = "ghost-button"; link.href = `${base}/${id(archive.case_id)}/artifacts/${id(original.id)}/download`; link.textContent = "Descargar original (administración)"; link.setAttribute("download", ""); originalArea.replaceChildren(link); }
      else originalArea.textContent = "Original preservado. Su descarga requiere autorización administrativa.";
      await refresh(); }
    catch (error) { hashState.textContent = error instanceof Error ? error.message : "No se pudo preservar la evidencia."; preserveButton.disabled = false; }
    finally { preserveButton.textContent = "Guardar original y crear copia"; }
  });
  analyzeButton.addEventListener("click", async () => {
    if (!selected || !archive) return; analysisInFlight = true; closeAnalysisButton.disabled = true; analysisBackButton.disabled = true; analyzeButton.disabled = true; analyzeButton.textContent = "Analizando copia…";
    const activeCase = selected;
    progressEvents.clear(); analysisLog.replaceChildren(); analysisVerdict.hidden = true;
    document.getElementById("analysis-case-number")!.textContent = activeCase.case_number;
    document.getElementById("analysis-case-title")!.textContent = activeCase.title;
    document.getElementById("analysis-job-label")!.textContent = "ENVIANDO TAREA";
    document.getElementById("analysis-phase-label")!.textContent = "EN COLA";
    document.getElementById("analysis-status-title")!.textContent = "Enviando análisis al worker…";
    document.getElementById("analysis-status-detail")!.textContent = "La tarea analizará exclusivamente la copia preservada.";
    analysisProgress.classList.add("is-indeterminate"); analysisProgress.removeAttribute("aria-valuenow"); progressFill.style.width = "";
    progressCaption.textContent = "Esperando confirmación del worker…";
    appendAnalysisLog("Solicitud enviada; esperando confirmación de Celery.");
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
        if (data.status === "failed") throw new Error(data.detail ?? "El worker reportó un fallo durante el análisis.");
      }
      if (!data?.result) throw new Error("Se agotó el tiempo de espera visual. Revisa el estado del trabajo antes de volver a iniciarlo.");
      reportId = data.result.report_id; archive = data.result.archive ?? archive;
      result.textContent = `Dictamen: ${data.result.verdict_forensic ?? data.result.prediction}\nConfianza: ${data.result.confidence ?? "—"}%\nFotogramas analizados: ${data.result.frames_analyzed ?? "—"}\nRostros detectados: ${data.result.faces_detected ?? "—"}\nTiempo del modelo: ${data.result.processing_time_seconds ?? "—"} s`;
      output.hidden = false; finalize.disabled = !reportId;
      showProgress({ stage: "completed", message: "Resultado guardado; está listo para la revisión del perito." }, "completed");
      appendAnalysisLog("Dictamen disponible. Continúa con las observaciones periciales."); renderAnalysisVerdict(data.result);
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
  notes.addEventListener("input", () => { finalize.disabled = !reportId || notes.value.trim().length < 10; });
  finalize.addEventListener("click", async () => {
    if (!selected || !archive || !reportId || notes.value.trim().length < 10) return; finalize.disabled = true; finalize.textContent = "Generando PDF…";
    try { const finalizedArchive = await request(`${base}/${id(selected.id)}/reports/${id(reportId)}/finalize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expert_conclusions: notes.value.trim() }) }) as Archive; archive = finalizedArchive;
      const pdf = finalizedArchive.objects.find(row => row.kind === "pdf"); if (!pdf) throw new Error("El reporte fue archivado, pero la respuesta no incluyó el PDF."); const anchor = document.createElement("a"); anchor.className = "ghost-button"; anchor.href = `${base}/${id(finalizedArchive.case_id)}/artifacts/${id(pdf.id)}/download`; anchor.textContent = "Descargar informe PDF"; anchor.setAttribute("download", ""); document.getElementById("case-report-download")!.append(anchor);
      const events = await request(`${base}/${id(selected.id)}/custody-log`) as { action: string; timestamp: string; hash_verified: boolean }[];
      auditLog.replaceChildren(); const title = document.createElement("h3"); title.textContent = "Auditoría del expediente"; auditLog.append(title);
      for (const item of events) { const line = document.createElement("p"); line.textContent = `${new Date(item.timestamp).toLocaleString()} · ${item.action} · hash ${item.hash_verified ? "verificado" : "pendiente/no verificado"}`; auditLog.append(line); }
    } catch (error) { hashState.textContent = error instanceof Error ? error.message : "No se pudo generar el PDF."; }
    finally { finalize.textContent = "Guardar revisión y generar PDF"; finalize.disabled = false; }
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
