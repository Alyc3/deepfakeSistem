/**
 * Interfaz — Cámara de evidencia.
 *
 * Ingesta del material (selector, arrastre o muestra de demostración) y
 * vista previa a tamaño completo. En el navegador los bytes ya están en un
 * objeto `File`, así que la reproducción es nativa mediante un Blob URL: no
 * hace falta ningún puente al sistema de archivos.
 */
import type { EvidenceFile, EvidenceInspection } from "@domain/evidence";
import { el } from "../dom";
import { state } from "../state";
import { lab } from "../lab";
import { showToast } from "../toast";
import { clearLog } from "../analysis-log";
import { clearAnalysisOutputs } from "../presenters/clear";

const SAMPLES: Record<string, { url: string; name: string }> = {
  real: { url: "/assets/muestras/sample-real.jpg", name: "sample-real.jpg" },
  fake: { url: "/assets/muestras/sample-fake.jpg", name: "sample-fake.jpg" },
};

// Blob URL de la vista previa actual; se revoca al sustituirlo para no
// acumular memoria.
let previewObjectUrl: string | null = null;

function clearPreviewUrl(): void {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
}

function renderPreview(file: EvidenceFile | null): void {
  el.preview.replaceChildren();
  clearPreviewUrl();
  if (!file) {
    el.previewFrame.hidden = true;
    return;
  }

  previewObjectUrl = URL.createObjectURL(file.blob);

  if (file.kind === "video") {
    const video = document.createElement("video");
    video.src = previewObjectUrl;
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    el.preview.appendChild(video);
  } else {
    const image = document.createElement("img");
    image.src = previewObjectUrl;
    image.alt = "Vista previa del material cuestionado";
    el.preview.appendChild(image);
  }

  el.previewFrame.hidden = false;
}

export function setFile(file: EvidenceFile | null): void {
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

function handleInspection(inspection: EvidenceInspection): void {
  if (!inspection.ok) {
    showToast(inspection.error);
    return;
  }
  clearAnalysisOutputs();
  clearLog("Material cargado. Ejecuta el análisis cuando estés listo.");
  setFile(inspection.file);
}

/** Punto de entrada común: venga de donde venga el archivo, se valida igual. */
export function admitFile(file: File): void {
  handleInspection(lab().selectEvidence(file));
}

export function resetAll(): void {
  clearAnalysisOutputs();
  clearLog();
  setFile(null);
  el.fileInput.value = "";
}

export function openFilePicker(): void {
  el.fileInput.click();
}

async function loadSample(which: string): Promise<void> {
  const sample = SAMPLES[which];
  if (!sample) return;
  try {
    const response = await fetch(sample.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    // Se envuelve en un File para que pase por las mismas reglas de admisión
    // que el material del perito.
    admitFile(new File([blob], sample.name, { type: blob.type || "image/jpeg" }));
  } catch (err) {
    console.error("[CertiFace] No se pudo cargar la muestra:", err);
    showToast("No se pudo cargar la muestra de demostración.");
  }
}

function wireDragAndDrop(): void {
  // Sin esto, soltar un archivo haría que el navegador lo abriese y
  // abandonase el laboratorio.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());

  el.dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    el.dropzone.classList.add("dragging");
  });

  el.dropzone.addEventListener("dragleave", () => {
    el.dropzone.classList.remove("dragging");
  });

  el.dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    el.dropzone.classList.remove("dragging");
    const dropped = event.dataTransfer?.files?.[0];
    if (!dropped) return;
    admitFile(dropped);
  });
}

export function wireEvidence(): void {
  el.dropzone.addEventListener("click", openFilePicker);

  el.fileInput.addEventListener("change", () => {
    const picked = el.fileInput.files?.[0];
    if (picked) admitFile(picked);
    // Se limpia para que elegir dos veces el mismo archivo vuelva a disparar
    // el evento.
    el.fileInput.value = "";
  });

  el.reset.addEventListener("click", resetAll);

  for (const button of document.querySelectorAll<HTMLElement>("[data-sample]")) {
    button.addEventListener("click", () => loadSample(button.dataset.sample ?? ""));
  }

  wireDragAndDrop();
}
