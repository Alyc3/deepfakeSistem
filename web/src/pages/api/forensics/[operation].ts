import type { APIRoute } from "astro";
import { serverConfig } from "@infrastructure/server/config";
import { ServiceError } from "@infrastructure/server/identity-service";
import { boundedBody, serviceFailure } from "@infrastructure/server/request";

export const ALL: APIRoute = async ({ locals, params, request }) => {
  try {
    if (!locals.permissions.includes("laboratory")) throw new ServiceError(403, "No tienes acceso al laboratorio.");
    const predict = params.operation === "predict" && request.method === "POST";
    const health = params.operation === "health" && request.method === "GET";
    if (!predict && !health) throw new ServiceError(404, "Operación no disponible.");
    const response = await fetch(`${serverConfig().apiUrl}${predict ? "/predict" : "/health/live"}`, {
      method: request.method, redirect: "error", cache: "no-store",
      headers: { Authorization: `Bearer ${locals.accessToken}`, ...(predict ? { "Content-Type": request.headers.get("content-type") ?? "" } : {}) },
      body: predict ? (await boundedBody(request, 11 * 1024 * 1024)) as BodyInit : undefined,
      signal: AbortSignal.timeout(predict ? 240_000 : 5000),
    });
    if (response.status >= 500) throw new ServiceError(502, "No se confirmó el análisis o su preservación. Revisa el expediente antes de reintentar.");
    return new Response(response.body, { status: response.status, headers: { "Content-Type": response.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" } });
  } catch (error) { return serviceFailure(error); }
};
