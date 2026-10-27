import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`;
const settings = moduleUrl(readFileSync(new URL('../src/domain/settings.ts', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/infrastructure/http/http-forensics-api.ts', import.meta.url), 'utf8').replace('"@domain/settings"', JSON.stringify(settings));
const { createHttpForensicsApi } = await import(moduleUrl(source));
globalThis.window = new EventTarget();
const file = { name: 'fixture.jpg', mime: 'image/jpeg', kind: 'image', size: 4, blob: new File(['test'], 'fixture.jpg', { type: 'image/jpeg' }) };

test('declared reception hash reaches the server instead of being silently replaced', async () => {
  const expected = 'a'.repeat(64);
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.body.get('expected_sha256'), expected);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers?.Authorization, undefined);
    return Response.json({ prediction: 'Real', archive: { retention_verified: true } });
  };
  const result = await createHttpForensicsApi(() => '/api/forensics', () => true).analyze({ ...file, expectedSha256: expected });
  assert.equal(result.ok, true);
});
test('a failed preservation is never presented as a completed analysis', async () => {
  globalThis.fetch = async () => Response.json({ detail: 'Archivo no confirmado' }, { status: 503 });
  const result = await createHttpForensicsApi(() => '/api/forensics', () => true).analyze(file);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Archivo no confirmado');
});
test('human conclusions are sent through the authenticated BFF as a new revision', async () => {
  const archive = { case_id: 'case-test', report_id: 'report-test', objects: [] };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/forensics/cases/case-test/reports/report-test/finalize');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(options.body), { expert_conclusions: 'Reviewed' });
    return Response.json(archive);
  };
  const result = await createHttpForensicsApi(() => '/api/forensics', () => true).finalizeReport(archive, 'Reviewed');
  assert.equal(result.ok, true);
});
test('an unauthenticated browser does not submit evidence', async () => {
  globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
  assert.equal((await createHttpForensicsApi(() => '/api/forensics', () => false).analyze(file)).ok, false);
});
