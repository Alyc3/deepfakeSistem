// @ts-check
import { defineConfig } from "astro/config";

// Sitio estático: `astro build` produce HTML + JS que cualquier servidor web
// sirve tal cual. Toda la lógica vive en el navegador y habla con la API de
// CertiFace (FastAPI) por HTTP, así que el frontend no necesita servidor
// propio ni proceso de Node en producción.
export default defineConfig({
  server: {
    port: 4321,
    // Con --host expuesto el laboratorio es accesible desde otros equipos de
    // la red (tabletas, portátiles del perito) sin cambiar nada más.
    host: true,
  },
  devToolbar: {
    enabled: false,
  },
});
