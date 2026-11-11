import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { startTestServer } from './support/server.mjs';

// ---------- Reglas compartidas (src/domain/validation.ts) ----------
const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const asModule = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const identity = asModule(compile('../src/domain/identity.ts'));
const { RULES, USER_SCHEMA, CASE_SCHEMA, checkValue, validateFields } = await import(asModule(compile('../src/domain/validation.ts').replaceAll('"./identity"', `"${identity}"`)));
const ok = (rule, value) => checkValue(rule, value, true).error === undefined;

test('names accept only letters, including accents, ñ, compound names and apostrophes', () => {
  for (const value of ['María José', 'Núñez', "O'Brien", 'Pérez-Gómez', 'Zoë']) assert.ok(ok(RULES.personName, value), value);
  for (const value of ['Juan2', 'Ana_', '123', 'Ana  @', 'J']) assert.ok(!ok(RULES.personName, value), value);
  assert.equal(checkValue(RULES.personName, '  María   José ').value, 'María José');
});

test('numeric fields accept only digits', () => {
  assert.ok(ok(RULES.identifier, '1104567890')); assert.ok(ok(RULES.identifier, '1104567890001'));
  for (const value of ['110456789A', '11045', 'ABC-123', '110-456-7890']) assert.ok(!ok(RULES.identifier, value), value);
  assert.ok(ok(RULES.otpCode, '123 456')); assert.equal(checkValue(RULES.otpCode, '123 456').value, '123456');
  for (const value of ['12a456', '12345', 'abcdef']) assert.ok(!ok(RULES.otpCode, value), value);
});

test('phones accept digits with optional +, spaces, hyphens or parentheses', () => {
  for (const value of ['+593 99 999 9999', '0999999999', '(07) 257-1234']) assert.ok(ok(RULES.phone, value), value);
  for (const value of ['099-ABC-1234', '12345', '+593 99 999 9999 9999 9']) assert.ok(!ok(RULES.phone, value), value);
});

test('emails must have a valid shape and are normalized to lowercase', () => {
  assert.equal(checkValue(RULES.email, '  Perito@UNL.edu.ec ').value, 'perito@unl.edu.ec');
  for (const value of ['perito', 'perito@', '@unl.edu.ec', 'per ito@unl.edu.ec', 'perito@unl', 'perito@unl.e']) assert.ok(!ok(RULES.email, value), value);
});

test('case number, title, hash and role name follow their formats', () => {
  assert.equal(checkValue(RULES.caseNumber, ' fge-2026-0001 ').value, 'FGE-2026-0001');
  for (const value of ['FGE 2026', 'FGE--1', 'caso#1', 'Ñ-1']) assert.ok(!ok(RULES.caseNumber, value), value);
  assert.ok(!ok(RULES.caseTitle, '12345')); assert.ok(ok(RULES.caseTitle, 'Suplantación 2026'));
  assert.ok(ok(RULES.sha256, 'A'.repeat(64))); assert.ok(!ok(RULES.sha256, 'g'.repeat(64))); assert.ok(!ok(RULES.sha256, 'a'.repeat(63)));
  assert.ok(ok(RULES.roleName, 'PERITO_SENIOR')); assert.ok(!ok(RULES.roleName, '1PERITO')); assert.ok(!ok(RULES.roleName, 'PERITO SENIOR'));
  assert.ok(!ok(RULES.conclusions, '1234567890')); assert.ok(!ok(RULES.conclusions, 'corto'));
});

test('control characters are always rejected', () => {
  assert.match(checkValue(RULES.caseTitle, 'Caso\u0000oculto', true).error, /caracteres no permitidos/);
});

test('validateFields reports every problem and returns normalized values', () => {
  const user = validateFields({ email: 'X@Y.COM', first_name: 'Ana1', identifier: 'abc' }, USER_SCHEMA, ['email', 'role_name']);
  assert.equal(user.errors.length, 3); // nombre, identificación y rol obligatorio
  const created = validateFields({ case_number: 'caso-1', title: '  Nombre   del caso ', description: '' }, CASE_SCHEMA, ['case_number', 'title']);
  assert.deepEqual(created, { values: { case_number: 'CASO-1', title: 'Nombre del caso', description: null }, errors: [] });
  const cleared = validateFields({ phone_number: null }, USER_SCHEMA);
  assert.deepEqual(cleared, { values: { phone_number: null }, errors: [] });
});

