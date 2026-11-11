import type { APIContext, APIRoute } from "astro";
import QRCode from "qrcode";
import { homeFor, permissionsFor, type Permission } from "@domain/access";
import { NEW_USER_STATUSES, type IdentityUser } from "@domain/identity";
import { identityRequest, identityResponse, ServiceError, verifiedProfile } from "@infrastructure/server/identity-service";
import { accessToken, clearSession, establishSession, isMfaChallenge, isTokenPair, storeMfaChallenge, type TokenPair } from "@infrastructure/server/auth-session";
import { serverConfig } from "@infrastructure/server/config";
import { jsonBody, serviceFailure } from "@infrastructure/server/request";
import { PROFILE_SCHEMA, ROLE_SCHEMA, RULES, SUSPENSION_SCHEMA, USER_SCHEMA, checkValue, validateFields, type Rule, type Schema } from "@domain/validation";

type Body = Record<string, unknown>;
type Access = "public" | "session" | Permission;
interface Route { method: string; pattern: RegExp; access: Access; body: boolean; handle: (context: APIContext, match: RegExpExecArray, body: Body) => Promise<Response>; }

// Límite local adicional al del auth-service. En varias réplicas usa el limitador del proxy compartido.
const attempts = new Map<string, { count: number; until: number }>();
function guard(key: string, max: number): void {
  const now = Date.now();
  if (attempts.size > 5000) for (const [id, entry] of attempts) if (entry.until < now) attempts.delete(id);
  const entry = attempts.get(key);
  if (entry && entry.until > now && entry.count >= max) throw new ServiceError(429, "Demasiados intentos. Espera unos minutos.");
}
function hit(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);
  if (entry && entry.until > now) entry.count++;
  else if (attempts.size < 10000) attempts.set(key, { count: 1, until: now + 600_000 });
}

const ID = "([A-Za-z0-9_-]{1,64})";
const route = (method: string, path: string, access: Access, handle: Route["handle"], body = false): Route =>
  ({ method, pattern: new RegExp(`^${path.replace(":id", ID)}$`), access, handle, body });
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
const noContent = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

/** Acepta solo los campos permitidos, con tipos y tamaños acotados. Las cadenas vacías opcionales se omiten. */
function fields(body: Body, allowed: string[], required: string[] = [], { nullable = false } = {}): Body {
  const result: Body = {};
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.includes(key)) throw new ServiceError(400, "Campos no permitidos.");
    if (value === null && nullable) { result[key] = null; continue; }
    if (typeof value !== "string" || value.length > 2048) throw new ServiceError(400, "Revisa el formato de los campos.");
    if (value.length || required.includes(key)) result[key] = value;
  }
  if (required.some((key) => typeof result[key] !== "string" || !(result[key] as string).length)) throw new ServiceError(400, "Completa los campos obligatorios.");
  return result;
}
/** Normaliza y valida el formato de cada campo; si algo falla, responde 400 con todos los motivos. */
function checked(data: Body, schema: Schema, required: string[] = []): Body {
  const { values, errors } = validateFields(data, schema, required);
  if (errors.length) throw new ServiceError(400, "Revisa los datos del formulario.", undefined, errors);
  return values;
}
/** Un único valor obligatorio con su regla. */
function one(value: unknown, rule: Rule): string {
  const result = checkValue(rule, value, true);
  if (result.error) throw new ServiceError(400, result.error);
  return result.value!;
}
const call = (context: APIContext, path: string, method = "GET", body?: unknown) =>
  identityRequest(path, { method, body, token: context.locals.accessToken, client: context.locals.client });
const message = (data: unknown, fallback: string) => {
  const text = (data as { message?: unknown } | undefined)?.message;
  return json({ message: typeof text === "string" ? text : fallback });
};
const at = (id: string) => encodeURIComponent(id);
const ipKey = (context: APIContext) => context.locals.client.ip ?? "desconocida";

/** Termina el login (con o sin MFA): valida el perfil y abre la sesión del navegador. */
async function openSession(context: APIContext, pair: TokenPair): Promise<Response> {
  let user: IdentityUser;
  try { user = await verifiedProfile(pair.access_token, context.locals.client); }
  catch (error) {
    await identityRequest("/api/auth/logout", { method: "POST", token: pair.access_token, client: context.locals.client }).catch(() => undefined);
    throw error;
  }
  await establishSession(context.session!, pair);
  context.session!.delete("mfaToken");
  const config = serverConfig();
  return json({ user, home: homeFor(permissionsFor(user.role.name, config.policy, config.fallback)) });
}

