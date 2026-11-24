import type { APIContext } from "astro";
import { serverConfig } from "./config";
import { ServiceError } from "./identity-service";

/** Tamaño máximo de una evidencia en tránsito (el backend acepta 10 MB más el formulario). */
export const MAX_UPLOAD_BYTES = 11 * 1024 * 1024;

/**
 * Llama al motor forense de CERTIFACE_API_URL con el token del usuario. Solo este servidor conoce la URL
 * y el token; el navegador nunca los ve. Los fallos de red se traducen a 503.
 */
export async function forensicsFetch(context: APIContext, path: string, init: RequestInit & { timeout: number }): Promise<Response> {
  const { timeout, headers, ...rest } = init;
  try {
    return await fetch(`${serverConfig().apiUrl}${path}`, {
      ...rest, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeout),
      headers: { ...(headers as Record<string, string> | undefined), Authorization: `Bearer ${context.locals.accessToken}` },
    });
  } catch { throw new ServiceError(503, "No se pudo conectar con el motor forense."); }
}
