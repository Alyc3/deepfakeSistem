// @ts-check
import { defineConfig, sessionDrivers } from "astro/config";
import node from "@astrojs/node";
import { loadEnv } from "vite";
const env = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
const production = process.env.NODE_ENV === "production";
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  session: {
    driver: sessionDrivers.fs({ base: "./.sessions" }),
    ttl: Math.max(300, Number(env.SESSION_TTL_SECONDS || 14400)),
    cookie: { name: production ? "__Host-certiface" : "certiface-session", secure: production || env.SESSION_COOKIE_SECURE === "true", sameSite: "lax", path: "/" },
  },
  security: { checkOrigin: true, csp: { directives: ["default-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:", "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"], styleDirective: { resources: ["'self'", "'unsafe-inline'"] } } },
  markdown: { syntaxHighlight: false },
  server: { port: 4321, host: true },
  devToolbar: { enabled: false },
});
