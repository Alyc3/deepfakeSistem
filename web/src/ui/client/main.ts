import { el } from "./dom";
import { state } from "./state";
import { lab } from "./lab";
import { wireIdentity } from "./controllers/identity.controller";
import { wireEvidence, setFile } from "./controllers/evidence.controller";
import { wireAnalysis } from "./controllers/analysis.controller";
import { refreshHealth } from "./controllers/settings.controller";
import { wireShortcuts } from "./controllers/shortcuts";
import { renderHistory } from "./presenters/history.presenter";
import { emitFinalVerdict } from "./presenters/checklist.presenter";
import { toggleHeatmapZoom } from "./presenters/heatmap.presenter";
import { handleLogout } from "./controllers/auth.controller";

export function startLab(): void {
  const shell = document.getElementById("view-app")!;
  const section = shell.dataset.section!;
  document.body.dataset.section = section;
  lab().identity.hydrate(JSON.parse(shell.dataset.user!));
  state.session = lab().sessionStatus();
  state.settings = { apiUrl: "/api/forensics" };
  document.getElementById("logout")?.addEventListener("click", () => void handleLogout());
  document.getElementById("security-logout")?.addEventListener("click", () => void handleLogout());
  window.addEventListener("certiface:session-expired", () => window.location.assign("/login?expired=1"));
  const sidebar = document.getElementById("app-sidebar")!;
  const toggle = document.getElementById("sidebar-toggle")!;
  const backdrop = document.getElementById("sidebar-backdrop")!;
  const appMain = document.querySelector<HTMLElement>(".app-main")!;
  const mobile = window.matchMedia("(max-width: 850px)");
  const menu = (open: boolean) => {
    sidebar.classList.toggle("is-open", open); backdrop.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("nav-open", open);
    sidebar.inert = mobile.matches && !open; appMain.inert = mobile.matches && open;
    if (open) sidebar.querySelector<HTMLElement>("a")?.focus(); else toggle.focus();
  };
  sidebar.inert = mobile.matches;
  mobile.addEventListener("change", () => { menu(false); sidebar.inert = mobile.matches; });
  toggle.addEventListener("click", () => menu(!sidebar.classList.contains("is-open")));
  backdrop.addEventListener("click", () => menu(false));
  document.addEventListener("keydown", (event) => {
    if (!sidebar.classList.contains("is-open")) return;
    if (event.key === "Escape") { menu(false); return; }
    if (event.key === "Tab") {
      const links = [...sidebar.querySelectorAll<HTMLElement>("a,button")];
      if (event.shiftKey && document.activeElement === links[0]) { event.preventDefault(); links.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === links.at(-1)) { event.preventDefault(); links[0]?.focus(); }
    }
  });
  if (section === "usuarios" || section === "roles") wireIdentity();
  if (section === "laboratorio") {
    state.history = lab().listCases(); renderHistory(); setFile(null);
    wireEvidence(); wireAnalysis(); wireShortcuts();
    el.checklistSubmit.addEventListener("click", emitFinalVerdict);
    el.heatmapFigure.addEventListener("click", () => toggleHeatmapZoom());
    el.historyClear.addEventListener("click", () => { state.history = lab().clearCases(); renderHistory(); });
    el.statusText.addEventListener("click", () => void refreshHealth());
    void refreshHealth();
  }
  document.getElementById("account-recovery-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const button = form.querySelector("button")!;
    const message = document.getElementById("account-recovery-message")!;
    button.disabled = true;
    try {
      message.textContent = await lab().identity.recoverPassword(lab().identity.current()!.email);
    } catch (error) { message.textContent = error instanceof Error ? error.message : "No se pudo enviar el enlace. Intenta de nuevo."; }
    finally { button.disabled = false; }
  });
}
