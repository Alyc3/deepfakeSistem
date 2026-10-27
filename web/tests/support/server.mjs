import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

export async function startTestServer() {
  // Solo fixtures de prueba; la aplicación nunca carga estos datos.
  const roleNames = ['ADMINISTRADOR', 'PERITO', 'INVITADO', 'NO_MAPEADO'];
  const roles = roleNames.map((name, index) => ({ id: `role-${index}`, name, description: `Acceso ${name.toLowerCase()}` }));
  const users = roles.map((role, index) => ({ id: `user-${index}`, email: `${role.name.toLowerCase()}@example.test`, first_name: ['Alex', 'Sam', 'Dani', 'Robin'][index], last_name: 'Prueba', status: 'ACTIVO', identifier: `TEST-${index}`, role }));
  const calls = [];
  const mock = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString(); const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: request.url, method: request.method });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/auth/login') {
      const user = users.find((user) => user.email === body.email);
      if (!user || body.password !== 'fixture-password') { response.writeHead(401); response.end('{}'); return; }
      response.end(JSON.stringify({ access_token: `private-fixture-token-${user.id}`, token_type: 'bearer' })); return;
    }
    if (['/api/auth/password-recovery','/api/auth/reset-password'].includes(request.url)) { response.end('{}'); return; }
    const user = users.find((user) => request.headers.authorization === `Bearer private-fixture-token-${user.id}`);
    if (request.url === '/health/live') { response.end('{"status":"ok"}'); return; }
    if (!user) { response.writeHead(401); response.end('{}'); return; }
    if (request.url === '/api/auth/me') response.end(JSON.stringify(user));
    else if (request.url === '/api/users/') response.end(JSON.stringify(users));
    else if (request.url === '/api/roles/') response.end(JSON.stringify(roles));
    else { response.writeHead(404); response.end('{}'); }
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
  const origin = `http://localhost:${port}`;
  const policy = { ADMINISTRADOR: ['laboratory','users','roles','profile','security'], PERITO: ['laboratory','profile','security'], INVITADO: ['profile','security'] };
  const child = spawn(process.execPath, ['tests/support/astro-server.mjs'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), windowsHide: true,
    env: { ...process.env, TEST_APP_PORT: String(port), NODE_ENV: 'development', AUTH_SERVICE_URL: mockOrigin, CERTIFACE_API_URL: mockOrigin, APP_ORIGIN: origin, ROLE_PERMISSIONS: JSON.stringify(policy), DEFAULT_PERMISSIONS: '["profile","security"]' },
    stdio: ['ignore','pipe','pipe'],
  });
  let log = ''; child.stdout.on('data', (data) => log += data); child.stderr.on('data', (data) => log += data);
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`${origin}/login`)).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) { child.kill(); mock.close(); throw new Error(`Servidor de pruebas no disponible. ${log.slice(-2000)}`); }
  return { origin, users, calls, async close() { child.kill(); await new Promise((resolve) => mock.close(resolve)); }, logs: () => log };
}
