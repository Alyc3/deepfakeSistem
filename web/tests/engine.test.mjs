import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/server.mjs';

// El motor forense es siempre el de CERTIFACE_API_URL (en las pruebas, el servidor simulado).
let server;
before(async () => { server = await startTestServer(); }, { timeout: 45000 });
after(async () => { await server?.close(); });

const call = (path, options = {}) => fetch(`${server.origin}${path}`, { redirect: 'manual', ...options });
async function login(email) {
  const response = await call('/api/identity/auth/login', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'fixture-password' }) });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('the lab calls the engine from CERTIFACE_API_URL with the user token, server to server', async () => {
  const cookie = await login('perito@example.test');
  server.calls.length = 0;
  assert.equal((await call('/api/forensics/health', { headers: { Cookie: cookie } })).status, 200);
  const health = server.calls.find((entry) => entry.path === '/health/live');
  assert.ok(health, 'la web consulta el motor configurado');
  assert.match(health.headers.authorization, /^Bearer private-fixture-token-/);
});

test('the engine URL is not configurable from the browser and never reaches it', async () => {
  const cookie = await login('perito@example.test');
  const lab = await (await call('/app/laboratorio', { headers: { Cookie: cookie } })).text();
  assert.ok(!lab.includes('engine-dialog'), 'ya no existe el panel para cambiar de motor');
  assert.ok(!lab.includes(server.mockOrigin), 'la URL del motor no debe llegar al navegador');
  assert.equal((await call('/api/forensics/connection', { headers: { Cookie: cookie } })).status, 404);
});
