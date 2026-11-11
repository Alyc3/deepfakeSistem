// @ts-check
import { defineConfig, sessionDrivers } from "astro/config";
import node from "@astrojs/node";
import { loadEnv } from "vite";
const env = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
const production = process.env.NODE_ENV === "production";
export default defineConfig({
  output: "server",
  // Evidencias de hasta 10 MB más el formulario; el resto de peticiones son mucho menores.
  adapter: node({ mode: "standalone", bodySizeLimit: 12 * 1024 * 1024 }),
  session: {
    // SESSION_DIR solo lo usan las pruebas, para no mezclar sus sesiones con las de desarrollo.
    driver: sessionDrivers.fs({ base: process.env.SESSION_DIR || "./.sessions" }),
    ttl: Math.max(300, Number(env.SESSION_TTL_SECONDS || 14400)),
    cookie: { name: production ? "__Host-certiface" : "certiface-session", secure: production || env.SESSION_COOKIE_SECURE === "true", sameSite: "lax", path: "/" },
  },
  security: {
    // El origen lo valida src/middleware.ts contra APP_ORIGIN en tiempo de ejecución. La comprobación de Astro
    // compara con la URL interna del servidor, que detrás del proxy de Render no coincide con la pública.
    checkOrigin: false,
    csp: { directives: ["default-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:", "font-src 'self'", "connect-src 'self'", "object-src 'none'", "frame-src 'self' blob:", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"], styleDirective: { resources: ["'self'", "'unsafe-inline'"] } },
  },
  markdown: { syntaxHighlight: false },
  server: { port: 4321, host: true },
  devToolbar: { enabled: false },
});
