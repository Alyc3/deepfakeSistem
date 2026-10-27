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
    const listing = path === "" || new RegExp(`^${uuid}/(?:artifacts|evidences|custody-log)$`).test(path);
    const finalize = new RegExp(`^${uuid}/reports/${uuid}/finalize$`).test(path);
    if (!((request.method === "GET" && (download || listing)) || (request.method === "POST" && finalize))) throw new ServiceError(404, "Operación no disponible.");
    const body = finalize ? await jsonBody(request) : undefined;
    if (body && (Object.keys(body).some((key) => key !== "expert_conclusions") || typeof body.expert_conclusions !== "string")) throw new ServiceError(400, "Conclusiones inválidas.");
    const response = await fetch(`${serverConfig().apiUrl}/api/v1/cases${path ? `/${path}` : ""}`, {
      method: request.method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${locals.accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status >= 500) throw new ServiceError(502, "No se pudo verificar el archivo forense. Intenta más tarde.");
    const headers = new Headers({ "Content-Type": response.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store, private", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff" });
    for (const name of ["Content-Disposition", "X-Content-SHA256"]) if (response.headers.has(name)) headers.set(name, response.headers.get(name)!);
    if (download) headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
    return new Response(response.body, { status: response.status, headers });
  } catch (error) { return serviceFailure(error); }
};