// ---------- El servidor web rechaza el formato antes de llamar a los servicios ----------
let server;
before(async () => { server = await startTestServer(); }, { timeout: 45000 });
after(async () => { await server?.close(); });
const call = (path, options = {}) => fetch(`${server.origin}${path}`, { redirect: 'manual', ...options });
const send = (method, path, body, cookie) => call(path, { method, headers: { Origin: server.origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
async function adminCookie() {
  const response = await send('POST', '/api/identity/auth/login', { email: 'administrador@example.test', password: 'fixture-password' });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
const reached = (path) => server.calls.some((entry) => entry.path.startsWith(path));

test('a user with letters in numeric fields or digits in names never reaches the auth-service', async () => {
  const cookie = await adminCookie();
  const response = await send('POST', '/api/identity/users', { email: 'nuevo@example.test', role_name: 'PERITO', first_name: 'Ana3', identifier: '11A4567890', phone_number: 'llamar' }, cookie);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.errors.length, 3);
  assert.ok(body.errors.some((error) => /Identificación/.test(error)));
  assert.equal(reached('/api/auth/register'), false);
});

test('an invalid email is rejected for new users and on login', async () => {
  const cookie = await adminCookie();
  assert.equal((await send('POST', '/api/identity/users', { email: 'no-es-correo', role_name: 'PERITO' }, cookie)).status, 400);
  assert.equal((await send('POST', '/api/identity/auth/login', { email: 'no-es-correo', password: 'x' })).status, 400);
});

test('a new account can only be created active or pending', async () => {
  const cookie = await adminCookie();
  const before = server.calls.filter((entry) => entry.path === '/api/auth/register').length;
  for (const status of ['INACTIVO', 'SUSPENDIDO']) {
    const response = await send('POST', '/api/identity/users', { email: 'nuevo@example.test', role_name: 'PERITO', status }, cookie);
    assert.equal(response.status, 400);
    assert.match((await response.json()).detail, /activa o pendiente/);
  }
  assert.equal(server.calls.filter((entry) => entry.path === '/api/auth/register').length, before);
});

test('role names and suspension dates are checked on the server', async () => {
  const cookie = await adminCookie();
  assert.equal((await send('POST', '/api/identity/roles', { name: 'rol con espacios' }, cookie)).status, 400);
  assert.equal((await send('PATCH', '/api/identity/users/user-1/suspend', { suspended_from: '2026-12-02T00:00:00Z', suspended_until: '2026-12-01T00:00:00Z' }, cookie)).status, 400);
  assert.equal((await send('PATCH', '/api/identity/users/user-1', { email: null }, cookie)).status, 400);
});

test('case files are validated and normalized before reaching the forensic engine', async () => {
  const cookie = await adminCookie();
  const bad = await send('POST', '/api/forensics/cases', { case_number: 'caso con espacios', title: '12345' }, cookie);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).detail, /Número de caso/);
  assert.equal(reached('/api/v1/cases'), false);
  await send('POST', '/api/forensics/cases', { case_number: 'fge-2026-0001', title: ' Suplantación   en video ', description: '' }, cookie);
  const forwarded = server.calls.find((entry) => entry.path === '/api/v1/cases' && entry.method === 'POST');
  assert.deepEqual(forwarded?.body, { case_number: 'FGE-2026-0001', title: 'Suplantación en video' });
});

test('the case list forwards only bounded paging and search parameters', async () => {
  const cookie = await adminCookie();
  const page = await call('/api/forensics/cases?offset=10&limit=10&q=viral&extra=1', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const body = await page.json();
  assert.equal(body.total, server.cases.filter((item) => item.title.toLowerCase().includes('viral')).length);
  const forwarded = server.calls.filter((entry) => entry.path.startsWith('/api/v1/cases?')).at(-1).path;
  assert.equal(forwarded, '/api/v1/cases?q=viral&offset=10&limit=10');
  await call('/api/forensics/cases?offset=-5&limit=9999', { headers: { Cookie: cookie } });
  assert.equal(server.calls.filter((entry) => entry.path.startsWith('/api/v1/cases?')).at(-1).path, '/api/v1/cases?offset=0&limit=10');
  assert.equal((await call(`/api/forensics/cases?q=${'x'.repeat(101)}`, { headers: { Cookie: cookie } })).status, 400);
});
