import { lab } from "../lab";
import { showToast } from "../toast";
import { describeError } from "../errors";

export async function handleLogout(): Promise<void> {
  try { await lab().logoutAnalyst(); window.location.assign("/login"); }
  catch (error) { showToast(error instanceof Error ? error.message : "No se pudo cerrar la sesión."); }
}

export function wireAuth(): void {
  const form = document.getElementById("login-form") as HTMLFormElement | null;
  if (!form) return;
  const mfaForm = document.getElementById("mfa-form") as HTMLFormElement;
  const errorNode = document.getElementById("login-error")!;
  const mfaError = document.getElementById("mfa-error")!;
  const title = document.getElementById("login-title")!;
  const hint = document.getElementById("login-hint")!;
  const links = document.getElementById("login-links")!;
  const code = document.getElementById("mfa-code") as HTMLInputElement;
  const showStep = (mfa: boolean) => {
    form.hidden = mfa; mfaForm.hidden = !mfa; links.hidden = mfa;
    title.textContent = mfa ? "Verificación en dos pasos" : "Bienvenido de nuevo";
    hint.textContent = mfa ? "Escribe el código de 6 dígitos que muestra tu app de autenticación." : "Accede con tu cuenta institucional.";
    if (mfa) { code.value = ""; mfaError.hidden = true; code.focus(); }
  };
  const params = new URLSearchParams(window.location.search);
  if (params.has("expired")) {
    errorNode.textContent = "Tu sesión terminó. Vuelve a iniciar sesión."; errorNode.hidden = false;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.getElementById("login-submit") as HTMLButtonElement;
    const email = document.getElementById("login-user") as HTMLInputElement;
    const password = document.getElementById("login-pass") as HTMLInputElement;
    button.disabled = true; button.textContent = "Verificando…"; errorNode.hidden = true;
    try {
      const result = await lab().loginAnalyst({ user: email.value, pass: password.value });
      password.value = "";
      if (result.ok) { window.location.assign("/app"); return; }
      if (result.mfaRequired) { showStep(true); return; }
      throw new Error(result.error);
    } catch (error) { errorNode.textContent = describeError(error, "No se pudo acceder."); errorNode.hidden = false; }
    finally { password.value = ""; button.disabled = false; button.textContent = "Iniciar sesión"; }
  });
  mfaForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.getElementById("mfa-submit") as HTMLButtonElement;
    button.disabled = true; mfaError.hidden = true;
    try {
      const result = await lab().verifyAnalystMfa(code.value);
      if (result.ok) { window.location.assign("/app"); return; }
      throw new Error(result.mfaRequired ? "Vuelve a iniciar sesión." : result.error);
    } catch (error) {
      const text = describeError(error, "No se pudo verificar el código.");
      // Si el reto caducó hay que volver a escribir la contraseña.
      if (/Vuelve a iniciar sesión/.test(text)) { showStep(false); errorNode.textContent = text; errorNode.hidden = false; return; }
      mfaError.textContent = text; mfaError.hidden = false; code.select();
    } finally { button.disabled = false; }
  });
  document.getElementById("mfa-cancel")!.addEventListener("click", async () => {
    // Descarta el reto pendiente en el servidor antes de volver al primer paso.
    await lab().logoutAnalyst().catch(() => undefined);
    showStep(false);
  });
}