const routes: Route[] = [
  // ---------- Acceso público ----------
  route("POST", "auth/login", "public", async (context, _match, body) => {
    if (typeof body.email !== "string" || typeof body.password !== "string" || !body.password || body.password.length > 1024) {
      throw new ServiceError(400, "Revisa el correo y la contraseña.");
    }
    const email = one(body.email, RULES.email);
    const accountKey = `login:${ipKey(context)}:${email}`;
    guard(accountKey, 10); guard(`login:${ipKey(context)}`, 50);
    hit(`login:${ipKey(context)}`);
    if (!context.session) throw new ServiceError(503, "No se pudo iniciar la sesión.");
    let result: unknown;
    try { result = await identityRequest("/api/auth/login", { method: "POST", body: { email, password: body.password }, client: context.locals.client }); }
    catch (error) { if (error instanceof ServiceError && [401, 423].includes(error.status)) hit(accountKey); throw error; }
    attempts.delete(accountKey);
    if (isMfaChallenge(result)) { await storeMfaChallenge(context.session, result); return json({ mfa_required: true }); }
    if (!isTokenPair(result)) throw new ServiceError(502, "No se recibió una sesión válida.");
    return openSession(context, result);
  }, true),
  route("POST", "auth/mfa/verify", "public", async (context, _match, body) => {
    const code = one(fields(body, ["code"], ["code"]).code, RULES.otpCode);
    const key = `mfa:${ipKey(context)}`;
    guard(key, 10);
    const mfaToken = await context.session?.get("mfaToken");
    if (!mfaToken) throw new ServiceError(401, "El tiempo para escribir el código terminó. Vuelve a iniciar sesión.");
    let result: unknown;
    try { result = await identityRequest("/api/auth/mfa/verify", { method: "POST", body: { mfa_token: mfaToken, code }, client: context.locals.client }); }
    catch (error) {
      hit(key);
      if (error instanceof ServiceError && error.code === "mfa_token inválido o expirado") context.session?.delete("mfaToken");
      throw error;
    }
    if (!isTokenPair(result)) throw new ServiceError(502, "No se recibió una sesión válida.");
    return openSession(context, result);
  }, true),
  route("POST", "auth/password-recovery", "public", async (context, _match, body) => {
    const data = { email: one(fields(body, ["email"], ["email"]).email, RULES.email) };
    const key = `recovery:${ipKey(context)}`;
    guard(key, 5); hit(key);
    await identityRequest("/api/auth/password-recovery", { method: "POST", body: data, client: context.locals.client });
    return json({ message: "Si la cuenta existe, recibirás un enlace de recuperación." });
  }, true),
  route("POST", "auth/reset-password", "public", async (context, _match, body) => {
    const raw = fields(body, ["token", "new_password"], ["token", "new_password"]);
    const data = { token: one(raw.token, RULES.resetToken), new_password: one(raw.new_password, RULES.password) };
    const key = `reset:${ipKey(context)}`;
    guard(key, 10); hit(key);
    await identityRequest("/api/auth/reset-password", { method: "POST", body: data, client: context.locals.client });
    return json({ message: "Contraseña actualizada. Ya puedes iniciar sesión." });
  }, true),
  route("POST", "auth/logout", "public", async (context) => {
    // Revoca la sesión también en el auth-service; si no, su refresh token seguiría siendo válido.
    if (context.session) {
      const token = await accessToken(context.session, context.locals.client).catch(() => null);
      if (token) await identityRequest("/api/auth/logout", { method: "POST", token, client: context.locals.client }).catch(() => undefined);
    }
    clearSession(context.session);
    return noContent();
  }),

  // ---------- Cuenta propia ----------
  route("GET", "auth/me", "session", async (context) =>
    json({ user: context.locals.user, permissions: context.locals.permissions, home: homeFor(context.locals.permissions) })),
  route("PATCH", "auth/me", "session", async (context, _match, body) =>
    json(await call(context, "/api/auth/me", "PATCH", checked(fields(body, ["first_name", "last_name", "phone_number"], [], { nullable: true }), PROFILE_SCHEMA))), true),
  route("POST", "auth/change-password", "session", async (context, _match, body) => {
    const data = fields(body, ["current_password", "new_password"], ["current_password", "new_password"]);
    return message(await call(context, "/api/auth/change-password", "POST", data), "Contraseña actualizada.");
  }, true),
  route("GET", "auth/sessions", "session", async (context) => json(await call(context, "/api/auth/sessions"))),
  route("DELETE", "auth/sessions/:id", "session", async (context, match) => {
    await call(context, `/api/auth/sessions/${at(match[1])}`, "DELETE");
    return noContent();
  }),
  route("POST", "auth/logout-all", "session", async (context) => {
    await call(context, "/api/auth/logout-all", "POST");
    clearSession(context.session);
    return noContent();
  }),
  route("POST", "auth/mfa/setup", "session", async (context, _match, body) => {
    const setup = await call(context, "/api/auth/mfa/setup", "POST", fields(body, ["password"], ["password"])) as { secret?: unknown; otpauth_uri?: unknown };
    if (typeof setup?.secret !== "string" || typeof setup.otpauth_uri !== "string" || !setup.otpauth_uri.startsWith("otpauth://")) {
      throw new ServiceError(502, "No se pudo preparar la verificación en dos pasos.");
    }
    const svg = await QRCode.toString(setup.otpauth_uri, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#100c0b", light: "#ffffff" } });
    return json({ secret: setup.secret, otpauth_uri: setup.otpauth_uri, qr_svg: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` });
  }, true),
  route("POST", "auth/mfa/enable", "session", async (context, _match, body) =>
    message(await call(context, "/api/auth/mfa/enable", "POST", { code: one(fields(body, ["code"], ["code"]).code, RULES.otpCode) }), "Verificación en dos pasos activada."), true),
  route("POST", "auth/mfa/disable", "session", async (context, _match, body) =>
    message(await call(context, "/api/auth/mfa/disable", "POST", checked(fields(body, ["password", "code"], ["password", "code"]), { password: RULES.password, code: RULES.otpCode }, ["password", "code"])), "Verificación en dos pasos desactivada."), true),

  // ---------- Usuarios ----------
  route("GET", "users", "users", async (context) => {
    // El auth-service pagina (máximo 200 por página): se reúnen todas las páginas.
    const users: unknown[] = [];
    for (let page = 0; page < 25; page++) {
      const { data, headers } = await identityResponse<unknown[]>(`/api/users/?skip=${users.length}&limit=200`, { token: context.locals.accessToken, client: context.locals.client });
      if (!Array.isArray(data)) throw new ServiceError(502, "Respuesta inválida del servicio de usuarios.");
      users.push(...data);
      const total = Number(headers.get("x-total-count"));
      if (data.length < 200 || (Number.isFinite(total) && users.length >= total)) break;
    }
    return json(users, 200, { "X-Total-Count": String(users.length) });
  }),
  route("POST", "users", "users", async (context, _match, body) => {
    const data = checked(fields(body, ["email", "password", "role_name", "first_name", "last_name", "identifier", "phone_number", "status"], ["email", "role_name"]), USER_SCHEMA, ["email", "role_name"]);
    if (data.status !== undefined && !(NEW_USER_STATUSES as readonly unknown[]).includes(data.status)) {
      throw new ServiceError(400, "Estado: una cuenta nueva solo puede crearse activa o pendiente.");
    }
    return json(await call(context, "/api/auth/register", "POST", data), 201);
  }, true),
  route("PATCH", "users/:id", "users", async (context, match, body) => {
    const data = checked(fields(body, ["email", "password", "role_name", "first_name", "last_name", "identifier", "phone_number", "status"], [], { nullable: true }), USER_SCHEMA);
    // El correo, el rol y el estado se pueden cambiar, pero no vaciar.
    for (const key of ["email", "role_name", "status"]) if (key in data && data[key] === null) throw new ServiceError(400, `${USER_SCHEMA[key].label}: es obligatorio.`);
    return json(await call(context, `/api/users/${at(match[1])}`, "PATCH", data));
  }, true),
  route("DELETE", "users/:id", "users", async (context, match) => {
    await call(context, `/api/users/${at(match[1])}`, "DELETE");
    return noContent();
  }),
  route("PATCH", "users/:id/suspend", "users", async (context, match, body) => {
    const data = checked(fields(body, ["suspended_from", "suspended_until"], [], { nullable: true }), SUSPENSION_SCHEMA);
    if ((data.suspended_from === null) !== (data.suspended_until === null) || (data.suspended_from && Date.parse(data.suspended_until as string) <= Date.parse(data.suspended_from as string))) {
      throw new ServiceError(400, "La fecha final de la suspensión debe ser posterior a la inicial.");
    }
    return json(await call(context, `/api/users/${at(match[1])}/suspend`, "PATCH", { suspended_from: data.suspended_from ?? null, suspended_until: data.suspended_until ?? null }));
  }, true),
  route("POST", "users/:id/unlock", "users", async (context, match) => json(await call(context, `/api/users/${at(match[1])}/unlock`, "POST"))),
  route("POST", "users/:id/revoke-sessions", "users", async (context, match) => {
    await call(context, `/api/users/${at(match[1])}/revoke-sessions`, "POST");
    return noContent();
  }),
  route("DELETE", "users/:id/mfa", "users", async (context, match) => json(await call(context, `/api/users/${at(match[1])}/mfa`, "DELETE"))),

  // ---------- Roles ----------
  route("GET", "roles", "roles", async (context) => json(await call(context, "/api/roles/"))),
  route("POST", "roles", "roles", async (context, _match, body) =>
    json(await call(context, "/api/roles/", "POST", checked(fields(body, ["name", "description"], ["name"]), ROLE_SCHEMA, ["name"])), 201), true),
  route("PUT", "roles/:id", "roles", async (context, match, body) =>
    json(await call(context, `/api/roles/${at(match[1])}`, "PUT", checked(fields(body, ["name", "description"], ["name"]), ROLE_SCHEMA, ["name"]))), true),
  route("DELETE", "roles/:id", "roles", async (context, match) => {
    await call(context, `/api/roles/${at(match[1])}`, "DELETE");
    return noContent();
  }),

  // ---------- Auditoría ----------
  route("GET", "audit", "audit", async (context) => {
    const input = context.url.searchParams;
    const query = new URLSearchParams();
    const date = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;
    const text = (key: string, max: number, pattern?: RegExp) => {
      const value = input.get(key)?.trim();
      if (!value) return;
      if (value.length > max || (pattern && !pattern.test(value))) throw new ServiceError(400, "Filtros inválidos.");
      query.set(key, value);
    };
    text("action", 100); text("user_id", 64, /^[A-Za-z0-9_-]+$/); text("date_from", 40, date); text("date_to", 40, date);
    const skip = Math.max(0, Math.floor(Number(input.get("skip") ?? 0)) || 0);
    const limit = Math.min(200, Math.max(1, Math.floor(Number(input.get("limit") ?? 50)) || 50));
    query.set("skip", String(skip)); query.set("limit", String(limit));
    const { data, headers } = await identityResponse<unknown[]>(`/api/audit-logs/?${query}`, { token: context.locals.accessToken, client: context.locals.client });
    if (!Array.isArray(data)) throw new ServiceError(502, "Respuesta inválida del servicio de usuarios.");
    return json({ items: data, total: Number(headers.get("x-total-count")) || data.length });
  }),
];

export const ALL: APIRoute = async (context) => {
  const path = context.params.path ?? "";
  const method = context.request.method;
  try {
    const candidates = routes.flatMap((item) => { const match = item.pattern.exec(path); return match ? [{ item, match }] : []; });
    if (!candidates.length) throw new ServiceError(404, "Operación no disponible.");
    const found = candidates.find((entry) => entry.item.method === method);
    if (!found) throw new ServiceError(405, "Método no permitido.");
    const { item, match } = found;
    if (item.access !== "public") {
      if (!context.locals.user || !context.locals.accessToken) throw new ServiceError(401, "Debes iniciar sesión.");
      if (item.access !== "session" && !context.locals.permissions.includes(item.access)) throw new ServiceError(403, "No tienes acceso a esta sección.");
    }
    const body = item.body ? await jsonBody(context.request) : {};
    return await item.handle(context, match, body);
  } catch (error) {
    if (error instanceof ServiceError && error.errors?.length) {
      return Response.json({ detail: error.message, errors: error.errors }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    return serviceFailure(error);
  }
};
