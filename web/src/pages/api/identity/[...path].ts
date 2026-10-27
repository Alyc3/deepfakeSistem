import type { APIRoute } from "astro";
import { homeFor } from "@domain/access";
import { identityRequest, ServiceError, verifiedProfile } from "@infrastructure/server/identity-service";
import { serverConfig } from "@infrastructure/server/config";
import { permissionsFor } from "@domain/access";
import { jsonBody, serviceFailure } from "@infrastructure/server/request";

// Límite local adicional al servicio central. En múltiples réplicas usar el limitador del proxy compartido.
const attempts = new Map<string, { count: number; until: number }>();
function throttle(key: string) {
  const now = Date.now();
  if (attempts.size > 5000) for (const [id, entry] of attempts) if (entry.until < now) attempts.delete(id);
  const entry = attempts.get(key);
  if (entry && entry.until > now && entry.count >= 10) throw new ServiceError(429, "Demasiados intentos. Espera unos minutos.");
  if (entry && entry.until > now) entry.count++;
  else {
    if (attempts.size >= 10000) throw new ServiceError(429, "Intenta de nuevo más tarde.");
    attempts.set(key, { count: 1, until: now + 600_000 });
  }
}
export const ALL: APIRoute = async (context) => {
  const path = context.params.path ?? "";
  const method = context.request.method;
  try {
    if (path === "auth/logout" && method === "POST") {
      context.session?.destroy();
      return new Response(null, { status: 204 });
    }
    if (["auth/login", "auth/password-recovery", "auth/reset-password"].includes(path) && method === "POST") {
      throttle(context.clientAddress);
      const body = await jsonBody(context.request);
      if (path === "auth/login") {
        if (typeof body.email !== "string" || typeof body.password !== "string" || body.email.length > 254 || body.password.length > 1024) throw new ServiceError(400, "Revisa el correo y la contraseña.");
        const result = await identityRequest("/api/auth/login", "POST", undefined, { email: body.email.trim(), password: body.password }) as { access_token?: string; token_type?: string };
        if (!result.access_token || result.token_type?.toLowerCase() !== "bearer") throw new ServiceError(502, "No se recibió una sesión válida.");
        const user = await verifiedProfile(result.access_token);
        if (!context.session) throw new ServiceError(503, "No se pudo iniciar la sesión.");
        await context.session.regenerate();
        context.session.set("accessToken", result.access_token);
        context.session.set("authenticatedAt", Date.now());
        const config = serverConfig();
        return Response.json({ user, home: homeFor(permissionsFor(user.role.name, config.policy, config.fallback)) });
      }
      const fields = path === "auth/password-recovery" ? ["email"] : ["token", "new_password"];
      if (fields.some((key) => typeof body[key] !== "string" || !(body[key] as string).length || (body[key] as string).length > 2048)) throw new ServiceError(400, "Completa los campos.");
      await identityRequest(`/api/${path}`, "POST", undefined, Object.fromEntries(fields.map((key) => [key, body[key]])));
      return Response.json({ message: path === "auth/password-recovery" ? "Si la cuenta existe, recibirás un enlace de recuperación." : "Contraseña actualizada. Ya puedes iniciar sesión." });
    }
    if (!context.locals.user || !context.locals.accessToken) throw new ServiceError(401, "Debes iniciar sesión.");
    if (path === "auth/me" && method === "GET") return Response.json({ user: context.locals.user, permissions: context.locals.permissions, home: homeFor(context.locals.permissions) });
    const match = /^(users|roles)(?:\/([a-zA-Z0-9_-]+))?$/.exec(path);
    if (!match) throw new ServiceError(404, "Operación no disponible.");
    const [, resource, id] = match;
    if (!context.locals.permissions.includes(resource as "users" | "roles")) throw new ServiceError(403, "No tienes acceso a esta sección.");
    const supported = resource === "users" ? (id ? ["PATCH"] : ["GET", "POST"]) : (id ? ["PUT", "DELETE"] : ["GET", "POST"]);
    if (!supported.includes(method)) throw new ServiceError(405, "Método no permitido.");
    const target = resource === "users" && method === "POST" ? "/api/auth/register" : `/api/${resource}/${id ? encodeURIComponent(id) : ""}`;
    const body = ["POST", "PATCH", "PUT"].includes(method) ? await jsonBody(context.request) : undefined;
    if (body) {
      const allowed = resource === "roles" ? ["name", "description"] : method === "POST" ? ["email", "password", "role_name", "first_name", "last_name", "identifier", "phone_number", "status"] : ["email", "password", "role_name", "identifier", "phone_number", "status"];
      if (Object.keys(body).some((key) => !allowed.includes(key))) throw new ServiceError(400, "Campos no permitidos.");
    }
    const result = await identityRequest(target, method, context.locals.accessToken, body);
    return method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(result, { status: method === "POST" ? 201 : 200 });
  } catch (error) { return serviceFailure(error); }
};
