import type { APIRoute } from "astro";
import { serverConfig } from "@infrastructure/server/config";
import { ServiceError } from "@infrastructure/server/identity-service";
import { jsonBody, serviceFailure } from "@infrastructure/server/request";

const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export const ALL: APIRoute = async ({ locals, params, request }) => {
  try {
    if (!locals.permissions.includes("laboratory")) throw new ServiceError(403, "No tienes acceso al archivo forense.");
    const path = params.path ?? "";
    const download = new RegExp(`^${uuid}/artifacts/${uuid}/download$`).test(path);
    const listing = path === "" || new RegExp(`^${uuid}/(?:artifacts|evidences|custody-log|summary)$`).test(path);
    const finalize = new RegExp(`^${uuid}/reports/${uuid}/finalize$`).test(path);
    const create = path === "" && request.method === "POST";
    const ingest = new RegExp(`^${uuid}/ingest$`).test(path) && request.method === "POST";
    const analyze = new RegExp(`^${uuid}/analyze-async$`).test(path) && request.method === "POST";
    if (!((request.method === "GET" && (download || listing)) || (request.method === "POST" && (finalize || create || ingest || analyze)))) throw new ServiceError(404, "Operación no disponible.");
    const body = finalize || create ? await jsonBody(request) : undefined;
    if (finalize && body && (Object.keys(body).some((key) => key !== "expert_conclusions") || typeof body.expert_conclusions !== "string")) throw new ServiceError(400, "Conclusiones inválidas.");
    if (create && body && (Object.keys(body).some((key) => !["case_number", "title", "description"].includes(key)) || typeof body.case_number !== "string" || typeof body.title !== "string" || (body.description !== undefined && typeof body.description !== "string"))) throw new ServiceError(400, "Datos del expediente inválidos.");
    const response = await fetch(`${serverConfig().apiUrl}/api/v1/cases${path ? `/${path}` : ""}`, {
      method: request.method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${locals.accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}), ...(ingest || analyze ? { "Content-Type": request.headers.get("content-type") ?? "multipart/form-data" } : {}) },
      body: body ? JSON.stringify(body) : (ingest || analyze) ? await request.arrayBuffer() : undefined,
    });
    if (response.status >= 500) {
      if (response.status === 503) {
        const failure = await response.json().catch(() => ({}));
        throw new ServiceError(503, typeof failure.detail === "string" ? failure.detail : "El almacén forense no está disponible.");
      }
      throw new ServiceError(502, "No se pudo verificar el archivo forense. Intenta más tarde.");
    }
    const headers = new Headers({ "Content-Type": response.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store, private", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff" });
    for (const name of ["Content-Disposition", "X-Content-SHA256"]) if (response.headers.has(name)) headers.set(name, response.headers.get(name)!);
    if (download) headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
    return new Response(response.body, { status: response.status, headers });
  } catch (error) { return serviceFailure(error); }
};
