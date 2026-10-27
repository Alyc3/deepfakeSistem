import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/server.mjs';
let server;
before(async () => { server = await startTestServer(); }, { timeout: 45000 });
after(async () => { await server?.close(); });
const call = (path, options = {}) => fetch(`${server.origin}${path}`, { redirect: 'manual', ...options });
async function login(role) {
  const response = await call('/api/identity/auth/login', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${role.toLowerCase()}@example.test`, password: 'fixture-password' }) });
  assert.equal(response.status, 200, await response.clone().text());
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() };
}
test('anonymous visitors cannot open an internal route', async () => {
  const response = await call('/app/usuarios'); assert.equal(response.status, 303); assert.match(response.headers.get('location'), /^\/login/);
  assert.equal((await call('/api/identity/users')).status, 401);
});
test('login stores an HttpOnly opaque session and never returns the upstream token', async () => {
  const { response, body, cookie } = await login('ADMINISTRADOR');
  assert.match(response.headers.get('set-cookie'), /HttpOnly/i); assert.match(response.headers.get('set-cookie'), /SameSite=Lax/i);
  assert.ok(cookie); assert.equal(body.access_token, undefined); assert.ok(!JSON.stringify(body).includes('private-fixture-token'));
  const page = await call('/app/usuarios', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200); const html = await page.text(); assert.match(html, /Usuarios/); assert.ok(!html.includes('private-fixture-token'));
});
test('guest and unknown roles cannot open management or laboratory, even by URL', async () => {
  for (const role of ['INVITADO','NO_MAPEADO']) {
    const { cookie } = await login(role);
    for (const path of ['/app/usuarios','/app/roles','/app/laboratorio']) assert.equal((await call(path, { headers: { Cookie: cookie } })).status, 303);
    for (const path of ['/api/identity/users','/api/identity/roles','/api/forensics/health']) assert.equal((await call(path, { headers: { Cookie: cookie } })).status, 403);
    const profile = await call('/app/perfil', { headers: { Cookie: cookie } }); assert.equal(profile.status, 200);
    const html = await profile.text(); assert.ok(!html.includes('href="/app/usuarios"')); assert.ok(!html.includes('href="/app/laboratorio"'));
  }
});
test('analyst has laboratory access and cannot manage accounts', async () => {
  const { cookie } = await login('PERITO');
  assert.equal((await call('/app/laboratorio', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await call('/api/identity/users', { headers: { Cookie: cookie } })).status, 403);
});
test('administrator reads actual upstream users and roles', async () => {
  const { cookie } = await login('ADMINISTRADOR');
  const users = await call('/api/identity/users', { headers: { Cookie: cookie } }); assert.equal(users.status, 200); assert.equal((await users.json()).length, server.users.length);
  assert.equal((await call('/app/roles', { headers: { Cookie: cookie } })).status, 200);
});
test('requests without a matching origin are rejected', async () => {
  for (const Origin of [undefined,'https://attacker.example']) {
    const response = await call('/api/identity/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(Origin ? { Origin } : {}) }, body: '{}' }); assert.equal(response.status, 403);
  }
});
test('logout destroys the server session and a replayed cookie is rejected', async () => {
  const { cookie } = await login('PERITO');
  assert.equal((await call('/api/identity/auth/logout', { method: 'POST', headers: { Origin: server.origin, Cookie: cookie } })).status, 204);
  assert.equal((await call('/api/identity/auth/me', { headers: { Cookie: cookie } })).status, 401);
});
test('tampered sessions cannot grant permissions', async () => {
  const response = await call('/api/identity/users', { headers: { Cookie: 'certiface-session=administrator-forged' } }); assert.equal(response.status, 401);
});
