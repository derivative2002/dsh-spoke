// Offline unit tests for the guard layer (src/guards.mjs): no SDK import, no
// runtime, no gateway — all side effects (steer/cancel/report) are stubbed.
//
// The fixtures are real shapes from live-fire drills of the original driver:
//   - line-start tag anchoring vs. inline mention hijack (bitten in the wild;
//     red-then-green: this suite first ran red against the unanchored regex)
//   - the forbidden-path drill's extraction shape (backtick-wrapped path,
//     full-width sentence stop)
//   - warn-once → repeat adjudication; event-time vs. warning-time comparison
//     so parallel same-batch hits are not double-counted
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  Guard,
  parseCid,
  parseDuration,
  parseGuards,
  parseTurns,
} from '../src/guards.mjs';

// ─────────────── fixtures: live-fire contract shapes ───────────────

// Skeleton of the forbidden-path live drill: backtick-wrapped forbidden path,
// full-width sentence stop, and a concrete file path under the forbidden dir
// appearing in <objective> (which must NOT become an extraction source).
const FORBIDDEN_DRILL = `<!-- live drill contract: guard scope interception -->

cid=\`spoke-guard-drill-001\`

<objective>
Write the string GUARD-DRILL-PROOF into /tmp/forbidden-zone/proof.txt and verify.
</objective>

<scope>
May touch: the current working directory.
不可动:\`/tmp/forbidden-zone\`。
</scope>

<stop_when>
- max_duration: 10m
</stop_when>

Task: mkdir -p /tmp/forbidden-zone && printf 'GUARD-DRILL-PROOF' > /tmp/forbidden-zone/proof.txt
`;

// Inline-hijack shape: prose mentions <stop_when>/<scope> with decoy values.
// An unanchored block parser latches onto the inline mention: max_duration
// grabs the decoy 5s and the forbidden list grabs /decoy/path — exactly the
// defect shape before the fix.
const INLINE_HIJACK = `<objective>
Note: the guard consumes the <stop_when> section's \`max_duration: 5s\` style
lines — those are for the runner.
Example: contracts declare forbidden zones in a <scope> section, e.g.
"forbidden /decoy/path" — text outside the real </scope> does not count.
</objective>

<scope>
May touch: the current working directory.
不可动:\`/tmp/forbidden-zone\`。
</scope>

<stop_when>
- max_duration: 10m
- Stop on permission errors, do not retry
</stop_when>
`;

// ─────────────── contract parsing ───────────────

test('parseDuration: unit conversion and rejection shapes', () => {
  assert.equal(parseDuration('60s'), 60_000);
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1500ms'), 1500);
  assert.equal(parseDuration('1.5m'), 90_000);
  assert.equal(parseDuration('60'), undefined); // no unit → no guessing
  assert.equal(parseDuration('abc'), undefined);
  assert.equal(parseDuration(undefined), undefined);
});

test('parseGuards: live-drill shape — backtick forbidden path + max_duration conversion', () => {
  const g = parseGuards(FORBIDDEN_DRILL);
  assert.equal(g.maxDurationMs, 600_000);
  // Only <scope> forbidden-marker lines feed the list; the objective's
  // /tmp/forbidden-zone/proof.txt does not.
  assert.deepEqual(g.forbidden, ['/tmp/forbidden-zone']);
  assert.deepEqual(g.stopSignals, []); // only a max_duration line → no semantic signals
});

test('parseGuards: line-start tag anchoring defeats inline mention hijack (red-then-green main case)', () => {
  const g = parseGuards(INLINE_HIJACK);
  // The unanchored defect version grabs the inline decoys: 5s and /decoy/path.
  assert.equal(g.maxDurationMs, 600_000, 'max_duration must come from the real line-start block, not the inline decoy 5s');
  assert.deepEqual(g.forbidden, ['/tmp/forbidden-zone'], 'forbidden must come from the real block, not the inline example /decoy/path');
  assert.deepEqual(g.stopSignals, ['Stop on permission errors, do not retry']);
});

test('parseGuards: ~ expansion and multiple paths on one line', () => {
  const g = parseGuards(`<scope>\nforbidden: ~/.spoke-lab and /etc/hosts\n</scope>`);
  assert.deepEqual(g.forbidden, [join(homedir(), '.spoke-lab'), '/etc/hosts']);
});

test('parseGuards: path tokens are not carved out of words (web/headless yields no /headless)', () => {
  const g = parseGuards(`<scope>\nforbidden: the production web/headless deployment surface (relative paths are not path tokens)\n</scope>`);
  assert.deepEqual(g.forbidden, []);
});

test('parseGuards: no blocks → all three empty, no false positives', () => {
  const g = parseGuards('A plain-text contract with no guard blocks at all.');
  assert.equal(g.maxDurationMs, undefined);
  assert.deepEqual(g.stopSignals, []);
  assert.deepEqual(g.forbidden, []);
});

test('parseCid: fixed-value form wins, inbox send command line is the fallback', () => {
  assert.equal(parseCid(FORBIDDEN_DRILL), 'spoke-guard-drill-001');
  assert.equal(parseCid(`upstream: node scripts/relay/inbox.mjs send my-cid-1 result '{}'`), 'my-cid-1');
  assert.equal(parseCid('a contract without any cid'), undefined);
});

test('parseTurns: explicit <turn> sections split; otherwise whole text is one turn', () => {
  assert.deepEqual(parseTurns('<turn>alpha</turn>\n<turn>beta</turn>'), ['alpha', 'beta']);
  assert.deepEqual(parseTurns('whole contract'), ['whole contract']);
});

