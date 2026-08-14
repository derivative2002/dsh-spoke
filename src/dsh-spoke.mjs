#!/usr/bin/env node
/**
 * dsh-spoke — a governed execution seat for DSH.
 *
 *   contract in (file) → official SDK drives a resident runtime, multi-turn →
 *   guardrails enforce stop_when/scope at the runner layer → evidence out
 *   (progress | blocker | result) through a pluggable reporter.
 *
 * Architecture (why this shape — see docs and the NOTES at end of file):
 *   one DSH process mounts two faces — the SDK's stdio JSON-RPC face drives
 *   the multi-turn loop, the HTTP face takes mid-run corrections (steer) and
 *   hard stops (cancel). Both faces share the same live agent (verified).
 *
 * Usage:
 *   dsh-spoke.mjs run <contract.md> [--cid X] [--port N] [--reporter SPEC] [--keep-alive] [--event-log F]
 *   dsh-spoke.mjs parse <contract.md> [--cid X]   # dry run: parse only, no runtime
 *   dsh-spoke.mjs steer "<correction>" [--port N] [--cid X]
 *   dsh-spoke.mjs status [--port N]
 *
 * Dependencies: @deepseek-ai/dsh-sdk-client + @deepseek-ai/dsh-sdk-jsonrpc-server
 *   (pinned in package.json; `npm i` once at the repo root). The offline unit
 *   tests (test/) cover guards.mjs and reporters.mjs without them.
 *
 * Environment:
 *   DSH_HOME             seat directory (one per seat), default ~/.dsh-spoke/home
 *   DSH_SPOKE_REPORTER   upstream channel: stdout | jsonl:<path> | webhook:<url>
 *                        | <path/to/module.mjs>  (default stdout; --reporter wins)
 *   DSH_SPOKE_BASE_URL   OpenAI-compatible gateway base URL,
 *                        default http://127.0.0.1:8000/v1
 *   DSH_SPOKE_API_KEY    API key for that gateway (read by the runtime;
 *                        pass via environment, never commit it anywhere)
 *   DSH_SPOKE_PORT       HTTP face port, default 8098 (--port wins)
 *   DSH_SPOKE_MODEL      model id, default deepseek-v4-flash
 *   DSH_SPOKE_PROVIDER   provider id, default gateway
 *
 * Guardrails (the runner consumes the contract's <stop_when> / <scope>; pure
 * logic lives in guards.mjs):
 *   The contract text is fed to the model verbatim; guards run at the runner
 *   layer and do not depend on the model's cooperation —
 *   - <stop_when>'s max_duration (e.g. `max_duration: 60s`) → wall-clock hard
 *     limit; on expiry the HTTP face session.cancel stops the current turn and
 *     a blocker goes upstream.
 *   - <scope> lines carrying a forbidden marker (不可动/forbidden/禁) yield a
 *     forbidden-path prefix list. A tool call hitting a prefix gets ONE steer
 *     warning; a repeat after the warning → session.cancel + blocker.
 *   Known boundaries (deliberate — this is not a perfect sandbox):
 *   - Prefix matching treats the tool-call argument JSON as a string; for
 *     forbidden paths containing spaces/quotes the longest space-free prefix
 *     applies. Detection happens after the tool-call event surfaces, so the
 *     first violation's side effect may already have landed (the semantics are
 *     detect-and-stop, not pre-execution interception).
 *   - stop_when lines other than max_duration are semantic conditions; the
 *     runner does not adjudicate them, it parses and relays them with the
 *     started progress so the supervisor can reconcile. Their force on the
 *     model still comes from the contract text itself.
 *   --event-log F: append every SDK notification during run as JSON lines
 *     (live-fire evidence).
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, symlinkSync, unlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { Guard, parseCid, parseGuards, parseTurns, truncate } from "./guards.mjs";
import { createReporter } from "./reporters.mjs";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE = "spoke";
const DEFAULT_PORT = 8098;

// ─────────────────────── seat bootstrap (make the seat dispatchable) ───────────────────────

/**
 * Ensure $DSH_HOME/profiles/spoke exists. Idempotent: existing files are
 * validated, not overwritten. A spoke profile = dsh-base + the SDK stdio face
 * + the HTTP steer face; deliberately WITHOUT dsh-web-app (its web runtime
 * prints a URL to stdout, which corrupts the SDK's JSON-RPC protocol frames).
 */
