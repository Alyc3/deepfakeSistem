import { defineMiddleware } from "astro:middleware";
import { SECTIONS, permissionsFor, homeFor } from "@domain/access";
import { serverConfig } from "@infrastructure/server/config";
import { ServiceError, verifiedProfile } from "@infrastructure/server/identity-service";
import { accessToken, clearSession } from "@infrastructure/server/auth-session";
import { clientContext } from "@infrastructure/server/client";

// Rutas de la API que funcionan sin sesión iniciada.
const PUBLIC_API = new Set([
  "/api/identity/auth/login", "/api/identity/auth/mfa/verify", "/api/identity/auth/password-recovery",
  "/api/identity/auth/reset-password", "/api/identity/auth/logout",
]);

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  const api = pathname.startsWith("/api/");
  const protectedPage = pathname === "/app" || pathname.startsWith("/app/");
  context.locals.user = null;
  context.locals.permissions = [];
  context.locals.client = clientContext(context.request, () => context.clientAddress);
  const fail = (status: number, message: string) => api
    ? Response.json({ detail: message }, { status, headers: { "Cache-Control": "no-store" } })
    : context.redirect(status === 401 ? "/login?expired=1" : `/acceso?reason=${status}`, 303);
  // Control CSRF de toda petición que modifica datos (JSON, formularios y subidas), contra el origen público.
  if (!["GET", "HEAD", "OPTIONS"].includes(context.request.method)) {
    const config = serverConfig();
    if (context.request.headers.get("origin") !== config.origin || context.request.headers.get("sec-fetch-site") === "cross-site") return fail(403, "Origen no permitido.");
  }
  if (protectedPage || (api && !PUBLIC_API.has(pathname))) {
    const session = context.session;
    if (!session) return fail(503, "No se pudo leer la sesión.");
    const client = context.locals.client;
    try {
      let token = await accessToken(session, client);
      if (!token) {
        // Un login a medio camino (esperando el código MFA) no se descarta por visitar otra página.
        if (!(await session.has("mfaToken"))) clearSession(session);
        return fail(401, "Debes iniciar sesión.");
      }
      let user;
      try { user = await verifiedProfile(token, client); }
      catch (error) {
        // El access token pudo caducar antes de lo previsto o quedar revocado: un único intento de renovación.
        if (!(error instanceof ServiceError) || error.status !== 401) throw error;
        token = await accessToken(session, client, true);
        if (!token) throw error;
        user = await verifiedProfile(token, client);
      }
      const config = serverConfig();
      context.locals.user = user;
      context.locals.accessToken = token;
      context.locals.permissions = permissionsFor(user.role.name, config.policy, config.fallback);
    } catch (error) {
      const status = error instanceof ServiceError ? error.status : 503;
      if (status === 401 || status === 403) clearSession(session);
      return fail(status === 403 ? 401 : status, error instanceof Error ? error.message : "No se pudo validar la sesión.");
    }
    if (protectedPage) {
      if (pathname === "/app" || pathname === "/app/") return context.redirect(homeFor(context.locals.permissions), 303);
      const section = SECTIONS.find((s) => pathname.replace(/\/$/, "") === `/app/${s.id}`)
        ?? (pathname.replace(/\/$/, "") === "/app/laboratorio" ? { permission: "laboratory" as const } : undefined);
      if (!section) return new Response("Página no encontrada", { status: 404 });
      if (!context.locals.permissions.includes(section.permission)) return fail(403, "Acceso restringido.");
    }
  }
  const response = await next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (protectedPage || api || pathname !== "/") response.headers.set("Cache-Control", "no-store");
  if (import.meta.env.PROD) response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return response;
});
