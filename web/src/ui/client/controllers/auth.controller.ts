import { lab } from "../lab";
import { showToast } from "../toast";
export async function handleLogout(): Promise<void> {
  try { await lab().logoutAnalyst(); window.location.assign("/login"); }
  catch (error) { showToast(error instanceof Error ? error.message : "No se pudo cerrar la sesión."); }
}
export function goToLogin(): void { window.location.assign("/login"); }
export function wireAuth(): void {
  const form = document.getElementById("login-form") as HTMLFormElement | null;
  if (!form) return;
  const errorNode = document.getElementById("login-error")!;
  if (new URLSearchParams(window.location.search).has("expired")) {
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
      if (!result.ok) throw new Error(result.error);
      window.location.assign("/app");
    } catch (error) { errorNode.textContent = error instanceof Error ? error.message : "No se pudo acceder."; errorNode.hidden = false; }
    finally { password.value = ""; button.disabled = false; button.textContent = "Iniciar sesión"; }
  });
}
