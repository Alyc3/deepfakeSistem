/**
 * Trazas de diagnóstico de la interfaz. No registra valores de formularios,
 * contenido de archivos, cabeceras de autenticación ni cuerpos HTTP.
 */
export function installDiagnostics(): void {
  const diagnosticWindow = window as Window & { __certifaceDiagnosticsInstalled?: boolean };
  if (diagnosticWindow.__certifaceDiagnosticsInstalled) return;
  diagnosticWindow.__certifaceDiagnosticsInstalled = true;

  const label = (element: Element): string => {
    const control = element.closest<HTMLElement>("button, a, label[for], [role='button'], input[type='submit'], input[type='file']");
    if (!control) return "control";
    const text = control.getAttribute("aria-label") || control.getAttribute("title") || control.innerText || control.textContent || control.id || control.tagName;
    return text.replace(/\s+/g, " ").trim().slice(0, 100) || control.tagName.toLowerCase();
  };

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button, a, label[for], [role='button'], input[type='submit'], input[type='file']")) {
      console.info("[CertiFace UI] Acción", { control: label(target), section: document.body.dataset.section || "public" });
    }
  }, true);

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (form instanceof HTMLFormElement) {
      console.info("[CertiFace UI] Formulario enviado", { form: form.id || "sin-id", section: document.body.dataset.section || "public" });
    }
  }, true);

  window.addEventListener("error", (event) => {
    console.error("[CertiFace UI] Error de ejecución", { message: event.message, source: event.filename, line: event.lineno, column: event.colno });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    console.error("[CertiFace UI] Promesa rechazada sin gestionar", reason instanceof Error ? reason.message : String(reason));
  });

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    let path = requestUrl;
    try {
      const parsed = new URL(requestUrl, window.location.href);
      path = `${parsed.origin === window.location.origin ? "" : parsed.origin}${parsed.pathname}`;
    } catch { /* Conserva la URL tal como llegó para que el fallo sea visible. */ }
    const started = performance.now();
    try {
      const response = await originalFetch(input, init);
      const details = { method, path, status: response.status, duration_ms: Math.round(performance.now() - started) };
      if (response.ok) console.info("[CertiFace UI] Solicitud completada", details);
      else console.warn("[CertiFace UI] Solicitud rechazada", details);
      return response;
    } catch (error) {
      console.error("[CertiFace UI] Error de red", { method, path, duration_ms: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
}
