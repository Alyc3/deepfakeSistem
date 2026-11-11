import { lab } from "../lab";
import { showToast } from "../toast";
import { describeError } from "../errors";
import { restrictField } from "../validation";
import { setBusy } from "../loading";
import { RULES } from "@domain/validation";

export async function handleLogout(): Promise<void> {
  try { await lab().logoutAnalyst(); window.location.assign("/login"); }
  catch (error) { showToast(error instanceof Error ? error.message : "No se pudo cerrar la sesión."); }
}

/**
 * Estados del acceso. La vista los refleja en `data-state`: la línea de
 * escaneo de la ilustración acelera mientras se comprueba y se vuelve verde
 * al entrar; el botón y la línea de estado dicen qué está pasando.
 */
type State = "idle" | "verifying" | "entering" | "error";

const CAPTION: Record<State, string> = {
  idle: "Laboratorio en línea",
  verifying: "Verificando identidad",
  entering: "Identidad verificada",
  error: "Laboratorio en línea",
};

export function wireAuth(): void {
  const form = document.getElementById("login-form") as HTMLFormElement | null;
  if (!form) return;
  const view = document.getElementById("view-login")!;
  const mfaForm = document.getElementById("mfa-form") as HTMLFormElement;
  const errorNode = document.getElementById("login-error")!;
  const mfaError = document.getElementById("mfa-error")!;
  const title = document.getElementById("login-title")!;
  const hint = document.getElementById("login-hint")!;
  const links = document.getElementById("login-links")!;
  const status = document.getElementById("login-status")!;
  const caption = document.getElementById("auth-caption-text");
  const email = document.getElementById("login-user") as HTMLInputElement;
  const password = document.getElementById("login-pass") as HTMLInputElement;
  const reveal = document.getElementById("login-reveal") as HTMLButtonElement;
  const submit = document.getElementById("login-submit") as HTMLButtonElement;
  const code = document.getElementById("mfa-code") as HTMLInputElement;
  const mfaSubmit = document.getElementById("mfa-submit") as HTMLButtonElement;
  const mfaCancel = document.getElementById("mfa-cancel") as HTMLButtonElement;
  restrictField(code, RULES.otpCode);

  const setState = (state: State, message = "") => {
    view.dataset.state = state;
    status.textContent = message;
    if (caption) caption.textContent = CAPTION[state];
    const locked = state === "verifying" || state === "entering";
    for (const field of [email, password, code]) field.readOnly = locked;
    reveal.disabled = locked; mfaCancel.disabled = locked;
  };

  /** Botón ocupado con un texto que describe el paso; devuelve cómo restaurarlo. */
  const working = (button: HTMLButtonElement, label: string) => {
    const original = button.dataset.label ??= button.textContent ?? "";
    button.disabled = true; button.textContent = label; setBusy(button, true);
    return () => { button.disabled = false; button.textContent = original; setBusy(button, false); };
  };

  const enter = (button: HTMLButtonElement) => {
    button.textContent = "Entrando…";
    setState("entering", "Abriendo tu espacio de trabajo…");
    window.location.assign("/app");
  };

  const showError = (node: HTMLElement, text: string, focus?: HTMLInputElement) => {
    node.textContent = text; node.hidden = false; setState("error");
    view.classList.remove("is-shaking"); void view.offsetWidth; view.classList.add("is-shaking");
    focus?.focus();
  };

  const showStep = (mfa: boolean) => {
    form.hidden = mfa; mfaForm.hidden = !mfa; links.hidden = mfa;
    title.textContent = mfa ? "Verificación en dos pasos" : "Hola de nuevo";
    hint.textContent = mfa ? "Escribe el código de 6 dígitos de tu app de autenticación." : "Accede con tu cuenta institucional.";
    setState("idle");
    if (mfa) { code.value = ""; mfaError.hidden = true; code.focus(); } else { password.focus(); }
  };

  reveal.addEventListener("click", () => {
    const show = password.type === "password";
    password.type = show ? "text" : "password";
    reveal.textContent = show ? "Ocultar" : "Ver";
    reveal.setAttribute("aria-pressed", String(show));
    password.focus();
  });
  for (const field of [email, password]) field.addEventListener("input", () => { errorNode.hidden = true; if (view.dataset.state === "error") setState("idle"); });
  code.addEventListener("input", () => { mfaError.hidden = true; });

  if (new URLSearchParams(window.location.search).has("expired")) {
    errorNode.textContent = "Tu sesión terminó. Vuelve a iniciar sesión."; errorNode.hidden = false;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (view.dataset.state === "verifying" || view.dataset.state === "entering") return;
    errorNode.hidden = true;
    if (!email.value.trim() || !email.checkValidity()) return showError(errorNode, "Escribe un correo electrónico válido.", email);
    if (!password.value) return showError(errorNode, "Escribe tu contraseña.", password);
    const restore = working(submit, "Verificando…");
    setState("verifying", "Comprobando tus credenciales…");
    try {
      const result = await lab().loginAnalyst({ user: email.value.trim(), pass: password.value });
      if (result.ok) { password.value = ""; return enter(submit); }
      password.value = "";
      restore();
      if (result.mfaRequired) return showStep(true);
      throw new Error(result.error);
    } catch (error) {
      restore(); password.value = "";
      showError(errorNode, describeError(error, "No se pudo acceder."), password);
    }
  });

  mfaForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (view.dataset.state === "verifying" || view.dataset.state === "entering") return;
    mfaError.hidden = true;
    if (code.value.replace(/\s/g, "").length < 6) return showError(mfaError, "El código tiene 6 dígitos.", code);
    const restore = working(mfaSubmit, "Verificando…");
    setState("verifying", "Comprobando el código…");
    try {
      const result = await lab().verifyAnalystMfa(code.value);
      if (result.ok) return enter(mfaSubmit);
      throw new Error(result.mfaRequired ? "Vuelve a iniciar sesión." : result.error);
    } catch (error) {
      restore();
      const text = describeError(error, "No se pudo verificar el código.");
      // Si el reto caducó hay que volver a escribir la contraseña.
      if (/Vuelve a iniciar sesión/.test(text)) { showStep(false); showError(errorNode, text, password); return; }
      showError(mfaError, text); code.select();
    }
  });

  mfaCancel.addEventListener("click", async () => {
    // Descarta el reto pendiente en el servidor antes de volver al primer paso.
    const restore = working(mfaCancel, "Volviendo…");
    await lab().logoutAnalyst().catch(() => undefined);
    restore(); showStep(false);
  });

  // Al volver con «Atrás» tras entrar, la página puede restaurarse congelada en «Entrando…».
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    for (const button of [submit, mfaSubmit]) {
      if (button.dataset.label) button.textContent = button.dataset.label;
      button.disabled = false; setBusy(button, false);
    }
    setState("idle");
  });
}
