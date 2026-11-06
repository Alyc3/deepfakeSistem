import { isIP } from "node:net";
import type { ClientContext } from "./identity-service";
import { serverConfig } from "./config";

/**
 * IP y navegador del usuario final.
 * X-Forwarded-For solo se usa con TRUSTED_PROXY_COUNT y se lee desde la derecha:
 * los valores de la izquierda los controla el cliente.
 */
export function clientContext(request: Request, clientAddress: () => string): ClientContext {
  const hops = serverConfig().trustedProxyCount;
  let ip: string | undefined;
  if (hops > 0) {
    const chain = (request.headers.get("x-forwarded-for") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    if (chain.length >= hops) ip = chain[chain.length - hops];
  }
  if (!ip) { try { ip = clientAddress(); } catch { ip = undefined; } }
  if (ip?.startsWith("::ffff:")) ip = ip.slice(7);
  return {
    ip: ip && isIP(ip) ? ip : undefined,
    userAgent: request.headers.get("user-agent")?.slice(0, 255) || undefined,
  };
}
