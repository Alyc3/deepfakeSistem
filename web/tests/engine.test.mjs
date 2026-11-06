import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { startTestServer } from './support/server.mjs';

// Segundo motor forense, como el que el perito publicaría desde su equipo.
let server, engine, engineUrl;
const engineCalls = [];
before(async () => {
  engine = http.createServer((request, response) => {
    engineCalls.push({ path: request.url, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    response.end(request.url === '/health/live' ? '{"status":"ok"}' : '{}');
  });
  engine.listen(0, '127.0.0.1'); await once(engine, 'listening');
  engineUrl = `http://127.0.0.1:${engine.address().port}`;
  server = await startTestServer();
}, { timeout: 45000 });
after(async () => { await server?.close(); await new Promise((resolve) => engine.close(resolve)); });

const call = (path, options = {}) => fetch(`${server.origin}${path}`, { redirect: 'manual', ...options });
const send = (method, path, cookie, body) => call(path, { method, headers: { Origin: server.origin, Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
async function login(email) {
  const response = await call('/api/identity/auth/login', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'fixture-password' }) });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('the hidden panel is only rendered for laboratory roles and never reveals the server URL', async () => {
  const perito = await login('perito@example.test');
  const lab = await (await call('/app/inicio', { headers: { Cookie: perito } })).text();
  assert.match(lab, /id="engine-dialog"/);
  assert.ok(!lab.includes(server.mockOrigin), 'la URL del motor del servidor no debe llegar al navegador');
  const guest = await login('invitado@example.test');
  assert.ok(!(await (await call('/app/perfil', { headers: { Cookie: guest } })).text()).includes('engine-dialog'));
  assert.equal((await call('/api/forensics/connection', { headers: { Cookie: guest } })).status, 403);
});

test('a session can switch to another engine and back to the server one', async () => {
  const cookie = await login('perito@example.test');
  assert.deepEqual(await (await call('/api/forensics/connection', { headers: { Cookie: cookie } })).json(), { source: 'server', url: null });
  const switched = await send('PUT', '/api/forensics/connection', cookie, { url: `${engineUrl}/` });
  assert.equal(switched.status, 200, await switched.clone().text());
  assert.deepEqual(await switched.json(), { source: 'session', url: engineUrl });
  engineCalls.length = 0;
  assert.equal((await call('/api/forensics/health', { headers: { Cookie: cookie } })).status, 200);
  assert.equal(engineCalls.at(-1).path, '/health/live');
  assert.match(engineCalls.at(-1).authorization, /^Bearer private-fixture-token-/, 'el token del usuario viaja solo de servidor a servidor');
  const reset = await send('DELETE', '/api/forensics/connection', cookie);
  assert.deepEqual(await reset.json(), { source: 'server', url: null });
  engineCalls.length = 0;
  await call('/api/forensics/health', { headers: { Cookie: cookie } });
  assert.equal(engineCalls.length, 0, 'de vuelta al motor del servidor');
});

test('the choice belongs to one session only', async () => {
  const first = await login('perito@example.test');
  await send('PUT', '/api/forensics/connection', first, { url: engineUrl });
  const second = await login('administrador@example.test');
  assert.equal((await (await call('/api/forensics/connection', { headers: { Cookie: second } })).json()).source, 'server');
});

test('invalid or unreachable engines are rejected before saving', async () => {
  const cookie = await login('perito@example.test');
  assert.equal((await send('PUT', '/api/forensics/connection', cookie, { url: 'ftp://example.test' })).status, 400);
  assert.equal((await send('PUT', '/api/forensics/connection', cookie, { url: 'http://user:pass@127.0.0.1:1' })).status, 400);
  assert.equal((await send('PUT', '/api/forensics/connection', cookie, { url: 'http://127.0.0.1:1' })).status, 502);
  assert.equal((await (await call('/api/forensics/connection', { headers: { Cookie: cookie } })).json()).source, 'server');
});
