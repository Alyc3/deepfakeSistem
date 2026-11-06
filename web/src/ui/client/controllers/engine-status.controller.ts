/**
 * Interfaz — Estado del motor forense en el laboratorio.
 */
import { el } from "../dom";
import { lab } from "../lab";

type StatusState = "unknown" | "checking" | "online" | "offline";

function setStatus(status: StatusState, text: string): void {
  el.statusDot.dataset.state = status;
  el.statusText.textContent = text;
}

export function setBackendOnline(): void {
  setStatus("online", "Motor disponible");
}

export function setBackendOffline(): void {
  setStatus("offline", "Motor no disponible");
}

export async function refreshHealth(): Promise<void> {
  setStatus("checking", "Comprobando motor…");
  const status = await lab().checkBackendStatus();
  if (status.online) setBackendOnline();
  else setBackendOffline();
}
