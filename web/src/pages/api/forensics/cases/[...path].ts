import type { APIRoute } from "astro";
import { ServiceError } from "@infrastructure/server/identity-service";
import { boundedBody, jsonBody, serviceFailure } from "@infrastructure/server/request";
import { forensicsFetch, MAX_UPLOAD_BYTES } from "@infrastructure/server/forensics-target";
import { CASE_SCHEMA, RULES, validateFields } from "@domain/validation";

/** Normaliza y valida; si algo falla, responde 400 con el primer motivo (el cliente muestra `detail`). */
function checked(data: Record<string, unknown>, schema: Parameters<typeof validateFields>[1], required: string[]): Record<string, unknown> {
  const { values, errors } = validateFields(data, schema, required);
  if (errors.length) throw new ServiceError(400, errors.join(" · "));
  return values;
}
const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export const ALL: APIRoute = async (context) => {
  const { locals, params, request } = context;
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
    let body = finalize || create ? await jsonBody(request) : undefined;
    if (finalize && body) {
      if (Object.keys(body).some((key) => key !== "expert_conclusions")) throw new ServiceError(400, "Conclusiones inválidas.");
      body = checked(body, { expert_conclusions: RULES.conclusions }, ["expert_conclusions"]);
    }
    if (create && body) {
      if (Object.keys(body).some((key) => !["case_number", "title", "description"].includes(key))) throw new ServiceError(400, "Datos del expediente inválidos.");
      body = checked(body, CASE_SCHEMA, ["case_number", "title"]);
      if (body.description === null) delete body.description;
    }
    const upload = ingest || analyze;
    // Lista de expedientes: solo se reenvían la búsqueda y la página, con tipos y tamaños acotados.
    let query = "";
    if (path === "" && request.method === "GET") {
      const input = context.url.searchParams;
      const params = new URLSearchParams();
      const term = (input.get("q") ?? "").trim();
      if (term.length > 100) throw new ServiceError(400, "La búsqueda admite como máximo 100 caracteres.");
      if (term) params.set("q", term);
      const whole = (key: string, fallback: number, min: number, max: number) => {
        const value = Number(input.get(key) ?? fallback);
        return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
      };
      params.set("offset", String(whole("offset", 0, 0, 100_000)));
      params.set("limit", String(whole("limit", 10, 1, 50)));
      query = `?${params}`;
    }
    const response = await forensicsFetch(context, `/api/v1/cases${path ? `/${path}` : ""}${query}`, {
      method: request.method, timeout: 120_000,
      headers: body ? { "Content-Type": "application/json" } : upload ? { "Content-Type": request.headers.get("content-type") ?? "multipart/form-data" } : {},
      body: body ? JSON.stringify(body) : upload ? (await boundedBody(request, MAX_UPLOAD_BYTES)) as BodyInit : undefined,
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
