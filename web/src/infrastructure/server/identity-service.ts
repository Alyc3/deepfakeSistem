import type { IdentityUser } from "@domain/identity";
import { serverConfig } from "./config";

export class ServiceError extends Error {
  constructor(public status: number, message: string, public code?: string, public errors?: string[]) { super(message); }
}
/** Datos del usuario final que se reenvían al auth-service (solo con AUTH_INTERNAL_API_KEY). */
export interface ClientContext { ip?: string; userAgent?: string; }
export interface IdentityResponse<T = unknown> { data: T; headers: Headers; }
interface RequestOptions { method?: string; token?: string; body?: unknown; client?: ClientContext; }

const FIELD_LABELS: Record<string, string> = {
  email: "correo", password: "contraseña", new_password: "nueva contraseña", current_password: "contraseña actual",
  first_name: "nombre", last_name: "apellido", identifier: "identificación", phone_number: "teléfono",
  role_name: "rol", name: "nombre del rol", description: "descripción", code: "código", token: "código de recuperación",
  status: "estado", suspended_from: "inicio de la suspensión", suspended_until: "fin de la suspensión",
};
// Mensajes técnicos del auth-service que se reescriben para el usuario.
const REWRITES: Record<string, string> = {
  SESSION_INVALIDATED: "Tu sesión se cerró en otro dispositivo o fue revocada. Vuelve a iniciar sesión.",
  EMAIL_NOT_VERIFIED: "Confirma tu correo antes de iniciar sesión.",
  "mfa_token inválido o expirado": "El tiempo para escribir el código terminó. Vuelve a iniciar sesión.",
};
const GENERIC: Record<number, string> = {
  400: "Revisa los datos.", 401: "Credenciales incorrectas o sesión expirada.", 403: "No tienes permiso para esta operación.",
  404: "Registro no encontrado.", 409: "Ya existe un registro con esos datos.", 422: "Revisa el formato de los campos.",
  423: "Cuenta bloqueada temporalmente por intentos fallidos.", 429: "Demasiados intentos. Espera antes de reintentar.",
};

function upstreamFailure(status: number, payload: unknown, headers: Headers): ServiceError {
  if (status >= 500 || !GENERIC[status]) return new ServiceError(502, "El servicio de usuarios no pudo completar la operación.");
  const detail = (payload as { detail?: unknown } | null)?.detail;
  if (status === 429) {
    const wait = Number(headers.get("retry-after"));
    return new ServiceError(429, Number.isFinite(wait) && wait > 0 ? `Demasiados intentos. Espera ${Math.ceil(wait)} s y vuelve a intentarlo.` : GENERIC[429]);
  }
  // Política de contraseñas: { message, errors[] }.
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const { message, errors } = detail as { message?: unknown; errors?: unknown };
    const list = Array.isArray(errors) ? errors.filter((item): item is string => typeof item === "string").slice(0, 10) : [];
    return new ServiceError(status, typeof message === "string" ? message : GENERIC[status], undefined, list);
  }
  // Validación de FastAPI: [{ loc, msg }]. Se indican los campos, no los mensajes técnicos en inglés.
  if (Array.isArray(detail)) {
    const fields = [...new Set(detail.map((item) => (item as { loc?: unknown[] })?.loc?.at(-1)).filter((field): field is string => typeof field === "string"))];
    const labels = fields.map((field) => FIELD_LABELS[field] ?? field);
    return new ServiceError(422, labels.length ? `Revisa: ${labels.join(", ")}.` : GENERIC[422]);
  }
  if (typeof detail === "string" && detail.length > 0 && detail.length <= 300) {
    return new ServiceError(status, REWRITES[detail] ?? detail, REWRITES[detail] ? detail : undefined);
  }
  return new ServiceError(status, GENERIC[status]);
}

export async function identityResponse<T = unknown>(path: string, options: RequestOptions = {}): Promise<IdentityResponse<T>> {
  const { method = "GET", token, body, client } = options;
  const config = serverConfig();
  const forward = config.internalApiKey && client ? {
    "X-Internal-Api-Key": config.internalApiKey,
    ...(client.ip ? { "X-Client-IP": client.ip } : {}),
    ...(client.userAgent ? { "X-Client-User-Agent": client.userAgent } : {}),
  } : {};
  let response: Response;
  try {
    response = await fetch(`${config.authUrl}${path}`, {
      method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60_000),
      headers: {
        Accept: "application/json",
        ...forward,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new ServiceError(503, "El servicio de usuarios no está disponible. Intenta de nuevo."); }
  if (!response.ok) throw upstreamFailure(response.status, await response.json().catch(() => null), response.headers);
  if (response.status === 204) return { data: undefined as T, headers: response.headers };
  try { return { data: await response.json() as T, headers: response.headers }; }
  catch { throw new ServiceError(502, "Respuesta inválida del servicio de usuarios."); }
}
export async function identityRequest<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  return (await identityResponse<T>(path, options)).data;
}
export async function verifiedProfile(token: string, client?: ClientContext): Promise<IdentityUser> {
  const user = await identityRequest<IdentityUser>("/api/auth/me", { token, client });
  if (!user?.id || !user.email || !user.role?.name) throw new ServiceError(502, "Perfil inválido.");
  if (user.status !== "ACTIVO") throw new ServiceError(403, "La cuenta no está activa.");
  return user;
}
