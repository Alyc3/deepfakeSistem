/**
 * Interfaz — Registro del análisis paso a paso.
 *
 * La traza que respalda el dictamen ante el perito: cada etapa con su hora,
 * su marcador y su dato real.
 */
import { el } from "./dom";

export type LogStatus = "done" | "pending" | "warn" | "note";

const MARKERS: Record<LogStatus, string> = {
  done: "✓",
  pending: "◌",
  warn: "✗",
  note: "▸",
};

let pendingLine: HTMLLIElement | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function clearLog(placeholder: string | null = "A la espera de material…"): void {
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

export function addLog(text: string, status: LogStatus = "done"): HTMLLIElement {
  const idle = el.analysisLog.querySelector(".log-line--idle");
  if (idle) idle.remove();

  const li = document.createElement("li");
  li.className = `log-line log-line--${status}`;

  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString();

  const marker = document.createElement("span");
  marker.className = "log-marker";
  marker.textContent = MARKERS[status] ?? "·";

  const body = document.createElement("span");
  body.className = "log-text";
  body.textContent = text;

  li.append(time, marker, body);
  el.analysisLog.appendChild(li);
  el.analysisLog.scrollTop = el.analysisLog.scrollHeight;
  return li;
}

export function startPending(text: string): void {
  stopPending();
  pendingLine = addLog(`${text}…`, "pending");
  const started = performance.now();
  el.analysisElapsed.hidden = false;
  elapsedTimer = setInterval(() => {
    const seconds = Math.floor((performance.now() - started) / 1000);
    el.analysisElapsed.textContent = `${seconds}s`;
    const body = pendingLine?.querySelector(".log-text");
    if (body) body.textContent = `${text}… (${seconds}s)`;
  }, 1000);
}

export function stopPending(finalText: string | null = null): void {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
  if (!pendingLine) return;

  if (finalText === null) {
    pendingLine.remove();
  } else {
    pendingLine.className = "log-line log-line--done";
    const marker = pendingLine.querySelector(".log-marker");
    const body = pendingLine.querySelector(".log-text");
    if (marker) marker.textContent = MARKERS.done;
    if (body) body.textContent = finalText;
  }
  pendingLine = null;
}
