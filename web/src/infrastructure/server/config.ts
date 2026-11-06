import type { AccessPolicy, Permission } from "@domain/access";

const buildEnvironment: Record<string, string | undefined> = {
  AUTH_SERVICE_URL: import.meta.env.AUTH_SERVICE_URL,
  AUTH_INTERNAL_API_KEY: import.meta.env.AUTH_INTERNAL_API_KEY,
  CERTIFACE_API_URL: import.meta.env.CERTIFACE_API_URL,
  FORENSICS_API_OVERRIDE: import.meta.env.FORENSICS_API_OVERRIDE,
  FORENSICS_API_OVERRIDE_HOSTS: import.meta.env.FORENSICS_API_OVERRIDE_HOSTS,
  APP_ORIGIN: import.meta.env.APP_ORIGIN,
  ROLE_PERMISSIONS: import.meta.env.ROLE_PERMISSIONS,
  DEFAULT_PERMISSIONS: import.meta.env.DEFAULT_PERMISSIONS,
  SESSION_TTL_SECONDS: import.meta.env.SESSION_TTL_SECONDS,
  TRUSTED_PROXY_COUNT: import.meta.env.TRUSTED_PROXY_COUNT,
};
/** Valor de entorno sin espacios ni comillas envolventes (algunos paneles, como el de Render, las conservan). */
function env(key: string): string {
  const value = (process.env[key] ?? buildEnvironment[key] ?? "").trim();
  return value.length >= 2 && value[0] === value.at(-1) && (value[0] === "'" || value[0] === '"') ? value.slice(1, -1).trim() : value;
}
/** URL absoluta http(s) sin credenciales, query ni fragmento, y sin barra final. */
export function parseServiceUrl(value: string, key: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`Configuración inválida: ${key} debe ser una URL absoluta con http:// o https://.`); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`Configuración inválida: ${key}`);
  if (import.meta.env.PROD && parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) throw new Error(`${key} requiere HTTPS`);
  return value.replace(/\/+$/, "");
}
function serviceUrl(key: string): string {
  const value = env(key);
  if (!value) throw new Error(`Falta ${key}. Configura web/.env a partir de web/.env.example y reinicia Astro.`);
  return parseServiceUrl(value, key);
}
function nonNegativeInteger(key: string, fallback: number): number {
  const value = Number(env(key) || fallback);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}
const list = (value: string) => value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);

export function serverConfig() {
  return {
    authUrl: serviceUrl("AUTH_SERVICE_URL"),
    // Opcional pero recomendada: la misma INTERNAL_API_KEY del auth-service. Con ella se reenvían la IP y el
    // navegador reales del usuario; sin ella, el auth-service ve a todos con la IP de este servidor.
    internalApiKey: env("AUTH_INTERNAL_API_KEY"),
    // Motor forense por defecto. Puede faltar mientras el backend no esté desplegado.
    apiUrl: env("CERTIFACE_API_URL") ? serviceUrl("CERTIFACE_API_URL") : "",
    // Panel oculto (Ctrl+Alt+Shift+M) para que cada sesión use otro motor, p. ej. uno local publicado con un túnel.
    forensicsOverride: {
      enabled: env("FORENSICS_API_OVERRIDE") === "true",
      // En producción solo se aceptan estos dominios (comodín con *.); en desarrollo, cualquier URL.
      hosts: list(env("FORENSICS_API_OVERRIDE_HOSTS") || "*.trycloudflare.com,*.ngrok-free.app,*.ngrok.app"),
    },
    origin: new URL(serviceUrl("APP_ORIGIN")).origin,
    policy: JSON.parse(env("ROLE_PERMISSIONS") || "{}") as AccessPolicy,
    fallback: JSON.parse(env("DEFAULT_PERMISSIONS") || "[]") as Permission[],
    // Duración máxima de la sesión desde el login, aunque se renueven los tokens.
    sessionTtlSeconds: Math.max(300, nonNegativeInteger("SESSION_TTL_SECONDS", 14400)),
    // Proxies delante de este servidor (0 = usar la IP de la conexión). Igual que en el auth-service.
    trustedProxyCount: nonNegativeInteger("TRUSTED_PROXY_COUNT", 0),
  };
}
