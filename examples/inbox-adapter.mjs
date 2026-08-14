// inbox-adapter.mjs — example custom reporter: bridge dsh-spoke's upstream
// messages into an external file-inbox CLI.
//
// This is a REFERENCE integration, not a dependency. It targets any inbox
// tool that exposes the common three-verb CLI shape:
//
//   node <inbox-cli> send <contract-id> <kind> '<payload-json>'
//
// where <kind> ∈ progress | blocker | result — i.e. a file-based message
// relay owned by whatever supervisor dispatched the contract. dsh-spoke does
// not ship or require such a tool; if your orchestration stack has one, point
// DSH_SPOKE_INBOX_CLI at it and every guard blocker / turn progress / final
// result lands in its queue with no polling.
//
// Usage:
//   export DSH_SPOKE_INBOX_CLI=/path/to/your/inbox.mjs
//   node src/dsh-spoke.mjs run contract.md --reporter ./examples/inbox-adapter.mjs
//
// Contract for custom reporter modules (see src/reporters.mjs):
//   export createReporter(ctx) -> { name, report(kind, payload) }
//   ctx = { cid, env } — report() must never throw.

import { spawnSync } from "node:child_process";

export function createReporter({ cid, env }) {
  const cli = env.DSH_SPOKE_INBOX_CLI;
  if (!cli) {
    throw new Error("inbox-adapter: set DSH_SPOKE_INBOX_CLI to your inbox CLI path");
  }
  return {
    name: `inbox:${cli}`,
    report(kind, payload) {
      if (!cid) {
        // An inbox relay is addressed by contract id; without one there is no
        // queue to land in. Skip loudly rather than invent an address.
        console.error(`[reporter:inbox] no cid — skipping ${kind}`);
        return false;
      }
      const r = spawnSync("node", [cli, "send", cid, kind, JSON.stringify(payload)], {
        encoding: "utf8",
      });
      const ok = r.status === 0;
      if (!ok) {
        console.error(`[reporter:inbox] send failed rc=${r.status}: ${(r.stderr || r.stdout || "").trim()}`);
      }
      return ok;
    },
  };
}
