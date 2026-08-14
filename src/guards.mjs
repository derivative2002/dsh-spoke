// guards.mjs — the offline pure-logic layer of dsh-spoke:
// contract parsing (cid / turns / guard inputs) + Guard adjudication.
//
// This file imports no SDK and performs no network or subprocess side effects —
// steer / cancel / upstream reporting are injected by the caller through `io`.
// That is what keeps the guard layer unit-testable on a machine with nothing
// installed: `npm test` covers this file without the DSH SDK present.
import { join } from "node:path";
import { homedir } from "node:os";

// ─────────────────────────── contract parsing ───────────────────────────

/**
 * Extract the contract id (cid) from the contract body. The fixed-value form
 * `cid=\`xxx\`` (as written in a reply_route section) wins; otherwise fall
 * back to the first argument of an inbox-style `send` command line. Returns
 * undefined when neither is present — the --cid flag is the caller's fallback.
 */
export function parseCid(text) {
  return (
    text.match(/cid\s*=\s*[`"']([A-Za-z0-9_.-]+)[`"']/)?.[1] ??
    text.match(/inbox\.mjs["']?\s+send\s+([A-Za-z0-9_.-]+)/)?.[1]
  );
}

/**
 * Split the contract into turns. Explicit `<turn>` sections win; without any,
 * the whole contract is a single turn. This supports hub-authored multi-turn
 * tasks while staying compatible with plain single-turn contracts.
 */
export function parseTurns(text) {
  const turns = [...text.matchAll(/<turn(?:\s[^>]*)?>([\s\S]*?)<\/turn>/g)].map((m) => m[1].trim());
  return turns.length > 0 ? turns : [text.trim()];
}

/** '60s'/'75m'/'2h'/'1500ms' → milliseconds. Unparseable → undefined. */
export function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(String(s ?? "").trim());
  if (!m) return undefined;
  return Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]]);
}

/**
 * Extract guard inputs from the contract text. These feed the runner only —
 * the prompt shown to the model is never modified.
 * - maxDurationMs: `max_duration` inside <stop_when>.
 * - stopSignals:   the remaining <stop_when> lines (semantic conditions; the
 *                  runner relays them upstream but does not adjudicate them).
 * - forbidden:     path tokens (`/…` or `~/…`, ~ expanded) on <scope> lines
 *                  that carry a forbidden marker (不可动 / forbidden / 禁).
 */
