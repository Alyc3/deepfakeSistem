import { dev } from 'astro';
const port = Number(process.env.TEST_APP_PORT);
const server = await dev({
  server: { host: '127.0.0.1', port },
  vite: { cacheDir: `.astro/test-vite-${port}` },
});
process.on('SIGTERM', async () => { await server.stop(); process.exit(0); });
