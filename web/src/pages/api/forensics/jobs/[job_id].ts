import type { APIRoute } from "astro";
import { ServiceError } from "@infrastructure/server/identity-service";
import { serviceFailure } from "@infrastructure/server/request";
import { forensicsFetch } from "@infrastructure/server/forensics-target";

const UUID = /^[0-9a-fA-F-]{36}$/;

export const GET: APIRoute = async (context) => {
  const { locals, params } = context;
  try {
    if (!locals.permissions.includes("laboratory")) throw new ServiceError(403, "No tienes acceso al laboratorio.");
    const jobId = params.job_id ?? "";
    if (!UUID.test(jobId)) throw new ServiceError(400, "Trabajo inválido.");
    const response = await forensicsFetch(context, `/api/v1/jobs/${jobId}`, { method: "GET", timeout: 10_000 });
    if (response.status >= 500) throw new ServiceError(502, "No se pudo consultar el análisis.");
    return new Response(response.body, { status: response.status,
      headers: { "Content-Type": response.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" } });
  } catch (error) { return serviceFailure(error); }
};
