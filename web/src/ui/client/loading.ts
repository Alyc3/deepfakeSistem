/**
 * Indicadores de actividad, discretos y uniformes en toda la interfaz:
 * - una línea naranja fina en el borde superior mientras el sistema trabaja;
 * - botones y textos «ocupados» con un pequeño indicador giratorio;
 * - esqueletos de carga en las listas en lugar de mensajes de texto.
 */

let active = 0;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let bar: HTMLElement | null = null;

/** Las consultas periódicas (estado de un análisis) tienen su propio progreso: no encienden la barra. */
const QUIET = [/^\/api\/forensics\/jobs\//];

function trackable(input: RequestInfo | URL): boolean {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, window.location.origin);
  return url.origin === window.location.origin && url.pathname.startsWith("/api/") && !QUIET.some((pattern) => pattern.test(url.pathname));
}

function update(): void {
  if (!bar) return;
  if (active > 0) {
    // Un retardo mínimo evita destellos en respuestas instantáneas.
    showTimer ??= setTimeout(() => { bar!.classList.add("is-active"); document.body.setAttribute("aria-busy", "true"); }, 120);
  } else {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    bar.classList.remove("is-active");
    document.body.removeAttribute("aria-busy");
  }
}

/** Instala la barra de actividad y la conecta a todas las peticiones a la API del propio sitio. */
export function installActivityBar(): void {
  if (bar) return;
  bar = document.createElement("div");
  bar.className = "activity-bar";
  bar.setAttribute("aria-hidden", "true");
  document.body.prepend(bar);
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const tracked = trackable(input);
    if (tracked) { active++; update(); }
    try { return await original(input, init); }
    finally { if (tracked) { active--; update(); } }
  };
}

/** Marca un elemento como ocupado (indicador giratorio) sin tocar su estado habilitado. */
export function setBusy(element: HTMLElement | null, on: boolean): void {
  if (!element) return;
  element.classList.toggle("is-busy", on);
  if (on) element.setAttribute("aria-busy", "true"); else element.removeAttribute("aria-busy");
}

/**
 * Ejecuta una acción con el botón ocupado: deshabilitado, con indicador y, si se indica,
 * con un texto que describe lo que ocurre («Creando…»). Al terminar se restaura.
 */
export async function busy<T>(button: HTMLButtonElement | null, run: () => Promise<T>, label?: string): Promise<T> {
  if (!button) return run();
  const text = button.textContent;
  button.disabled = true;
  setBusy(button, true);
  if (label) button.textContent = label;
  try { return await run(); }
  finally {
    button.disabled = false;
    setBusy(button, false);
    if (label) button.textContent = text;
  }
}

type Shape = "card" | "row" | "tile";

/** Rellena un contenedor con marcadores de carga animados. `columns` aplica a filas de tabla. */
export function skeleton(container: HTMLElement, count: number, shape: Shape, columns = 4): void {
  const items = Array.from({ length: count }, () => {
    if (shape === "row") {
      const tr = document.createElement("tr"); tr.className = "skeleton-row";
      for (let i = 0; i < columns; i++) {
        const td = document.createElement("td"); const line = document.createElement("span");
        line.className = "skeleton-line"; line.style.width = `${45 + ((i * 23) % 45)}%`; td.append(line); tr.append(td);
      }
      return tr;
    }
    const block = document.createElement(shape === "tile" ? "article" : "div");
    block.className = shape === "tile" ? "surface role-card skeleton-block" : "case-card skeleton-block";
    for (const width of shape === "tile" ? ["30%", "70%", "90%"] : ["55%", "30%"]) {
      const line = document.createElement("span"); line.className = "skeleton-line"; line.style.width = width; block.append(line);
    }
    return block;
  });
  container.setAttribute("aria-busy", "true");
  container.replaceChildren(...items);
}

/** Quita la marca de carga de un contenedor (sus hijos se reemplazan por el contenido real). */
export function loaded(container: HTMLElement): void {
  container.removeAttribute("aria-busy");
}

/** Vuelve a cargar cuando la pestaña recupera el foco: los datos se mantienen al día sin botón «Actualizar». */
export function refreshOnReturn(run: () => void, minimumGapMs = 15_000): void {
  let last = Date.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || Date.now() - last < minimumGapMs) return;
    last = Date.now();
    run();
  });
}
