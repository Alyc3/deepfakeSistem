/**
 * Interfaz — Estado del backend y configuración.
 */
import { el } from "../dom";
import { state } from "../state";
import { lab } from "../lab";
import { showToast } from "../toast";

type StatusState = "unknown" | "checking" | "online" | "offline";

function setStatus(status: StatusState, text: string): void {
  el.statusDot.dataset.state = status;
  el.statusText.textContent = text;
}

export function setBackendOnline(): void {
  setStatus("online", `Backend en línea · ${state.settings.apiUrl}`);
}

export function setBackendOffline(): void {
  setStatus("offline", "Backend fuera de línea — clic para reintentar");
}

export async function refreshHealth(): Promise<void> {
  setStatus("checking", "Comprobando backend…");
  const status = await lab().checkBackendStatus();
  if (status.online) setBackendOnline();
  else setBackendOffline();
}

export function toggleSettings(force?: boolean): void {
  const nextHidden = force === undefined ? !el.settingsPanel.hidden : !force;
  el.settingsPanel.hidden = nextHidden;
  if (!nextHidden) el.apiUrl.focus();
}

function saveApiUrl(): void {
  const outcome = lab().saveApiUrl(el.apiUrl.value);
  if (!outcome.ok) {
    showToast(outcome.error);
    return;
  }
  state.settings = outcome.settings;
  toggleSettings(false);
  showToast("Configuración guardada.");
  void refreshHealth();
}

export function loadSettings(): void {
  state.settings = lab().readSettings();
  el.apiUrl.value = state.settings.apiUrl;
}

export function wireSettings(): void {
  el.settingsToggle.addEventListener("click", () => toggleSettings());
  el.settingsSave.addEventListener("click", saveApiUrl);
  el.statusText.addEventListener("click", () => void refreshHealth());
  el.apiUrl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveApiUrl();
  });
}
