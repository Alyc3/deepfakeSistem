import { defineMiddleware } from "astro:middleware";
import { SECTIONS, permissionsFor, homeFor } from "@domain/access";
import { serverConfig } from "@infrastructure/server/config";
import { ServiceError, verifiedProfile } from "@infrastructure/server/identity-service";

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  const api = pathname.startsWith("/api/");
  const protectedPage = pathname === "/app" || pathname.startsWith("/app/");
  context.locals.user = null;
  context.locals.permissions = [];
  const fail = (status: number, message: string) => api
    ? Response.json({ detail: message }, { status })
    : context.redirect(status === 401 ? "/login?expired=1" : `/acceso?reason=${status}`, 303);
  // JSON y formularios usan el mismo control de origen. Nunca confiar solo en el sidebar.
  if (api && !["GET", "HEAD", "OPTIONS"].includes(context.request.method)) {
    const config = serverConfig();
    if (context.request.headers.get("origin") !== config.origin || context.request.headers.get("sec-fetch-site") === "cross-site") return fail(403, "Origen no permitido.");
  }
  const publicApi = ["/api/identity/auth/login", "/api/identity/auth/password-recovery", "/api/identity/auth/reset-password", "/api/identity/auth/logout"];
  if (protectedPage || (api && !publicApi.includes(pathname))) {
    const token = await context.session?.get("accessToken");
    if (!token) return fail(401, "Debes iniciar sesión.");
    try {
      const user = await verifiedProfile(token);
      const config = serverConfig();
      context.locals.user = user;
      context.locals.accessToken = token;
      context.locals.permissions = permissionsFor(user.role.name, config.policy, config.fallback);
    } catch (error) {
      const status = error instanceof ServiceError ? error.status : 503;
      if (status === 401 || status === 403) context.session?.destroy();
      return fail(status === 403 ? 401 : status, error instanceof Error ? error.message : "No se pudo validar la sesión.");
    }
    if (protectedPage) {
      if (pathname === "/app" || pathname === "/app/") return context.redirect(homeFor(context.locals.permissions), 303);
      const section = SECTIONS.find((s) => pathname.replace(/\/$/, "") === `/app/${s.id}`);
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