export function parseGuards(text) {
  // Block tags must sit at line start: an inline mention of `<stop_when>` in
  // prose must not hijack the block anchor (bitten by this in live fire).
  const block = (tag) =>
    text.match(new RegExp(`^[ \\t]*<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "m"))?.[1] ?? "";
  const stopWhen = block("stop_when");
  const scope = block("scope");

  const maxDurationMs = parseDuration(
    stopWhen.match(/max_duration\s*[:=]?\s*([\d.]+\s*(?:ms|s|m|h))/i)?.[1]
  );
  const stopSignals = stopWhen
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter((l) => l && !/max_duration/i.test(l));

  const forbidden = [];
  for (const line of scope.split("\n")) {
    if (!/不可动|forbidden|禁/.test(line)) continue;
    // Path tokens start with / or ~/ and must not be preceded by a path-ish
    // character (so `web/headless` in prose never yields `/headless`).
    for (const tok of line.match(/(?<![\w.~/-])(?:~\/|\/)[\w.一-鿿/-]+/g) ?? []) {
      const p = tok.startsWith("~/") ? join(homedir(), tok.slice(2)) : tok;
      if (p.length > 1 && !forbidden.includes(p)) forbidden.push(p);
    }
  }
  return { maxDurationMs, stopSignals, forbidden };
}

// ─────────────────────────── Guard adjudication ───────────────────────────

export const truncate = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…[truncated]` : s ?? "");

/**
 * The guard itself. onNotification is a synchronous callback; every async
 * disposition (steer / cancel / upstream report) is serialized through
 * this.chain. `tripped`, once set, never flips back — the run loop consumes
 * it to decide whether to stop.
 *
 * Side effects are injected (`io`; wired by dsh-spoke.mjs, stubbed in tests):
 *   io.steer(text)          → HTTP face session.prompt mode=steer
 *   io.cancel()             → HTTP face session.cancel {sessionId}
 *   io.notify(kind,payload) → reporter.report (kind ∈ progress|blocker|result)
 */
export class Guard {
  constructor({ maxDurationMs, forbidden, cid, onForceKill, io }) {
    this.maxDurationMs = maxDurationMs;
    this.forbidden = forbidden ?? [];
    this.cid = cid;
    this.onForceKill = onForceKill;
    this.io = io;
    this.strikes = 0;
    this.warnedAtMs = 0;
    this.tripped = null; // {reason, detail}
    this.chain = Promise.resolve();
    this.startedAt = Date.now();
    this.timer = null;
    this.forceTimer = null;
  }

  armClock() {
    if (!this.maxDurationMs) return;
    this.timer = setTimeout(() => {
      this.chain = this.chain.then(() =>
        this.trip("timeout", `max_duration ${this.maxDurationMs}ms elapsed, runner hard-stop`)
      );
    }, this.maxDurationMs);
    this.timer.unref?.();
  }

  disarm() {
    if (this.timer) clearTimeout(this.timer);
    if (this.forceTimer) clearTimeout(this.forceTimer);
  }

  settle() {
    return this.chain;
  }

  /** onNotification entry: only this session's tool/call events can strike. */
  observe(notification) {
    if (this.tripped || this.forbidden.length === 0) return;
    if (notification.method !== "session.event") return;
    if (notification.params?.sessionId !== this.cid) return;
    const event = notification.params.event;
    if (event?.type !== "tool/call") return;
    const raw = JSON.stringify(event.data ?? {});
    const hit = this.forbidden.find((p) => raw.includes(p));
    if (!hit) return;
    const evTimeMs = typeof event.time === "number" ? event.time : Date.now();
    this.chain = this.chain
      .then(() => this.onScopeHit(hit, evTimeMs, raw))
      .catch((e) => console.error(`[guard] disposition failed: ${e?.message}`));
  }

  async onScopeHit(path, evTimeMs, raw) {
    if (this.tripped) return;
    if (this.strikes === 0) {
      this.strikes = 1;
      this.warnedAtMs = Date.now();
      console.error(`[guard] ⚠ scope violation #1: tool call hit forbidden path ${path} → steer warning (once)`);
      await this.io.steer(
        `[GUARD] Scope violation warning: your tool call touched the forbidden path ${path} ` +
        `declared by the contract. This is your only warning. Stop accessing that path now; ` +
        `if the task cannot proceed without it, stop and explain why. ` +
        `Touching it again will hard-terminate the session (cancel).`
      );
      return;
    }
    // Already warned: only calls issued AFTER the warning count as a repeat
    // (parallel hits from the same batch as the warning are not double-counted).
    if (evTimeMs <= this.warnedAtMs) return;
    this.strikes = 2;
    console.error(`[guard] ✗ scope violation #2 (repeat after warning): ${path} → cancel + blocker`);
    await this.trip(
      "scope-violation",
      `forbidden path ${path} hit again by a tool call issued after the steer warning`,
      { forbiddenPath: path, toolCall: truncate(raw, 600) }
    );
  }

  /** Hard stop: session.cancel the current turn + report a blocker upstream;
   *  if the run has not wound down in 30s, force-kill the runtime. */
  async trip(reason, detail, extra = {}) {
    if (this.tripped) return;
    this.tripped = { reason, detail };
    console.error(`[guard] ■ ${reason}: ${detail} → session.cancel`);
    try {
      const v = await this.io.cancel();
      console.error(`[guard] session.cancel → ${JSON.stringify(v)}`);
    } catch (e) {
      console.error(`[guard] session.cancel failed (maybe no running turn): ${e?.message}`);
    }
    this.io.notify("blocker", {
      status: "blocked",
      spoke: "dsh",
      sessionId: this.cid,
      reason,
      detail,
      strikes: this.strikes,
      elapsedSec: Number(((Date.now() - this.startedAt) / 1000).toFixed(1)),
      ...(this.maxDurationMs ? { maxDurationMs: this.maxDurationMs } : {}),
      ...extra,
    });
    if (this.onForceKill) {
      this.forceTimer = setTimeout(() => {
        console.error(`[guard] run did not wind down 30s after cancel — force-killing runtime`);
        this.onForceKill();
      }, 30_000);
      this.forceTimer.unref?.();
    }
  }
}
