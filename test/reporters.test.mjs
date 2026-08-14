// Unit tests for the reporter seam (src/reporters.mjs): spec parsing, the
// three built-ins, custom module loading, and the never-crash failure
// semantics. The webhook tests run against a real local HTTP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseReporterSpec,
  createReporter,
  _stdoutReporterForStream,
} from '../src/reporters.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'spoke-reporter-'));

// ─────────────── spec parsing ───────────────

test('parseReporterSpec: built-ins, module paths, and rejects', () => {
  assert.deepEqual(parseReporterSpec('stdout'), { type: 'stdout' });
  assert.deepEqual(parseReporterSpec(undefined), { type: 'stdout' }); // default
  assert.deepEqual(parseReporterSpec('jsonl:out/run.jsonl'), { type: 'jsonl', path: 'out/run.jsonl' });
  assert.deepEqual(parseReporterSpec('jsonl:~/runs/a.jsonl'), { type: 'jsonl', path: join(homedir(), 'runs/a.jsonl') });
  assert.deepEqual(parseReporterSpec('webhook:http://127.0.0.1:9999/hook'), { type: 'webhook', url: 'http://127.0.0.1:9999/hook' });
  assert.deepEqual(parseReporterSpec('./examples/inbox-adapter.mjs'), { type: 'module', path: './examples/inbox-adapter.mjs' });
  assert.equal(parseReporterSpec('/abs/path/custom.mjs').type, 'module');
  assert.throws(() => parseReporterSpec('jsonl:'), /needs a file path/);
  assert.throws(() => parseReporterSpec('webhook:ftp://x'), /http\(s\) URL/);
  assert.throws(() => parseReporterSpec('carrier-pigeon'), /unknown reporter spec/);
  // A bare filename is ambiguous (not clearly a path) → reject, fail loudly.
  assert.throws(() => parseReporterSpec('adapter.mjs'), /unknown reporter spec/);
});

// ─────────────── stdout ───────────────

test('stdout reporter: one JSON envelope per line with at/cid/kind/payload', () => {
  const lines = [];
  const r = _stdoutReporterForStream({ cid: 'c-9' }, { write: (s) => lines.push(s) });
  assert.equal(r.report('progress', { stage: 'started' }), true);
  assert.equal(lines.length, 1);
  const env = JSON.parse(lines[0]);
  assert.equal(env.cid, 'c-9');
  assert.equal(env.kind, 'progress');
  assert.deepEqual(env.payload, { stage: 'started' });
  assert.ok(!Number.isNaN(Date.parse(env.at)), 'at must be an ISO timestamp');
});

test('stdout reporter: a broken stream returns false, never throws', () => {
  const r = _stdoutReporterForStream({ cid: null }, { write: () => { throw new Error('EPIPE'); } });
  assert.equal(r.report('result', {}), false);
});

// ─────────────── jsonl ───────────────

test('jsonl reporter: appends envelopes, creates parent dirs', async () => {
  const file = join(tmp(), 'nested', 'dir', 'run.jsonl');
  const r = await createReporter(`jsonl:${file}`, { cid: 'c-7' });
  assert.equal(r.report('progress', { n: 1 }), true);
  assert.equal(r.report('result', { n: 2 }), true);
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => x.kind), ['progress', 'result']);
  assert.deepEqual(rows.map((x) => x.payload.n), [1, 2]);
  assert.ok(rows.every((x) => x.cid === 'c-7'));
});

// ─────────────── webhook ───────────────

test('webhook reporter: POSTs the envelope; flush drains in-flight sends', async () => {
  const got = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { got.push({ url: req.url, body: JSON.parse(body) }); res.end('ok'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  try {
    const r = await createReporter(`webhook:${url}`, { cid: 'c-3' });
    const ok = await r.report('blocker', { reason: 'timeout' });
    assert.equal(ok, true);
    await r.flush();
    assert.equal(got.length, 1);
    assert.equal(got[0].body.kind, 'blocker');
    assert.equal(got[0].body.cid, 'c-3');
    assert.deepEqual(got[0].body.payload, { reason: 'timeout' });
  } finally {
    server.close();
  }
});

test('webhook reporter: unreachable endpoint resolves false, never throws', async () => {
  // Port 9 (discard) on localhost is closed; connection is refused fast.
  const r = await createReporter('webhook:http://127.0.0.1:9/hook', { cid: 'c-4' });
  assert.equal(await r.report('progress', {}), false);
  await r.flush();
});

// ─────────────── custom modules ───────────────

test('module reporter: loads createReporter(ctx) and forwards reports', async () => {
  const r = await createReporter(fixture('echo-reporter.mjs'), { cid: 'c-5' });
  assert.equal(r.name, 'echo-fixture');
  assert.equal(r.report('result', { done: true }), true);
  const { seen } = await import(new URL('./fixtures/echo-reporter.mjs', import.meta.url));
  assert.deepEqual(seen.at(-1), { cid: 'c-5', kind: 'result', payload: { done: true } });
});

test('module reporter: module without createReporter fails loudly at startup', async () => {
  await assert.rejects(() => createReporter(fixture('bad-reporter.mjs'), {}), /must export createReporter/);
});

test('inbox-adapter example: bridges reports into a three-verb inbox CLI', async () => {
  const file = join(tmp(), 'inbox-capture.jsonl');
  const adapter = fileURLToPath(new URL('../examples/inbox-adapter.mjs', import.meta.url));
  const env = { DSH_SPOKE_INBOX_CLI: fixture('stub-inbox.mjs'), STUB_INBOX_FILE: file, PATH: process.env.PATH };
  // The stub CLI inherits this process env — inject via process.env for the spawn.
  process.env.STUB_INBOX_FILE = file;
  try {
    const r = await createReporter(adapter, { cid: 'c-6', env });
    assert.equal(r.report('progress', { stage: 'started' }), true);
    const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows, [{ cid: 'c-6', kind: 'progress', payload: { stage: 'started' } }]);
  } finally {
    delete process.env.STUB_INBOX_FILE;
  }
});

test('inbox-adapter example: refuses to send without a cid (returns false, no throw)', async () => {
  const adapter = fileURLToPath(new URL('../examples/inbox-adapter.mjs', import.meta.url));
  const r = await createReporter(adapter, { cid: undefined, env: { DSH_SPOKE_INBOX_CLI: fixture('stub-inbox.mjs') } });
  assert.equal(r.report('progress', {}), false);
});

test('inbox-adapter example: missing DSH_SPOKE_INBOX_CLI fails loudly at startup', async () => {
  const adapter = fileURLToPath(new URL('../examples/inbox-adapter.mjs', import.meta.url));
  await assert.rejects(() => createReporter(adapter, { cid: 'c-8', env: {} }), /DSH_SPOKE_INBOX_CLI/);
});
