/**
 * Interfaz — Conexión oculta con el motor forense.
 *
 * Ctrl+Alt+Shift+M abre un panel para que la sesión use otro motor (por ejemplo, el del equipo del perito
 * publicado con un túnel). La URL se guarda en la sesión del servidor; el navegador solo recuerda la última
 * escrita para no tener que teclearla otra vez.
 */
import { setBusy } from "../loading";
import { showToast } from "../toast";

type Connection = { source: "session" | "server" | "none"; url: string | null };
const ENDPOINT = "/api/forensics/connection";
const LAST_URL_KEY = "certiface:engine-url";
// El almacenamiento puede estar bloqueado (modo privado): recordar la URL es solo una comodidad.
const remembered = () => { try { return localStorage.getItem(LAST_URL_KEY) ?? ""; } catch { return ""; } };
const remember = (url: string) => { try { localStorage.setItem(LAST_URL_KEY, url); } catch { /* sin almacenamiento */ } };

async function call(method: "GET" | "PUT" | "DELETE", body?: unknown): Promise<Connection> {
  const response = await fetch(ENDPOINT, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "No se pudo cambiar el motor.");
  return data as Connection;
}
function describe(connection: Connection): string {
  if (connection.source === "session") return `Esta sesión usa el motor ${connection.url}.`;
  if (connection.source === "server") return "Esta sesión usa el motor configurado en el servidor.";
  return "No hay ningún motor conectado. Escribe la URL de uno para analizar evidencias.";
}

export function wireEngineConnection(onChange: () => void): void {
  const dialog = document.getElementById("engine-dialog") as HTMLDialogElement | null;
  if (!dialog) return;
  const form = document.getElementById("engine-form") as HTMLFormElement;
  const input = form.elements.namedItem("url") as HTMLInputElement;
  const stateText = document.getElementById("engine-state")!;
  const message = document.getElementById("engine-message")!;
  const reset = document.getElementById("engine-reset") as HTMLButtonElement;
  const say = (text: string) => { message.textContent = text; message.hidden = !text; };
  const render = (connection: Connection) => { stateText.textContent = describe(connection); reset.hidden = connection.source !== "session"; };

  async function open(): Promise<void> {
    say(""); input.value = remembered();
    dialog!.showModal(); input.focus();
    try { render(await call("GET")); } catch (error) { stateText.textContent = error instanceof Error ? error.message : ""; }
  }
  document.addEventListener("keydown", (event) => {
    // Se usa la tecla física (event.code) para que funcione igual con teclados en español.
    if (event.ctrlKey && event.altKey && event.shiftKey && event.code === "KeyM") { event.preventDefault(); void open(); }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    submit.disabled = true; setBusy(submit, true); say("");
    try {
      render(await call("PUT", { url: input.value.trim() }));
      remember(input.value.trim());
      showToast("Motor conectado."); dialog.close(); onChange();
    } catch (error) { say(error instanceof Error ? error.message : "No se pudo conectar."); }
    finally { submit.disabled = false; setBusy(submit, false); }
  });
  reset.addEventListener("click", async () => {
    try { render(await call("DELETE")); showToast("Se usa el motor del servidor."); onChange(); }
    catch (error) { say(error instanceof Error ? error.message : "No se pudo restablecer."); }
  });
  dialog.querySelector("[data-engine-close]")!.addEventListener("click", () => dialog.close());
}
