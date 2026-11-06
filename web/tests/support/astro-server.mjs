import { join } from 'node:path';
import { dev } from 'astro';
const port = Number(process.env.TEST_APP_PORT);
const server = await dev({
  server: { host: '127.0.0.1', port },
  // Carpeta temporal creada y borrada por support/server.mjs: no deja cachés en .astro.
  vite: { cacheDir: join(process.env.TEST_RUNTIME_DIR, 'vite') },
});
process.on('SIGTERM', async () => { await server.stop(); process.exit(0); });
