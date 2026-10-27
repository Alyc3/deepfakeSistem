import type { AccessPolicy, Permission } from "@domain/access";

const buildEnvironment: Record<string, string | undefined> = {
  AUTH_SERVICE_URL: import.meta.env.AUTH_SERVICE_URL,
  CERTIFACE_API_URL: import.meta.env.CERTIFACE_API_URL,
  APP_ORIGIN: import.meta.env.APP_ORIGIN,
  ROLE_PERMISSIONS: import.meta.env.ROLE_PERMISSIONS,
  DEFAULT_PERMISSIONS: import.meta.env.DEFAULT_PERMISSIONS,
};
function env(key: string): string {
  return process.env[key] ?? buildEnvironment[key] ?? "";
}
function serviceUrl(key: string): string {
  const value = env(key);
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`Configuración inválida: ${key}`);
  if (import.meta.env.PROD && parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) throw new Error(`${key} requiere HTTPS`);
  return value.replace(/\/+$/, "");
}
export function serverConfig() {
  return {
    authUrl: serviceUrl("AUTH_SERVICE_URL"),
    apiUrl: serviceUrl("CERTIFACE_API_URL"),
    origin: new URL(env("APP_ORIGIN")).origin,
    policy: JSON.parse(env("ROLE_PERMISSIONS") || "{}") as AccessPolicy,
    fallback: JSON.parse(env("DEFAULT_PERMISSIONS") || "[]") as Permission[],
  };
}
