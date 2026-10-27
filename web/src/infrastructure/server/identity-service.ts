import type { IdentityUser } from "@domain/identity";
import { serverConfig } from "./config";

export class ServiceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function identityRequest(path: string, method = "GET", token?: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${serverConfig().authUrl}${path}`, {
      method, redirect: "error", headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000), cache: "no-store",
    });
  } catch { throw new ServiceError(503, "Servicio temporalmente no disponible. Intenta de nuevo."); }
  if (!response.ok) {
    const messages: Record<number, string> = { 400: "Revisa los datos. Puede existir un registro duplicado.", 401: "Credenciales incorrectas o sesión expirada.", 403: "No tienes permiso para esta operación.", 404: "Registro no encontrado.", 422: "Revisa el formato de los campos.", 429: "Demasiados intentos. Espera antes de reintentar." };
    throw new ServiceError(messages[response.status] ? response.status : 502, messages[response.status] ?? "El servicio no pudo completar la operación.");
  }
  if (response.status === 204) return undefined;
  try { return await response.json(); } catch { throw new ServiceError(502, "Respuesta inválida del servicio."); }
}
export async function verifiedProfile(token: string): Promise<IdentityUser> {
  const user = await identityRequest("/api/auth/me", "GET", token) as IdentityUser;
  if (!user?.id || !user.email || !user.role?.name) throw new ServiceError(502, "Perfil inválido.");
  if (user.status !== "ACTIVO") throw new ServiceError(403, "La cuenta no está activa.");
  return user;
}
