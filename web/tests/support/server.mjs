import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  // Motor forense simulado: expedientes con evidencias y dictámenes variados (lista paginada con búsqueda).
  const verdicts = [null, 'MANIPULADO', 'SIN_MANIPULACION', 'ANTECEDENTES'];
  const cases = Array.from({ length: 23 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, case_number: `FGE-2026-${String(23 - index).padStart(4, '0')}`,
    title: ['Suplantación en videollamada', 'Video viral manipulado', 'Audio y video de extorsión', 'Perfil falso con rostro generado'][index % 4] + ` ${23 - index}`,
    description: index % 3 ? 'Denuncia recibida por la unidad de delitos informáticos; evidencia entregada en memoria USB.' : null,
    created_at: new Date(Date.UTC(2026, 10, 10 - index)).toISOString(), evidences: index % 5 === 4 ? 0 : 1 + (index % 2), verdict: index % 5 === 4 ? null : verdicts[index % 4],
  }));
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
    const raw = Buffer.concat(chunks).toString();
    const body = raw && (request.headers['content-type'] ?? '').startsWith('application/json') ? JSON.parse(raw) : {};
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
    if (path === '/api/v1/cases' && request.method === 'GET') {
      const term = (url.searchParams.get('q') ?? '').toLowerCase();
      const offset = Number(url.searchParams.get('offset') ?? 0); const limit = Number(url.searchParams.get('limit') ?? 10);
      const matched = cases.filter((item) => !term || item.case_number.toLowerCase().includes(term) || item.title.toLowerCase().includes(term));
      return send(response, 200, { items: matched.slice(offset, offset + limit), total: matched.length, offset, limit });
    }
    // Flujo de análisis de un expediente (resumen → encolar → estado → informe PDF → revisión final).
    const caseRoute = /^\/api\/v1\/cases\/([0-9a-f-]{36})\/(summary|analyze-async|artifacts\/([0-9a-f-]{36})\/download|reports\/([0-9a-f-]{36})\/finalize)$/.exec(path);
    const uid = (n) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
    if (caseRoute) {
      const [, caseId, action, artifactId] = caseRoute;
      const found = cases.find((item) => item.id === caseId);
      if (!found) return send(response, 404, { detail: 'Expediente no encontrado' });
      if (action === 'summary') return send(response, 200, { id: found.id, case_number: found.case_number, title: found.title, created_at: found.created_at,
        evidences: [{ id: uid(1), file_name: 'videollamada.mp4', sha256: 'a'.repeat(64), report: null }], audit: [] });
      if (action === 'analyze-async') return send(response, 202, { status: 'queued', job_id: uid(9), case_id: caseId, evidence_id: uid(1), poll_after_ms: 2000, mode: 'local' });
      if (action.endsWith('/finalize')) return send(response, 201, { case_id: caseId, evidence_id: uid(1), report_id: uid(2), objects: [{ id: uid(4), kind: 'pdf', sha256: 'c'.repeat(64), size_bytes: 1 }], retention_verified: true });
      // Informe: el PDF real si se indica uno (TEST_REPORT_PDF), si no, un PDF mínimo válido.
      const pdf = process.env.TEST_REPORT_PDF ? readFileSync(process.env.TEST_REPORT_PDF)
        : Buffer.from(['%PDF-1.4', '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj', 'trailer<</Root 1 0 R>>', '%%EOF'].join('\n'));
      state.downloads = (state.downloads ?? 0) + 1; state.lastArtifact = artifactId;
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="pdf-${artifactId}.pdf"` });
      return response.end(pdf);
    }
    if (path === `/api/v1/jobs/00000000-0000-4000-a000-000000000009`) {
      state.polls = (state.polls ?? 0) + 1;
      if (state.polls < 2) return send(response, 200, { status: 'processing', job_id: uid(9), poll_after_ms: 2000, progress: { stage: 'inference', message: 'Fotograma 12 de 24', current: 12, total: 24, events: [{ id: 'e1', message: 'Ejecutando los modelos sobre los fotogramas', timestamp: new Date().toISOString() }] } });
      return send(response, 200, { status: 'completed', job_id: uid(9), result: { report_id: uid(2), prediction: 'Fake', verdict_forensic: 'MANIPULADO', confidence: 91.4, frames_analyzed: 24, faces_detected: 24,
        archive: { case_id: cases[0].id, evidence_id: uid(1), report_id: uid(2), objects: [{ id: uid(3), kind: 'pdf', sha256: 'b'.repeat(64), size_bytes: 1 }] } } });
    }
    if (path === '/api/v1/cases' && request.method === 'POST') {
      const created = { id: `00000000-0000-4000-9000-${String(cases.length + 1).padStart(12, '0')}`, case_number: body.case_number, title: body.title };
      cases.unshift({ ...created, description: body.description ?? null, created_at: new Date().toISOString(), evidences: 0, verdict: null });
      return send(response, 201, created);
    }
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
  return { origin, mockOrigin, users, listed, cases, calls, state, close, logs: () => log };
}
