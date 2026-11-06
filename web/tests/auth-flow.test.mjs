import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/server.mjs';

let server;
before(async () => { server = await startTestServer(); }, { timeout: 45000 });
after(async () => { await server?.close(); });
const call = (path, options = {}) => fetch(`${server.origin}${path}`, { redirect: 'manual', ...options });
const post = (path, body, cookie) => call(path, { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cookieOf = (response) => response.headers.get('set-cookie')?.split(';')[0];
async function login(email) {
  const response = await post('/api/identity/auth/login', { email, password: 'fixture-password' });
  assert.equal(response.status, 200, await response.clone().text());
  return { cookie: cookieOf(response), body: await response.json() };
}

test('the session renews the access token with the refresh token instead of expiring', async () => {
  const { cookie } = await login('renovable@example.test');
  const before = server.state.refreshes;
  // El token del doble dura 1 s: cada pausa obliga a renovarlo.
  for (let i = 0; i < 3; i++) { await pause(1100); assert.equal((await call('/api/identity/auth/me', { headers: { Cookie: cookie } })).status, 200); }
  assert.ok(server.state.refreshes > before, 'debería haber renovado el access token');
  assert.equal(server.state.reuseDetected, false);
});

test('parallel requests share one renewal and never trigger refresh reuse detection', async () => {
  const { cookie } = await login('renovable@example.test');
  await pause(1100);
  const before = server.state.refreshes;
  const responses = await Promise.all(Array.from({ length: 6 }, () => call('/api/identity/auth/me', { headers: { Cookie: cookie } })));
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200, 200, 200]);
  assert.equal(server.state.refreshes, before + 1, 'una sola renovación para todas las peticiones');
  assert.equal(server.state.reuseDetected, false);
  assert.equal((await call('/app/inicio', { headers: { Cookie: cookie } })).status, 200);
});

test('accounts with two-step verification finish the login with a code and never see the mfa token', async () => {
  const first = await post('/api/identity/auth/login', { email: 'mfa@example.test', password: 'fixture-password' });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { mfa_required: true });
  const cookie = cookieOf(first);
  assert.equal((await call('/app/perfil', { headers: { Cookie: cookie } })).status, 303, 'sin el código no hay sesión');
  const wrong = await post('/api/identity/auth/mfa/verify', { code: '000000' }, cookie);
  assert.equal(wrong.status, 401); assert.match((await wrong.json()).detail, /Código de verificación inválido/);
  const right = await post('/api/identity/auth/mfa/verify', { code: '123456' }, cookie);
  assert.equal(right.status, 200, await right.clone().text());
  const session = cookieOf(right) ?? cookie;
  assert.equal((await right.json()).user.email, 'mfa@example.test');
  assert.equal((await call('/app/perfil', { headers: { Cookie: session } })).status, 200);
});

test('mfa verification without a pending challenge asks to log in again', async () => {
  const response = await post('/api/identity/auth/mfa/verify', { code: '123456' });
  assert.equal(response.status, 401); assert.match((await response.json()).detail, /Vuelve a iniciar sesión/);
});

test('logout also revokes the session in the auth-service', async () => {
  const { cookie } = await login('perito@example.test');
  const before = server.calls.filter((entry) => entry.path === '/api/auth/logout').length;
  assert.equal((await post('/api/identity/auth/logout', {}, cookie)).status, 204);
  assert.equal(server.calls.filter((entry) => entry.path === '/api/auth/logout').length, before + 1);
  assert.equal((await call('/api/identity/auth/me', { headers: { Cookie: cookie } })).status, 401);
});

test('auth-service messages reach the user: locked accounts and password policy', async () => {
  const locked = await post('/api/identity/auth/login', { email: 'bloqueado@example.test', password: 'fixture-password' });
  assert.equal(locked.status, 423); assert.match((await locked.json()).detail, /bloqueada/);
  const weak = await post('/api/identity/auth/reset-password', { token: 'abc', new_password: 'corta' });
  assert.equal(weak.status, 422);
  const body = await weak.json();
  assert.match(body.detail, /política/); assert.deepEqual(body.errors, ['Debe tener al menos 8 caracteres']);
});

test('the real client IP and browser are forwarded with the internal key', async () => {
  await login('perito@example.test');
  const sent = server.calls.filter((entry) => entry.path === '/api/auth/login').at(-1);
  assert.equal(sent.headers['x-internal-api-key'], 'fixture-internal-key');
  assert.ok(sent.headers['x-client-ip'], 'falta X-Client-IP');
  assert.ok(sent.headers['x-client-user-agent'], 'falta X-Client-User-Agent');
});

test('the user list gathers every page of the auth-service', async () => {
  const { cookie } = await login('administrador@example.test');
  const response = await call('/api/identity/users', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).length, server.listed.length);
  assert.ok(server.calls.some((entry) => entry.path.startsWith('/api/users/?skip=200')));
});

test('audit is limited to roles with the audit permission', async () => {
  const admin = await login('administrador@example.test');
  const allowed = await call('/api/identity/audit?action=login_success', { headers: { Cookie: admin.cookie } });
  assert.equal(allowed.status, 200); assert.equal((await allowed.json()).total, 1);
  assert.equal((await call('/app/auditoria', { headers: { Cookie: admin.cookie } })).status, 200);
  const analyst = await login('perito@example.test');
  assert.equal((await call('/api/identity/audit', { headers: { Cookie: analyst.cookie } })).status, 403);
  assert.equal((await call('/app/auditoria', { headers: { Cookie: analyst.cookie } })).status, 303);
});

test('unknown fields are rejected before reaching the auth-service', async () => {
  const { cookie } = await login('administrador@example.test');
  const response = await call('/api/identity/users/user-1', { method: 'PATCH', headers: { Origin: server.origin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ email_verified: true }) });
  assert.equal(response.status, 400);
});

test('recovery and invitation links work with the default auth-service path', async () => {
  assert.equal((await call('/reset-password?token=abc')).status, 200);
  assert.equal((await call('/restablecer?token=abc')).status, 200);
});