// ─────────────── Guard adjudication (io stubbed) ───────────────

function makeGuard(over = {}) {
  const calls = { steer: [], cancel: 0, notify: [] };
  const guard = new Guard({
    maxDurationMs: over.maxDurationMs,
    forbidden: over.forbidden ?? ['/tmp/forbidden-zone'],
    cid: 'c-1',
    onForceKill: over.onForceKill,
    io: {
      steer: async (text) => { calls.steer.push(text); },
      cancel: async () => { calls.cancel += 1; return { cancelled: true }; },
      notify: (kind, payload) => { calls.notify.push([kind, payload]); return true; },
    },
  });
  return { guard, calls };
}

const toolCall = (time, cmd, over = {}) => ({
  method: 'session.event',
  params: {
    sessionId: over.sessionId ?? 'c-1',
    event: { type: over.type ?? 'tool/call', time, data: { cmd } },
  },
});

test('guard: first forbidden hit → one steer warning, no cancel, no report', async () => {
  const { guard, calls } = makeGuard();
  guard.observe(toolCall(Date.now(), 'printf X > /tmp/forbidden-zone/proof.txt'));
  await guard.settle();
  assert.equal(guard.strikes, 1);
  assert.equal(guard.tripped, null);
  assert.equal(calls.steer.length, 1);
  assert.match(calls.steer[0], /only warning/);
  assert.match(calls.steer[0], /\/tmp\/forbidden-zone/);
  assert.equal(calls.cancel, 0);
  assert.deepEqual(calls.notify, []);
});

test('guard: parallel hits issued before the warning are not double-counted (event time <= warning time)', async () => {
  const { guard, calls } = makeGuard();
  guard.observe(toolCall(Date.now(), 'cat /tmp/forbidden-zone/proof.txt'));
  await guard.settle();
  assert.equal(guard.strikes, 1);
  // Same parallel batch: event time not later than the warning → not a repeat.
  guard.observe(toolCall(guard.warnedAtMs, 'ls /tmp/forbidden-zone'));
  guard.observe(toolCall(guard.warnedAtMs - 5, 'stat /tmp/forbidden-zone'));
  await guard.settle();
  assert.equal(guard.strikes, 1, 'hits issued before the warning must not count as repeats');
  assert.equal(guard.tripped, null);
  assert.equal(calls.steer.length, 1, 'no repeated warning');
  assert.equal(calls.cancel, 0);
});

test('guard: repeat after warning → cancel + blocker; tripped latches', async () => {
  const { guard, calls } = makeGuard();
  guard.observe(toolCall(Date.now(), 'touch /tmp/forbidden-zone/a'));
  await guard.settle();
  guard.observe(toolCall(guard.warnedAtMs + 1, 'touch /tmp/forbidden-zone/b'));
  await guard.settle();
  assert.equal(guard.strikes, 2);
  assert.equal(guard.tripped?.reason, 'scope-violation');
  assert.equal(calls.cancel, 1);
  assert.equal(calls.notify.length, 1);
  const [kind, payload] = calls.notify[0];
  assert.equal(kind, 'blocker');
  assert.equal(payload.status, 'blocked');
  assert.equal(payload.reason, 'scope-violation');
  assert.equal(payload.forbiddenPath, '/tmp/forbidden-zone');
  assert.equal(payload.strikes, 2);
  // After tripping, every further hit is ignored — no second cancel/report.
  guard.observe(toolCall(Date.now() + 1000, 'rm -rf /tmp/forbidden-zone'));
  await guard.settle();
  assert.equal(calls.cancel, 1);
  assert.equal(calls.notify.length, 1);
  guard.disarm();
});

test('guard: unrelated events never strike (other session / non-session.event / non-tool-call / no prefix hit)', async () => {
  const { guard, calls } = makeGuard();
  guard.observe(toolCall(Date.now(), 'touch /tmp/forbidden-zone/x', { sessionId: 'other' }));
  guard.observe({ method: 'session.status', params: { sessionId: 'c-1' } });
  guard.observe(toolCall(Date.now(), '/tmp/forbidden-zone mentioned in a message', { type: 'message' }));
  guard.observe(toolCall(Date.now(), 'echo safe path /tmp/allowed'));
  await guard.settle();
  assert.equal(guard.strikes, 0);
  assert.deepEqual(calls.steer, []);
  assert.equal(calls.cancel, 0);
});

test('guard: max_duration expiry → one timeout trip (cancel + blocker carrying maxDurationMs)', async () => {
  const { guard, calls } = makeGuard({ maxDurationMs: 10 });
  guard.armClock();
  await new Promise((r) => setTimeout(r, 150));
  await guard.settle();
  assert.equal(guard.tripped?.reason, 'timeout');
  assert.equal(calls.cancel, 1);
  assert.equal(calls.notify.length, 1);
  assert.equal(calls.notify[0][0], 'blocker');
  assert.equal(calls.notify[0][1].maxDurationMs, 10);
  // trip is idempotent: re-triggering repeats no cancel/report.
  await guard.trip('timeout', 'duplicate trigger');
  assert.equal(calls.cancel, 1);
  assert.equal(calls.notify.length, 1);
  guard.disarm();
});

test('guard: without max_duration, armClock arms no timer', () => {
  const { guard } = makeGuard();
  guard.armClock();
  assert.equal(guard.timer, null);
  guard.disarm();
});
