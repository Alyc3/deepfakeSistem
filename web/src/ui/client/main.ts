import { el } from "./dom";
import { state } from "./state";
import { lab } from "./lab";
import { wireIdentity } from "./controllers/identity.controller";
import { wireEvidence, setFile } from "./controllers/evidence.controller";
import { wireAnalysis } from "./controllers/analysis.controller";
import { refreshHealth } from "./controllers/engine-status.controller";
import { wireShortcuts } from "./controllers/shortcuts";
import { renderHistory } from "./presenters/history.presenter";
import { emitFinalVerdict } from "./presenters/checklist.presenter";
import { toggleHeatmapZoom } from "./presenters/heatmap.presenter";
import { handleLogout } from "./controllers/auth.controller";
import { wireCases } from "./controllers/cases.controller";
import { wireAccount } from "./controllers/account.controller";
import { wireAudit } from "./controllers/audit.controller";
import { wireEngineConnection } from "./controllers/connection.controller";
import { installActivityBar, setBusy } from "./loading";

export function startLab(): void {
  const shell = document.getElementById("view-app")!;
  const section = shell.dataset.section!;
  installActivityBar();
  document.body.dataset.section = section;
  lab().identity.hydrate(JSON.parse(shell.dataset.user!));
  state.session = lab().sessionStatus();
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
  // En escritorio el botón pliega el sidebar a un carril de iconos; en móvil abre el panel deslizante.
  // La preferencia va en una cookie para que el servidor ya lo pinte plegado (sin salto al cargar).
  const collapsed = () => shell.classList.contains("sidebar-collapsed");
  const syncToggle = () => {
    const open = mobile.matches ? sidebar.classList.contains("is-open") : !collapsed();
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Ocultar navegación" : "Mostrar navegación");
  };
  const setCollapsed = (value: boolean) => {
    shell.classList.toggle("sidebar-collapsed", value);
    document.cookie = `certiface_sidebar=${value ? "collapsed" : "expanded"}; Path=/; Max-Age=31536000; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
    syncToggle();
  };
  const toggleSidebar = () => { if (mobile.matches) { menu(!sidebar.classList.contains("is-open")); syncToggle(); } else setCollapsed(!collapsed()); };
  syncToggle();
  mobile.addEventListener("change", () => { menu(false); sidebar.inert = mobile.matches; syncToggle(); });
  toggle.addEventListener("click", toggleSidebar);
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "b") { event.preventDefault(); toggleSidebar(); }
  });
  backdrop.addEventListener("click", () => { menu(false); syncToggle(); });
  document.addEventListener("keydown", (event) => {
    if (!sidebar.classList.contains("is-open")) return;
    if (event.key === "Escape") { menu(false); syncToggle(); return; }
    if (event.key === "Tab") {
      const links = [...sidebar.querySelectorAll<HTMLElement>("a,button")];
      if (event.shiftKey && document.activeElement === links[0]) { event.preventDefault(); links.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === links.at(-1)) { event.preventDefault(); links[0]?.focus(); }
    }
  });
  // Panel oculto del motor forense (Ctrl+Alt+Shift+M); solo existe si el servidor lo habilita.
  wireEngineConnection(() => { if (section === "laboratorio") void refreshHealth(); });
  if (section === "usuarios" || section === "roles") wireIdentity();
  if (section === "casos") wireCases();
  if (section === "perfil" || section === "seguridad") wireAccount(section);
  if (section === "auditoria") wireAudit(JSON.parse(shell.dataset.permissions ?? "[]").includes("users"));
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
    // El enlace vive dentro de la tarjeta de contraseña y apunta a este formulario con el atributo form.
    const button = document.querySelector<HTMLButtonElement>('[form="account-recovery-form"]') ?? form.querySelector("button")!;
    const message = document.getElementById("account-recovery-message")!;
    button.disabled = true; setBusy(button, true);
    try {
      message.textContent = await lab().identity.recoverPassword(lab().identity.current()!.email);
    } catch (error) { message.textContent = error instanceof Error ? error.message : "No se pudo enviar el enlace. Intenta de nuevo."; }
    finally { button.disabled = false; setBusy(button, false); }
  });
}
