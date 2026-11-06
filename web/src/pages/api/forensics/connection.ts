import type { APIContext, APIRoute } from "astro";
import { serverConfig } from "@infrastructure/server/config";
import { ServiceError } from "@infrastructure/server/identity-service";
import { jsonBody, serviceFailure } from "@infrastructure/server/request";
import { probeEngine, validateOverride } from "@infrastructure/server/forensics-target";

/**
 * Motor forense de la sesión, elegido desde el panel oculto (Ctrl+Alt+Shift+M).
 * Solo existe con FORENSICS_API_OVERRIDE=true y para roles con acceso al laboratorio.
 * La URL de CERTIFACE_API_URL nunca se envía al navegador.
 */
function allowed(context: APIContext): void {
  if (!serverConfig().forensicsOverride.enabled) throw new ServiceError(404, "Operación no disponible.");
  if (!context.locals.permissions.includes("laboratory")) throw new ServiceError(403, "No tienes acceso al laboratorio.");
}
async function state(context: APIContext) {
  const override = await context.session?.get("forensicsApiUrl");
  return { source: override ? "session" : serverConfig().apiUrl ? "server" : "none", url: override ?? null };
}
const json = (data: unknown) => Response.json(data, { headers: { "Cache-Control": "no-store" } });

export const GET: APIRoute = async (context) => {
  try { allowed(context); return json(await state(context)); }
  catch (error) { return serviceFailure(error); }
};
export const PUT: APIRoute = async (context) => {
  try {
    allowed(context);
    const { url } = await jsonBody(context.request);
    if (typeof url !== "string" || !url.trim() || url.length > 300) throw new ServiceError(400, "Escribe la URL del motor.");
    const target = await validateOverride(url);
    await probeEngine(target);
    context.session!.set("forensicsApiUrl", target);
    return json(await state(context));
  } catch (error) { return serviceFailure(error); }
};
export const DELETE: APIRoute = async (context) => {
  try {
    allowed(context);
    context.session?.delete("forensicsApiUrl");
    return json(await state(context));
  } catch (error) { return serviceFailure(error); }
};
