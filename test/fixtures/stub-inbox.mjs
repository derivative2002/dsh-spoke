#!/usr/bin/env node
// Test fixture: stub inbox CLI implementing the three-verb shape
//   node stub-inbox.mjs send <cid> <kind> '<payload-json>'
// Appends one JSON line per call to $STUB_INBOX_FILE so the test can verify
// what the inbox-adapter example actually sent.
import { appendFileSync } from "node:fs";

const [verb, cid, kind, payload] = process.argv.slice(2);
if (verb !== "send" || !cid || !kind) {
  console.error("stub-inbox: usage: send <cid> <kind> <payload-json>");
  process.exit(2);
}
appendFileSync(process.env.STUB_INBOX_FILE, JSON.stringify({ cid, kind, payload: JSON.parse(payload) }) + "\n");
