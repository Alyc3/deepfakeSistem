import type { APIRoute } from "astro";
import { ServiceError } from "@infrastructure/server/identity-service";
import { boundedBody, serviceFailure } from "@infrastructure/server/request";
import { forensicsFetch, MAX_UPLOAD_BYTES } from "@infrastructure/server/forensics-target";

export const ALL: APIRoute = async (context) => {
  const { locals, params, request } = context;
  try {
    if (!locals.permissions.includes("laboratory")) throw new ServiceError(403, "No tienes acceso al laboratorio.");
    const predict = params.operation === "predict" && request.method === "POST";
    const health = params.operation === "health" && request.method === "GET";
    if (!predict && !health) throw new ServiceError(404, "Operación no disponible.");
    const response = await forensicsFetch(context, predict ? "/predict" : "/health/live", {
      method: request.method, timeout: predict ? 240_000 : 5000,
      headers: predict ? { "Content-Type": request.headers.get("content-type") ?? "" } : {},
      body: predict ? (await boundedBody(request, MAX_UPLOAD_BYTES)) as BodyInit : undefined,
    });
    if (response.status >= 500) throw new ServiceError(502, "No se confirmó el análisis o su preservación. Revisa el expediente antes de reintentar.");
    return new Response(response.body, { status: response.status, headers: { "Content-Type": response.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" } });
  } catch (error) { return serviceFailure(error); }
};
