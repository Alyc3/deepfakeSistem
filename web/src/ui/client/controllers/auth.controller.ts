/**
 * Interfaz — Acceso del perito.
 *
 * Un solo perfil por navegador: el primer uso registra la credencial y las
 * siguientes visitas la piden. La clave nunca se guarda en claro.
 */
import { el } from "../dom";
import { state } from "../state";
import { lab } from "../lab";
import { showView } from "../view-router";
import { resetAll } from "./evidence.controller";
import { refreshHealth } from "./settings.controller";

function prepareLoginView(): void {
  const firstRun = !state.session.registered;
  el.loginTitle.textContent = firstRun
    ? "Registro del perito"
    : "Identificación del perito";
  el.loginHint.textContent = firstRun
    ? "Primer uso: define tu credencial y una clave de al menos 6 caracteres. Quedan registradas solo en este equipo."
    : "Introduce tu credencial para acceder al laboratorio.";
  el.loginSubmit.textContent = firstRun
    ? "Registrar y acceder"
    : "Acceder al laboratorio";
  el.loginError.hidden = true;
  el.loginPass.value = "";
  if (state.session.analyst) el.loginUser.value = state.session.analyst;
}

export function enterLab(): void {
  el.analystName.textContent = state.session.analyst ?? "";
  showView("app");
  void refreshHealth();
}

export function goToLogin(): void {
  // Con sesión ya abierta no se vuelve a pedir la clave.
  if (state.session.loggedIn) {
    enterLab();
    return;
  }
  prepareLoginView();
  showView("login");
  (el.loginUser.value ? el.loginPass : el.loginUser).focus();
}

async function handleLoginSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const credentials = {
    user: el.loginUser.value.trim(),
    pass: el.loginPass.value,
  };

  el.loginSubmit.disabled = true;
  const outcome = state.session.registered
    ? await lab().loginAnalyst(credentials)
    : await lab().registerAnalyst(credentials);
  el.loginSubmit.disabled = false;

  if (!outcome.ok) {
    el.loginError.textContent = outcome.error;
    el.loginError.hidden = false;
    el.loginPass.value = "";
    el.loginPass.focus();
    return;
  }

  state.session = { registered: true, loggedIn: true, analyst: outcome.analyst };
  enterLab();
}

export function handleLogout(): void {
  lab().logoutAnalyst();
  state.session = { ...state.session, loggedIn: false };
  resetAll();
  showView("landing");
}

export function loadSession(): void {
  state.session = lab().sessionStatus();
}

export function wireAuth(): void {
  el.landingEnter.addEventListener("click", goToLogin);
  el.landingEnterTop.addEventListener("click", goToLogin);
  el.landingProtocol.addEventListener("click", () => {
    el.protocol.scrollIntoView({ behavior: "smooth" });
  });

  el.loginForm.addEventListener("submit", (event) => void handleLoginSubmit(event));
  el.loginBack.addEventListener("click", () => showView("landing"));
  el.logout.addEventListener("click", handleLogout);
}
