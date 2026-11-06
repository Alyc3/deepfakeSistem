import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { APIContext } from "astro";
import { parseServiceUrl, serverConfig } from "./config";
import { ServiceError } from "./identity-service";

/** Tamaño máximo de una evidencia en tránsito (el backend acepta 10 MB más el formulario). */
export const MAX_UPLOAD_BYTES = 11 * 1024 * 1024;

function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return ip === "::" || ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80");
}
const matches = (host: string, pattern: string) =>
  pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern;

/**
 * Valida la URL de un motor elegido desde el panel oculto. En producción exige HTTPS, un dominio de la
 * lista FORENSICS_API_OVERRIDE_HOSTS y que no resuelva a la red interna: este servidor reenvía ahí el
 * token del usuario, así que no puede convertirse en un proxy hacia cualquier destino.
 */
export async function validateOverride(raw: string): Promise<string> {
  let url: string;
  try { url = parseServiceUrl(raw.trim(), "La URL del motor"); }
  catch (error) { throw new ServiceError(400, error instanceof Error ? error.message : "URL inválida."); }
  if (!import.meta.env.PROD) return url;
  const { hostname, protocol } = new URL(url);
  const host = hostname.toLowerCase();
  if (protocol !== "https:") throw new ServiceError(400, "En producción el motor debe usar HTTPS.");
  if (isIP(host.replace(/^\[|\]$/g, ""))) throw new ServiceError(400, "Usa un dominio, no una IP.");
  const { hosts } = serverConfig().forensicsOverride;
  if (!hosts.some((pattern) => matches(host, pattern))) throw new ServiceError(400, `Dominio no permitido. Permitidos: ${hosts.join(", ")}.`);
  const addresses = await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new ServiceError(400, "No se pudo resolver el dominio del motor.");
  if (addresses.some(({ address }) => isPrivateAddress(address))) throw new ServiceError(400, "El dominio apunta a una red interna.");
  return url;
}

/** Motor forense de la sesión: el elegido en el panel oculto o CERTIFACE_API_URL. */
export async function forensicsBaseUrl(context: APIContext): Promise<string> {
  const config = serverConfig();
  const override = config.forensicsOverride.enabled ? await context.session?.get("forensicsApiUrl") : undefined;
  const base = override || config.apiUrl;
  if (!base) throw new ServiceError(503, "El motor forense no está conectado.");
  return base;
}

/** Llama al motor forense con el token del usuario. Los fallos de red se traducen a 503. */
export async function forensicsFetch(context: APIContext, path: string, init: RequestInit & { timeout: number }): Promise<Response> {
  const base = await forensicsBaseUrl(context);
  const { timeout, headers, ...rest } = init;
  try {
    return await fetch(`${base}${path}`, {
      ...rest, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeout),
      headers: { ...(headers as Record<string, string> | undefined), Authorization: `Bearer ${context.locals.accessToken}` },
    });
  } catch { throw new ServiceError(503, "No se pudo conectar con el motor forense."); }
}

/** Comprueba que la URL responde como el motor de CertiFace antes de guardarla. */
export async function probeEngine(url: string): Promise<void> {
  let response: Response;
  try { response = await fetch(`${url}/health/live`, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000) }); }
  catch { throw new ServiceError(502, "El motor no respondió. Revisa que esté encendido y que la URL sea accesible desde el servidor."); }
  const body = await response.json().catch(() => null) as { status?: unknown } | null;
  if (!response.ok || body?.status !== "ok") throw new ServiceError(502, "La URL respondió, pero no parece el motor forense de CertiFace.");
}
