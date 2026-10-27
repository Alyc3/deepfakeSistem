/** Adaptador de la API del laboratorio; nunca recibe credenciales del almacén. */
import type { AnalysisResult, ArchiveReceipt } from "@domain/analysis";
import type { ForensicsApiPort, AnalysisOutcome, BackendStatus } from "@application/ports/forensics-api.port";
import { normalizeBaseUrl } from "@domain/settings";
export type BaseUrlProvider = () => string;
async function failure(response: Response): Promise<string> {
  if (response.status === 401) window.dispatchEvent(new Event("certiface:session-expired"));
  const body = await response.json().catch(() => ({}));
  return typeof body.detail === "string" ? body.detail : "No se pudo completar la operación.";
}
export function createHttpForensicsApi(baseUrl: BaseUrlProvider, authenticated: () => boolean): ForensicsApiPort {
  const endpoint = () => normalizeBaseUrl(baseUrl());
  return {
    async status(): Promise<BackendStatus> {
      const base = endpoint();
      try {
        const response = await fetch(`${base}/health`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(5000) });
        return { online: response.ok && (await response.json()).status === "ok", endpoint: base };
      } catch { return { online: false, endpoint: base }; }
    },
    async analyze(file): Promise<AnalysisOutcome> {
      if (!authenticated()) return { ok: false, error: "Debes iniciar sesión." };
      const body = new FormData(); body.append("file", new Blob([file.blob], { type: file.mime }), file.name);
      try {
        if (file.expectedSha256) {
          body.append("expected_sha256", file.expectedSha256);
        } else if (globalThis.crypto?.subtle) {
          const digest = await crypto.subtle.digest("SHA-256", await file.blob.arrayBuffer());
          body.append("expected_sha256", [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""));
        }
        const response = await fetch(`${endpoint()}/predict`, { method: "POST", credentials: "same-origin", body, signal: AbortSignal.timeout(240_000) });
        if (!response.ok) return { ok: false, error: await failure(response) };
        return { ok: true, result: await response.json() as AnalysisResult };
      } catch { return { ok: false, error: "El análisis no se confirmó. Revisa el expediente antes de reintentar." }; }
    },
    async finalizeReport(archive: ArchiveReceipt, conclusions: string) {
      try {
        const response = await fetch(`${endpoint()}/cases/${encodeURIComponent(archive.case_id)}/reports/${encodeURIComponent(archive.report_id!)}/finalize`, {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expert_conclusions: conclusions }), signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) return { ok: false as const, error: await failure(response) };
        return { ok: true as const, archive: await response.json() as ArchiveReceipt };
      } catch { return { ok: false as const, error: "No se confirmó la revisión del reporte." }; }
    },
  };
}
