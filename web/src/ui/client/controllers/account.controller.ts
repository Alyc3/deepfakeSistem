import { fullName, type AccountSession } from "@domain/identity";
import { lab } from "../lab";
import { showToast } from "../toast";
import { describeError } from "../errors";
import { liveValidation, restrictField, restrictForm, validateForm } from "../validation";
import { busy, setBusy } from "../loading";
import { PROFILE_SCHEMA, RULES } from "@domain/validation";

const node = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const input = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement;
const dateTime = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" });

function say(id: string, text: string, ok = false): void {
  const target = node(id); if (!target) return;
  target.textContent = text; target.hidden = !text; target.classList.toggle("form-success", ok);
}
/** Ejecuta el envío de un formulario con el botón deshabilitado y limpia las contraseñas al terminar. */
function onSubmit(form: HTMLFormElement | null, messageId: string, run: (form: HTMLFormElement) => Promise<string | void>): void {
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]:not([form])');
    if (button) { button.disabled = true; setBusy(button, true); }
    say(messageId, "");
    try { const text = await run(form); if (text) say(messageId, text, true); }
    catch (error) { say(messageId, describeError(error, "No se pudo completar la operación.")); }
    finally {
      if (button) { button.disabled = false; setBusy(button, false); }
      form.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((field) => field.value = "");
    }
  });
}
/** "Chrome en Windows" a partir del User-Agent; suficiente para reconocer un dispositivo. */
function device(agent?: string | null): string {
  if (!agent) return "Dispositivo desconocido";
  const browser = /Edg\//.test(agent) ? "Edge" : /OPR\//.test(agent) ? "Opera" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "Navegador";
  const system = /Windows/.test(agent) ? "Windows" : /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Mac OS X/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : "";
  return system ? `${browser} en ${system}` : browser;
}

function wireProfile(): void {
  const form = node<HTMLFormElement>("profile-form");
  if (!form) return;
  const button = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const names = ["first_name", "last_name", "phone_number"] as const;
  const snapshot = () => names.map((name) => input(form, name).value.trim()).join("\u0000");
  let saved = snapshot();
  // «Guardar» solo se habilita cuando hay algo que guardar.
  const sync = () => { button.disabled = snapshot() === saved; };
  restrictForm(form, PROFILE_SCHEMA);
  const live = liveValidation(form, PROFILE_SCHEMA);
  form.addEventListener("input", () => { say("profile-message", ""); sync(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!live.validate()) return;
    say("profile-message", "");
    try {
      const value = (name: string) => input(form, name).value.trim() || null;
      const user = await busy(button, () => lab().identity.updateProfile({ first_name: value("first_name"), last_name: value("last_name"), phone_number: value("phone_number") }), "Guardando…");
      for (const name of names) input(form, name).value = user[name] ?? "";
      saved = snapshot();
      // El nombre aparece en la tarjeta y en la cabecera: se actualizan sin recargar.
      const name = fullName(user);
      const initials = name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
      for (const id of ["profile-name", "analyst-name"]) { const target = node(id); if (target) target.textContent = name; }
      for (const target of [node("profile-initials"), document.querySelector<HTMLElement>(".header-profile .avatar-small")]) if (target) target.textContent = initials;
      say("profile-message", "Datos actualizados.", true);
    } catch (error) { say("profile-message", describeError(error, "No se pudieron guardar los cambios.")); }
    finally { sync(); }
  });
}

async function renderSessions(): Promise<void> {
  const list = node<HTMLUListElement>("session-list"); if (!list) return;
  try {
    const sessions = await lab().identity.listSessions();
    list.replaceChildren(...sessions.sort((a, b) => Number(b.current) - Number(a.current) || b.last_used_at.localeCompare(a.last_used_at)).map(sessionItem));
    if (!sessions.length) list.replaceChildren(Object.assign(document.createElement("li"), { className: "inline-message", textContent: "No hay sesiones abiertas." }));
  } catch (error) { list.replaceChildren(); say("session-message", describeError(error, "No se pudieron cargar las sesiones.")); }
}
function sessionItem(session: AccountSession): HTMLLIElement {
  const item = document.createElement("li"); item.className = "session-item";
  const copy = document.createElement("div");
  const title = document.createElement("strong"); title.textContent = device(session.user_agent);
  const detail = document.createElement("small");
  detail.textContent = `${session.ip_address || "IP desconocida"} · último uso ${dateTime.format(new Date(session.last_used_at))}`;
  copy.append(title, detail); item.append(copy);
  if (session.current) {
    const badge = document.createElement("span"); badge.className = "badge badge-moss"; badge.textContent = "Esta sesión"; item.append(badge);
  } else {
    const button = document.createElement("button"); button.type = "button"; button.className = "text-action danger-action"; button.textContent = "Cerrar";
    button.setAttribute("aria-label", `Cerrar la sesión de ${title.textContent}`);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await lab().identity.revokeSession(session.id); showToast("Sesión cerrada."); await renderSessions(); }
      catch (error) { button.disabled = false; say("session-message", describeError(error, "No se pudo cerrar la sesión.")); }
    });
    item.append(button);
  }
  return item;
}

