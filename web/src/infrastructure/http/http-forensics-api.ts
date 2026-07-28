/**
 * Adaptador de salida — API pericial sobre HTTP (`fetch`).
 *
 * Es el único archivo del frontend que sabe que el backend habla HTTP y que
 * el material viaja como `multipart/form-data`. El backend permite CORS
 * abierto (backend/app/main.py), así que la petición sale directamente del
 * navegador del perito: el material no pasa por ningún intermediario.
 */
import type { AnalysisResult } from "@domain/analysis";
import type { EvidenceFile } from "@domain/evidence";
import { normalizeBaseUrl } from "@domain/settings";
import type {
  AnalysisOutcome,
  BackendStatus,
  ForensicsApiPort,
} from "@application/ports/forensics-api.port";

/** El análisis de video con cuatro peritos puede tardar minutos en CPU. */
const PREDICT_TIMEOUT_MS = 180_000;
const HEALTH_TIMEOUT_MS = 5_000;

/** Proveedor de la URL base: se relee en cada llamada por si el perito la cambió. */
export type BaseUrlProvider = () => string;

export function createHttpForensicsApi(
  baseUrl: BaseUrlProvider,
): ForensicsApiPort {
  const endpoint = () => normalizeBaseUrl(baseUrl());

  return {
    /**
     * Comprueba el endpoint de salud del backend (GET /).
     * Un despliegue remoto puede estar dormido por inactividad, así que un
     * tiempo de espera agotado no significa siempre que esté caído.
     */
    async status(): Promise<BackendStatus> {
      const base = endpoint();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      try {
        const response = await fetch(`${base}/`, { signal: controller.signal });
        if (!response.ok) {
          return { online: false, endpoint: base, error: `HTTP ${response.status}` };
        }
        const data = await response.json();
        return { online: data?.status === "ok", endpoint: base };
      } catch (err) {
        const error = err as Error;
        return {
          online: false,
          endpoint: base,
          error: error.name === "AbortError" ? "timeout" : error.message,
        };
      } finally {
        clearTimeout(timer);
      }
    },

    /** Envía el material a POST /predict y devuelve el dictamen. */
    async analyze(file: EvidenceFile): Promise<AnalysisOutcome> {
      const base = endpoint();
      console.log(
        `[CertiFace] Enviando ${file.kind} "${file.name}" ` +
          `(${file.mime}, ${(file.size / 1024).toFixed(0)} KB) a ${base}/predict`,
      );

      // El nombre y el tipo se fijan a mano: el navegador deja `type` vacío en
      // varios contenedores de video y el backend elige la ruta de análisis
      // justamente por ese campo.
      const form = new FormData();
      form.append("file", new Blob([file.blob], { type: file.mime }), file.name);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PREDICT_TIMEOUT_MS);
      const started = performance.now();

      try {
        const response = await fetch(`${base}/predict`, {
          method: "POST",
          body: form,
          signal: controller.signal,
        });

        const elapsed = ((performance.now() - started) / 1000).toFixed(1);

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          console.error(`[CertiFace] HTTP ${response.status} en ${elapsed}s: ${body}`);
          // Los errores 4xx del backend traen un "detail" con la causa concreta.
          let detail = "";
          try {
            detail = JSON.parse(body)?.detail ?? "";
          } catch {
            /* cuerpo no JSON: se usa el mensaje genérico */
          }
          return {
            ok: false,
            error:
              detail ||
              `El servidor devolvió un error (HTTP ${response.status}). Intenta de nuevo.`,
          };
        }

        const result = (await response.json()) as AnalysisResult;
        console.log(`[CertiFace] Respuesta en ${elapsed}s:`, result);
        return { ok: true, result };
      } catch (err) {
        const error = err as Error;
        if (error.name === "AbortError") {
          console.error(
            `[CertiFace] Análisis cancelado por tiempo (${PREDICT_TIMEOUT_MS / 1000}s)`,
          );
          return { ok: false, error: "El análisis tardó demasiado y se canceló." };
        }
        console.error(`[CertiFace] Fallo de conexión: ${error.message}`);
        return {
          ok: false,
          error: `No se pudo conectar con el backend en ${base}. ¿Está en marcha?`,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
