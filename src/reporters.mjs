// reporters.mjs — the upstream reporting seam of dsh-spoke.
//
// A running spoke emits exactly three kinds of upstream messages:
//   progress | blocker | result
// Where those messages go is a deployment decision, not a driver concern.
// This module defines the reporter interface and ships three built-ins:
//
//   stdout             one JSON envelope per line on the driver's stdout
//   jsonl:<path>       append envelopes to a JSONL file
//   webhook:<url>      POST each envelope as JSON to an HTTP endpoint
//
// Custom integrations (message queues, file inboxes, chat bots, …) load as
// ES modules: any spec that looks like a path to a .mjs/.js file is imported
// and must export `createReporter(ctx) -> reporter`. See
// examples/inbox-adapter.mjs for a worked example against a file-inbox CLI.
//
// Contract for implementations:
//   reporter = {
//     name:   string                       // for logs
//     report: (kind, payload) -> bool | Promise<bool>
//     flush?: () -> Promise<void>          // optional: drain in-flight sends
//   }
// report() MUST NOT throw — a broken upstream channel never crashes the run
// (the run itself is the primary artifact; reporting is telemetry). Failures
// log one line to stderr and return false.
//
// Envelope written by the built-ins:
//   { at: <ISO time>, cid: <contract id | null>, kind, payload }

import { appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export const REPORT_KINDS = ["progress", "blocker", "result"];

/**
 * Parse a reporter spec string into a typed descriptor.
 *   "stdout"                    → { type: "stdout" }
 *   "jsonl:out/run.jsonl"       → { type: "jsonl", path }
 *   "webhook:https://host/x"    → { type: "webhook", url }
 *   "./adapter.mjs" | "~/x.mjs" | "/abs/x.mjs" → { type: "module", path }
 * Anything else throws — a typo in the upstream channel should fail loudly
 * at startup, not silently discard evidence mid-run.
 */
export function parseReporterSpec(spec) {
  const s = String(spec ?? "stdout").trim();
  if (s === "" || s === "stdout") return { type: "stdout" };
  if (s.startsWith("jsonl:")) {
    const path = s.slice("jsonl:".length).trim();
    if (!path) throw new Error(`reporter spec "jsonl:" needs a file path`);
    return { type: "jsonl", path: expandHome(path) };
  }
  if (s.startsWith("webhook:")) {
    const url = s.slice("webhook:".length).trim();
    if (!/^https?:\/\//.test(url)) {
      throw new Error(`reporter spec "webhook:" needs an http(s) URL, got "${url}"`);
    }
    return { type: "webhook", url };
  }
  if (/\.(mjs|js)$/.test(s) && (s.startsWith("./") || s.startsWith("../") || s.startsWith("~/") || isAbsolute(s))) {
    return { type: "module", path: expandHome(s) };
  }
  throw new Error(
    `unknown reporter spec "${s}" — expected stdout | jsonl:<path> | webhook:<url> | <path/to/module.mjs>`
  );
}

function expandHome(p) {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
}

/** Build the reporter for a parsed or raw spec. ctx = { cid, env? }. */
export async function createReporter(spec, ctx = {}) {
  const d = typeof spec === "string" ? parseReporterSpec(spec) : spec;
  switch (d.type) {
    case "stdout": return stdoutReporter(ctx);
    case "jsonl": return jsonlReporter(d.path, ctx);
    case "webhook": return webhookReporter(d.url, ctx);
    case "module": {
      const mod = await import(pathToFileURL(resolve(d.path)).href);
      if (typeof mod.createReporter !== "function") {
        throw new Error(`reporter module ${d.path} must export createReporter(ctx)`);
      }
      const custom = await mod.createReporter({ ...ctx, env: ctx.env ?? process.env });
      if (typeof custom?.report !== "function") {
        throw new Error(`reporter module ${d.path} returned no report() function`);
      }
      return { name: custom.name ?? `module:${d.path}`, ...custom };
    }
    default:
      throw new Error(`unhandled reporter type ${d.type}`);
  }
}

const envelope = (ctx, kind, payload) =>
  JSON.stringify({ at: new Date().toISOString(), cid: ctx.cid ?? null, kind, payload });

function stdoutReporter(ctx, stream = process.stdout) {
  return {
    name: "stdout",
    report(kind, payload) {
      try {
        stream.write(envelope(ctx, kind, payload) + "\n");
        return true;
      } catch (e) {
        console.error(`[reporter:stdout] write failed: ${e?.message}`);
        return false;
      }
    },
  };
}

// Exported for tests: same factory, injectable stream.
export const _stdoutReporterForStream = (ctx, stream) => stdoutReporter(ctx, stream);

function jsonlReporter(path, ctx) {
  const file = resolve(path);
  return {
    name: `jsonl:${file}`,
    report(kind, payload) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, envelope(ctx, kind, payload) + "\n");
        return true;
      } catch (e) {
        console.error(`[reporter:jsonl] append failed: ${e?.message}`);
        return false;
      }
    },
  };
}

function webhookReporter(url, ctx) {
  const inflight = new Set();
  return {
    name: `webhook:${url}`,
    report(kind, payload) {
      const p = fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: envelope(ctx, kind, payload),
      })
        .then((res) => {
          if (!res.ok) console.error(`[reporter:webhook] HTTP ${res.status} from ${url}`);
          return res.ok;
        })
        .catch((e) => {
          console.error(`[reporter:webhook] POST failed: ${e?.message}`);
          return false;
        });
      inflight.add(p);
      p.finally(() => inflight.delete(p));
      return p;
    },
    // Drain in-flight POSTs before process exit so final result/blocker
    // envelopes are not lost to an early SIGCHLD-era teardown.
    async flush() {
      await Promise.allSettled([...inflight]);
    },
  };
}