function setMfaState(enabled: boolean): void {
  const status = node("mfa-status"), badge = node("mfa-badge");
  if (status) status.textContent = enabled ? "Al iniciar sesión se pide un código de tu app de autenticación." : "Actívala para pedir un código de tu app de autenticación además de la contraseña.";
  if (badge) { badge.textContent = enabled ? "Activa" : "Inactiva"; badge.className = `badge ${enabled ? "badge-moss" : "badge-muted"}`; }
  node("mfa-setup-form")!.hidden = enabled; node("mfa-enable-form")!.hidden = true; node("mfa-disable-form")!.hidden = !enabled;
}
/** Los códigos de la app de autenticación: solo números. */
function wireCode(form: HTMLFormElement | null): void {
  const code = form?.elements.namedItem("code");
  if (code instanceof HTMLInputElement) restrictField(code, RULES.otpCode);
}
const codeOk = (form: HTMLFormElement) => validateForm(form, { code: RULES.otpCode }, { required: ["code"] });
function wireSecurity(): void {
  wireCode(node<HTMLFormElement>("mfa-enable-form")); wireCode(node<HTMLFormElement>("mfa-disable-form"));
  onSubmit(node<HTMLFormElement>("password-form"), "password-message", async (form) => {
    if (input(form, "new_password").value !== input(form, "confirmation").value) throw new Error("Las contraseñas nuevas no coinciden.");
    const text = await lab().identity.changePassword(input(form, "current_password").value, input(form, "new_password").value);
    void renderSessions();
    return text || "Contraseña actualizada.";
  });
  onSubmit(node<HTMLFormElement>("mfa-setup-form"), "mfa-message", async (form) => {
    const setup = await lab().identity.setupMfa(input(form, "password").value);
    node<HTMLImageElement>("mfa-qr")!.src = setup.qr_svg;
    node("mfa-secret")!.textContent = setup.secret.replace(/(.{4})/g, "$1 ").trim();
    form.hidden = true; node("mfa-enable-form")!.hidden = false;
    input(node<HTMLFormElement>("mfa-enable-form")!, "code").focus();
  });
  onSubmit(node<HTMLFormElement>("mfa-enable-form"), "mfa-message", async (form) => {
    if (!codeOk(form)) return;
    const text = await lab().identity.enableMfa(input(form, "code").value.replace(/\s+/g, ""));
    form.reset(); node<HTMLImageElement>("mfa-qr")!.removeAttribute("src"); node("mfa-secret")!.textContent = "";
    setMfaState(true);
    return text;
  });
  node("mfa-enable-cancel")?.addEventListener("click", () => {
    node<HTMLFormElement>("mfa-enable-form")!.reset(); node<HTMLImageElement>("mfa-qr")!.removeAttribute("src"); node("mfa-secret")!.textContent = "";
    setMfaState(false); say("mfa-message", "");
  });
  onSubmit(node<HTMLFormElement>("mfa-disable-form"), "mfa-message", async (form) => {
    if (!codeOk(form)) return;
    const text = await lab().identity.disableMfa(input(form, "password").value, input(form, "code").value.replace(/\s+/g, ""));
    form.reset(); setMfaState(false);
    return text;
  });
  node("security-logout-all")?.addEventListener("click", async () => {
    if (!window.confirm("Se cerrarán todas tus sesiones, también esta. ¿Continuar?")) return;
    try { await lab().identity.logoutAll(); window.location.assign("/login"); }
    catch (error) { say("session-message", describeError(error, "No se pudieron cerrar las sesiones.")); }
  });
  void renderSessions();
}

/** Fechas en la zona horaria del navegador (el servidor las pinta en UTC). */
function localizeDates(): void {
  const day = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" });
  document.querySelectorAll<HTMLTimeElement>("time[data-local-time]").forEach((time) => { time.textContent = day.format(new Date(time.dateTime)); });
}

export function wireAccount(section: string): void {
  localizeDates();
  if (section === "perfil") wireProfile();
  if (section === "seguridad") wireSecurity();
}
