import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Doble del auth-service con su contrato real: tokens con refresh rotativo, MFA, bloqueo y paginación.
export async function startTestServer() {
  // Solo fixtures de prueba; la aplicación nunca carga estos datos.
  const roleNames = ['ADMINISTRADOR', 'PERITO', 'INVITADO', 'NO_MAPEADO'];
  const roles = roleNames.map((name, index) => ({ id: `role-${index}`, name, description: `Acceso ${name.toLowerCase()}` }));
  const person = (id, email, role, extra = {}) => ({ id, email, first_name: 'Persona', last_name: 'Prueba', status: 'ACTIVO', identifier: `TEST-${id}`, role, mfa_enabled: false, ...extra });
  const users = roles.map((role, index) => person(`user-${index}`, `${role.name.toLowerCase()}@example.test`, role));
  users.push(person('user-mfa', 'mfa@example.test', roles[1], { mfa_enabled: true }));
  users.push(person('user-renew', 'renovable@example.test', roles[0]));
  users.push(person('user-locked', 'bloqueado@example.test', roles[1]));
  // Relleno para comprobar que el listado reúne todas las páginas del auth-service (máximo 200 por página).
  const listed = [...users, ...Array.from({ length: 250 }, (_, index) => person(`bulk-${index}`, `bulk${index}@example.test`, roles[2]))];
  const calls = [];
  const state = { reuseDetected: false, refreshes: 0 };
  const access = new Map(); // access token -> { user, session }
  const refresh = new Map(); // refresh token -> { user, session, used }
  const revoked = new Set();
  let counter = 0;
  const issue = (user, session = `sid-${++counter}`) => {
    const n = ++counter;
    const pair = { access_token: `private-fixture-token-${user.id}-${n}`, refresh_token: `private-refresh-${user.id}-${n}`, token_type: 'bearer',
      expires_in: user.id === 'user-renew' ? 1 : 900, refresh_expires_in: 604800 };
    access.set(pair.access_token, { user, session }); refresh.set(pair.refresh_token, { user, session, used: false });
    return pair;
  };
  const send = (response, status, body, headers = {}) => { response.writeHead(status, { 'Content-Type': 'application/json', ...headers }); response.end(body === undefined ? '' : JSON.stringify(body)); };
  const mock = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString(); const body = raw ? JSON.parse(raw) : {};
    const url = new URL(request.url, 'http://mock'); const path = url.pathname;
    calls.push({ path: request.url, method: request.method, headers: request.headers, body });
    if (path === '/health/live') return send(response, 200, { status: 'ok' });
    if (path === '/api/auth/login') {
      const user = users.find((candidate) => candidate.email === body.email);
      if (user?.id === 'user-locked') return send(response, 423, { detail: 'Cuenta bloqueada temporalmente. Intenta de nuevo más tarde.' });
      if (!user || body.password !== 'fixture-password') return send(response, 401, { detail: 'Credenciales inválidas' });
      if (user.mfa_enabled) return send(response, 200, { mfa_required: true, mfa_token: `private-mfa-${user.id}`, token_type: 'mfa' });
      return send(response, 200, issue(user));
    }
    if (path === '/api/auth/mfa/verify') {
      if (body.mfa_token !== 'private-mfa-user-mfa') return send(response, 401, { detail: 'mfa_token inválido o expirado' });
      if (body.code !== '123456') return send(response, 401, { detail: 'Código de verificación inválido' });
      return send(response, 200, issue(users.find((user) => user.id === 'user-mfa')));
    }
    if (path === '/api/auth/refresh') {
      const entry = refresh.get(body.refresh_token);
      if (!entry || revoked.has(entry.session)) return send(response, 401, { detail: 'Refresh token inválido' });
      if (entry.used) { state.reuseDetected = true; revoked.add(entry.session); return send(response, 401, { detail: 'Refresh token inválido' }); }
      entry.used = true; state.refreshes++;
      return send(response, 200, issue(entry.user, entry.session));
    }
    if (path === '/api/auth/password-recovery') return send(response, 200, { message: 'ok' });
    if (path === '/api/auth/reset-password') {
      if (body.new_password === 'corta') return send(response, 422, { detail: { message: 'La contraseña no cumple la política', errors: ['Debe tener al menos 8 caracteres'] } });
      return send(response, 200, { message: 'ok' });
    }
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
    const current = access.get(token);
    if (!current || revoked.has(current.session)) return send(response, 401, { detail: 'SESSION_INVALIDATED' });
    const { user } = current;
    if (path === '/api/auth/logout') { revoked.add(current.session); return send(response, 204); }
    if (path === '/api/auth/me') return send(response, 200, user);
    if (path === '/api/users/') {
      const skip = Number(url.searchParams.get('skip') ?? 0); const limit = Number(url.searchParams.get('limit') ?? 50);
      return send(response, 200, listed.slice(skip, skip + limit), { 'X-Total-Count': String(listed.length) });
    }
    if (path === '/api/roles/') return send(response, 200, roles);
    if (path === '/api/audit-logs/') return send(response, 200, [{ id: 'log-1', user_id: user.id, action: 'login_success', created_at: new Date().toISOString() }], { 'X-Total-Count': '1' });
    return send(response, 404, { detail: 'No encontrado' });
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
  const origin = `http://localhost:${port}`;
  const policy = { ADMINISTRADOR: ['laboratory','users','roles','audit','profile','security'], PERITO: ['laboratory','profile','security'], INVITADO: ['profile','security'] };
  // Caché de Vite y sesiones de cada servidor de prueba en una carpeta temporal que se borra al cerrar.
  const runtime = mkdtempSync(join(tmpdir(), 'certiface-test-'));
  const child = spawn(process.execPath, ['tests/support/astro-server.mjs'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), windowsHide: true,
    env: { ...process.env, TEST_APP_PORT: String(port), TEST_RUNTIME_DIR: runtime, SESSION_DIR: join(runtime, 'sessions'),
      NODE_ENV: 'development', AUTH_SERVICE_URL: mockOrigin, CERTIFACE_API_URL: mockOrigin, APP_ORIGIN: origin,
      AUTH_INTERNAL_API_KEY: 'fixture-internal-key', FORENSICS_API_OVERRIDE: 'true', ROLE_PERMISSIONS: JSON.stringify(policy), DEFAULT_PERMISSIONS: '["profile","security"]' },
    stdio: ['ignore','pipe','pipe'],
  });
  let log = ''; child.stdout.on('data', (data) => log += data); child.stderr.on('data', (data) => log += data);
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`${origin}/login`)).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  async function close() {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await new Promise((resolve) => mock.close(resolve));
    rmSync(runtime, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  if (!ready) { await close(); throw new Error(`Servidor de pruebas no disponible. ${log.slice(-2000)}`); }
  return { origin, mockOrigin, users, listed, calls, state, close, logs: () => log };
}