function ensureProfile(dshHome) {
  const dir = join(dshHome, "profiles", PROFILE);
  const manifest = join(dir, "package.json");
  mkdirSync(join(dir, "node_modules", "@deepseek-ai"), { recursive: true });

  if (!existsSync(manifest)) {
    writeFileSync(manifest, JSON.stringify({
      name: `dsh-profile-${PROFILE}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
    }, null, 2) + "\n");
  }

  // The SDK server is an out-of-tree plugin installed under this repo's
  // node_modules; it must be linked into the profile to be resolvable.
  const link = join(dir, "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-server");
  const target = resolve(SELF_DIR, "..", "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-server");
  if (!existsSync(target)) {
    die(`missing @deepseek-ai/dsh-sdk-jsonrpc-server. Run at the repo root:\n  npm i`);
  }
  // unlinkSync removes a symlink whether it points at a file or a directory;
  // rmSync fails on symlink→directory (bitten on second warm-seat start:
  // a silently swallowed error there crashes symlinkSync with EEXIST).
  try { unlinkSync(link); } catch {}
  symlinkSync(target, link, "dir");

  const patch = join(dir, "cordis.patch.yml");
  if (!existsSync(patch)) writeFileSync(patch, SPOKE_PATCH);
  return dir;
}

const SPOKE_PATCH = `# dsh-spoke seat profile — generated by dsh-spoke.mjs.
# Two faces in one process: the SDK stdio face runs the turns, the HTTP face steers.
# No @deepseek-ai/dsh-web-app: its web runtime prints "dsh web: http://..." on
# stdout, while sdk-jsonrpc-server reserves stdout for protocol frames.
- id: hmr
  disabled: true
- id: llm-pi-ai
  config:
    providers:
      gateway:
        displayName: OpenAI-compatible Gateway
        apiKeyEnv: DSH_SPOKE_API_KEY
        api: openai-completions
        baseURL: !!js process.env.DSH_SPOKE_BASE_URL ?? 'http://127.0.0.1:8000/v1'
        defaultContextWindow: 131072
        defaultMaxTokens: 8192
        models:
          # Model comes from DSH_SPOKE_MODEL — switching tiers edits no file.
          - id: !!js process.env.DSH_SPOKE_MODEL ?? 'deepseek-v4-flash'
            contextWindow: 131072
            maxTokens: 8192
- id: agent-default-model
  config:
    provider: !!js process.env.DSH_SPOKE_PROVIDER ?? 'gateway'
    model: !!js process.env.DSH_SPOKE_MODEL ?? 'deepseek-v4-flash'
- insert:
    # ── SDK stdio face: multi-turn driving ──
    - id: sdk-jsonrpc-server
      name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
    # ── HTTP face: steer/cancel. Every line below is a required link in the
    #    apiproxy activation chain ──
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
    - id: directory-picker
      name: '@deepseek-ai/dsh-host-directory-picker-auto'
    - id: plugin-inventory
      name: '@deepseek-ai/dsh-host-plugin-inventory'
    - id: session-projection-cache
      name: '@deepseek-ai/dsh-session-projection-cache'
      config:
        writeEveryEvents: 200
        writeIntervalMs: 5000
    - id: session-stats
      name: '@deepseek-ai/dsh-session-stats'
    - id: api-gateway
      name: '@deepseek-ai/dsh-host-apiproxy'
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        host: 127.0.0.1
        port: !!js Number(process.env.DSH_SPOKE_PORT ?? 8098)
    - id: connection
      name: '@deepseek-ai/dsh-client-connection'
      config:
        trustedHosts: []
    - id: api-remotes
      name: '@deepseek-ai/dsh-api-remotes'
`;

// ─────────────────────────── HTTP face ───────────────────────────

async function api(port, method, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: `spoke-${Date.now()}`, method, payload }),
  });
  const body = await res.json();
  if (body?.result?.ok === false) {
    throw new Error(`${method}: ${body.result.error?.message ?? "unknown"}`);
  }
  return body?.result?.value;
}

// ─────────────────────────── actions ───────────────────────────

/**
 * Retry initialize inside the same child process until the llm face has
 * registered its provider. Only "no adapter registered" (the race signature)
 * is swallowed; other errors rethrow. After success, harness.start()'s
 * memoized initialize sends the same call once more — server-side initialize
 * just sets fields and looks up the adapter, so re-entry is harmless.
 */
async function initializeWithRetry(harness, { provider, model }, { tries = 30, delayMs = 1000 } = {}) {
  harness.client.start();
  for (let i = 1; ; i++) {
    try {
      await harness.client.initialize({ cwd: process.cwd(), provider, model });
      if (i > 1) console.error(`[spoke] llm face ready (initialize passed on attempt ${i})`);
      return;
    } catch (e) {
      if (!/no adapter registered/.test(String(e?.message)) || i >= tries) throw e;
      if (i === 1) console.error(`[spoke] llm face not ready (no adapter), retrying initialize in-process…`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function cmdRun(args) {
  const file = args._[0];
  if (!file) die("run needs a contract file path");
  const port = Number(args.port ?? process.env.DSH_SPOKE_PORT ?? DEFAULT_PORT);
  const text = readFileSync(resolve(file), "utf8");
  const cid = args.cid ?? parseCid(text);
  const turns = parseTurns(text);

  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh-spoke", "home");
  process.env.DSH_HOME = dshHome;
  ensureProfile(dshHome);

  // Upstream channel: --reporter wins, then DSH_SPOKE_REPORTER, then stdout.
  const reporter = await createReporter(args.reporter ?? process.env.DSH_SPOKE_REPORTER ?? "stdout", { cid });
  const report = (kind, payload) => {
    const r = reporter.report(kind, payload);
    Promise.resolve(r).then((ok) => {
      console.error(`[spoke] ↑ ${kind} ${ok ? "sent" : "FAILED"} via ${reporter.name}`);
    });
    return r;
  };

  console.error(`[spoke] seat=${dshHome}`);
  console.error(`[spoke] contract=${file} cid=${cid ?? "(none)"} turns=${turns.length} port=${port} reporter=${reporter.name}`);
  if (!cid) console.error(`[spoke] ⚠ no cid parsed from the contract; envelopes carry cid=null (use --cid to set one)`);

  const provider = process.env.DSH_SPOKE_PROVIDER ?? "gateway";
  const model = process.env.DSH_SPOKE_MODEL ?? "deepseek-v4-flash";
  const harness = new DeepSeekHarness({
    launch: {
      command: "dsh",
      args: ["--profile", PROFILE],
      env: { ...process.env, DSH_SPOKE_PORT: String(port) },
    },
    provider,
    model,
  });

  // Guardrails: the contract's stop_when/scope are consumed here by the
  // runner; the model sees the contract unchanged. Pure adjudication lives in
  // guards.mjs; side effects (steer/cancel/report) are wired up here.
  const guardCfg = parseGuards(text);
  const guard = new Guard({
    maxDurationMs: guardCfg.maxDurationMs,
    forbidden: guardCfg.forbidden,
    cid,
    onForceKill: () => harness.close(),
    io: {
      steer: (warning) => api(port, "session.prompt", {
        sessionId: cid,
        mode: "steer",
        content: [{ type: "text", text: warning }],
      }),
      cancel: () => api(port, "session.cancel", { sessionId: cid }),
      notify: (kind, payload) => report(kind, payload),
    },
  });
  console.error(
    `[guard] max_duration=${guardCfg.maxDurationMs ? `${guardCfg.maxDurationMs}ms` : "(unset)"}` +
    ` forbidden=${JSON.stringify(guardCfg.forbidden)}` +
    ` stop_signals=${guardCfg.stopSignals.length}`
  );

  const eventLog = args["event-log"];
  const onNotification = (n) => {
    if (eventLog) {
      try {
        appendFileSync(resolve(eventLog), JSON.stringify({ at: Date.now(), method: n.method, params: n.params }) + "\n");
      } catch {}
    }
    guard.observe(n);
  };

  const started = Date.now();
  const results = [];
  try {
    // Readiness gate: sdk-jsonrpc-server only injects ["agents"] and does not
    // wait for the llm face. The SDK client sends initialize on spawn, which
    // can land before llm-pi-ai registers the provider → "no adapter
    // registered" (a race; certain under load). Low-level start() spawns
    // once, then initialize retries in-process — no child respawn loop.
    await initializeWithRetry(harness, { provider, model });

    report("progress", {
      stage: "started",
      spoke: "dsh",
      sessionId: cid,
      turns: turns.length,
      steerPort: port,
      guard: {
        maxDurationMs: guardCfg.maxDurationMs ?? null,
        forbidden: guardCfg.forbidden,
        stopSignals: guardCfg.stopSignals.map((s) => truncate(s, 200)),
      },
    });

    guard.armClock();
    for (const [i, turn] of turns.entries()) {
      if (guard.tripped) break;
      const t0 = Date.now();
      console.error(`[spoke] ── turn ${i + 1}/${turns.length} ──`);
      const r = await harness.run(turn, { sessionId: cid, onNotification });
      await guard.settle(); // drain in-flight dispositions before deciding
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      results.push(r.finalResponse ?? "");
      console.error(`[spoke] turn ${i + 1} done in ${secs}s, events=${r.events?.length ?? 0}`);
      if (guard.tripped) break;
      // No progress after the last turn — it flows straight into result.
      if (i < turns.length - 1) {
        report("progress", {
          stage: `turn-${i + 1}-done`,
          elapsedSec: Number(secs),
          events: r.events?.length ?? 0,
          response: truncate(r.finalResponse, 800),
        });
      }
    }
    await guard.settle();

    if (guard.tripped) {
      // The blocker already went upstream from guard.trip; just wind down.
      console.error(`[spoke] ■ guard tripped (${guard.tripped.reason}), no result`);
      process.exitCode = 1;
    } else {
      report("result", {
        status: "done",
        spoke: "dsh",
        sessionId: cid,
        turns: turns.length,
        elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
        responses: results.map((r) => truncate(r, 2000)),
      });
      console.error(`[spoke] ✓ completed ${turns.length} turn(s)`);
    }

    if (args["keep-alive"] && !guard.tripped) {
      console.error(`[spoke] --keep-alive: runtime stays resident, steer via :${port}, Ctrl-C to exit`);
      await new Promise(() => {});
    }
  } catch (e) {
    await guard.settle().catch(() => {});
    console.error(`[spoke] ✗ ${e?.constructor?.name}: ${e?.message}`);
    if (!guard.tripped) {
      report("blocker", {
        status: "failed",
        spoke: "dsh",
        sessionId: cid,
        error: `${e?.constructor?.name}: ${String(e?.message).slice(0, 800)}`,
        turnsCompleted: results.length,
      });
    }
    process.exitCode = 1;
  } finally {
    guard.disarm();
    await reporter.flush?.().catch(() => {});
    await harness.close();
  }
}

/** Dry run: parse the contract (cid/turns/guards) without starting a runtime.
 *  Use before dispatch to verify what the guard will enforce. */
async function cmdParse(args) {
  const file = args._[0];
  if (!file) die("parse needs a contract file path");
  const text = readFileSync(resolve(file), "utf8");
  const g = parseGuards(text);
  console.log(JSON.stringify({
    cid: args.cid ?? parseCid(text) ?? null,
    turns: parseTurns(text).length,
    guard: { maxDurationMs: g.maxDurationMs ?? null, forbidden: g.forbidden, stopSignals: g.stopSignals },
  }, null, 2));
}

async function cmdSteer(args) {
  const text = args._[0];
  if (!text) die("steer needs a correction text");
  const port = Number(args.port ?? process.env.DSH_SPOKE_PORT ?? DEFAULT_PORT);
  const cid = args.cid ?? (await pickRunningSession(port));
  if (!cid) die("no running session, and no --cid given");
  const v = await api(port, "session.prompt", {
    sessionId: cid,
    mode: "steer",
    content: [{ type: "text", text }],
  });
  console.log(`steer → ${cid}: ${JSON.stringify(v)}`);
}

async function cmdStatus(args) {
  const port = Number(args.port ?? process.env.DSH_SPOKE_PORT ?? DEFAULT_PORT);
  const v = await api(port, "session.list", {});
  for (const s of v?.items ?? []) {
    console.log(`${s.running ? "▶ RUNNING" : "  idle   "}  ${s.sessionId}  ${s.cwd ?? ""}`);
  }
}

async function pickRunningSession(port) {
  const v = await api(port, "session.list", {});
  return v?.items?.find((s) => s.running)?.sessionId;
}

// ─────────────────────────── misc ───────────────────────────

function die(msg) {
  console.error(`dsh-spoke: ${msg}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else out[key] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const commands = { run: cmdRun, parse: cmdParse, steer: cmdSteer, status: cmdStatus };
if (!commands[cmd]) die(`usage: dsh-spoke.mjs run <contract.md> | parse <contract.md> | steer "<text>" | status`);
await commands[cmd](args);

/* NOTES — four non-obvious design points; read before changing this file.
 * Each one is here because it broke first (see README "Design provenance").
 *
 * 1) Why the HTTP face exists: the SDK protocol has exactly three methods
 *    (initialize / session-prompt / shutdown) and its prompt is hard-coded to
 *    agent.followup() (queue semantics). Steer must go through agent.steer(),
 *    which only the HTTP face's session.prompt mode=steer reaches.
 *    (dsh-sdk-jsonrpc-server lib/index.js:109-116,157-159)
 *
 * 2) Why both faces must live in ONE process: the live agent is an in-process
 *    object. A second `dsh` process shares the session store but cannot see
 *    this process's live agent — its steer never lands.
 *
 * 3) Why dsh-web-app is not mounted: sdk-jsonrpc-server reserves stdout for
 *    protocol frames (its source, line ~200: "Stdout is reserved for protocol
 *    frames"), while web-app's web runtime prints "dsh web: http://..." to
 *    stdout, corrupting the stream. Hence the spoke profile hand-inserts
 *    webserver/connection/api-gateway/api-remotes and skips web-app.
 *
 * 4) Guard mechanics (adjudication is pure logic in guards.mjs; the wiring
 *    and its evidence live here):
 *    a. Live observation uses the SDK run()'s onNotification callback (every
 *       session.event, in real time) — no history polling. Note run() only
 *       forwards notifications after this prompt's inbox receipt: the gap
 *       between turns is a guard blind spot, but no agent activity happens
 *       there.
 *    b. Hard stop goes through the HTTP face session.cancel {sessionId}. The
 *       SDK protocol face has no cancel — but both faces share the live
 *       agent, so the HTTP cancel lands on the turn the SDK face started
 *       (same verified pathway as steer). After cancel the agent goes idle
 *       and run() returns normally on session.status=idle; if it does not
 *       wind down within 30s, harness.close() force-kills the runtime.
 *    c. Repeat-offense adjudication compares the event's own `time` with the
 *       warning timestamp: hits issued in the same parallel batch as the
 *       warning are not double-counted; only calls issued after the steer
 *       warning (next-step visibility) count as repeats.
 */
