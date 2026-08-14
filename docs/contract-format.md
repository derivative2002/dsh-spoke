# Contract format

A dsh-spoke contract is a plain Markdown file with a small number of
XML-style sections. The **whole file is fed to the model verbatim** — the
sections below are *also* parsed by the runner, which is what turns two of
them (`<stop_when>`, `<scope>`) into enforced guardrails rather than polite
requests.

The canonical shape has five sections:

```markdown
cid=`my-task-001`

<objective>
What the task is, in one or two paragraphs. Why it exists, what "good" means.
</objective>

<scope>
May touch: ./workdir, the project under refactor.
Forbidden: `/etc`, `~/.ssh`, /var/lib/production-data.
</scope>

<validation>
done-when:
1. Tests pass (`npm test` output attached).
2. The report file exists and names its evidence.
</validation>

<stop_when>
- max_duration: 30m
- Stop and report if credentials are required.
- Stop and report if the same error repeats 3 times.
</stop_when>

<reply_route>
How to report upstream (informational for the model; the runner's actual
upstream channel is chosen by `--reporter`, see below).
cid=`my-task-001`
</reply_route>
```

## What the runner parses (and what it enforces)

| Section | Parsed by | Enforced? |
|---|---|---|
| `cid=\`…\`` (anywhere, first match) | `parseCid` | Used as session id + report envelope `cid`. `--cid` overrides. |
| `<turn>…</turn>` (zero or more) | `parseTurns` | Each `<turn>` becomes one driven turn on the **same resident session**. No `<turn>` sections → the whole file is a single turn. |
| `<stop_when>` → `max_duration: 60s\|10m\|2h` | `parseGuards` | **Yes — hard wall-clock limit.** On expiry the runner cancels the in-flight turn and reports a `blocker`. |
| `<stop_when>` → all other lines | `parseGuards` | No — they are *semantic* stop conditions. The runner relays them in the `started` progress envelope so a supervisor can reconcile; their force on the model comes from the contract text itself. |
| `<scope>` lines containing a forbidden marker (`不可动`, `forbidden`, `禁`) | `parseGuards` | **Yes — forbidden-path guard.** Absolute (`/…`) and home (`~/…`) path tokens on those lines become a prefix blocklist. First tool call hitting a prefix → one steer warning injected into the live session; any hit issued **after** the warning → cancel + `blocker`. |
| `<objective>`, `<validation>`, `<reply_route>`, everything else | — | Model-facing only. |

Parsing rules worth knowing (each exists because the naive version broke —
see the test suite):

- **Section tags must start at the beginning of a line.** Mentioning
  `<stop_when>` inline in prose does not hijack the block anchor.
- Path tokens are only lifted from lines that carry a forbidden marker, and a
  token must not be preceded by a path-like character — `web/headless` in
  prose never yields `/headless`.
- `~/…` expands against the runner's `$HOME`.
- Durations require an explicit unit (`ms`, `s`, `m`, `h`). A bare number is
  ignored rather than guessed.
- cid fallback: if there is no `cid=\`…\`` assignment, the first argument of
  an inbox-style `send` command line (`… send <cid> …`) is accepted. This
  keeps older contracts working unchanged.

## Verify before you dispatch

`parse` is a dry run — it prints exactly what the guard layer extracted,
without starting a runtime:

```bash
node src/dsh-spoke.mjs parse my-contract.md
# {
#   "cid": "my-task-001",
#   "turns": 2,
#   "guard": {
#     "maxDurationMs": 1800000,
#     "forbidden": ["/etc", "/var/lib/production-data", "/home/you/.ssh"],
#     "stopSignals": ["Stop and report if credentials are required.", …]
#   }
# }
```

If `forbidden` or `maxDurationMs` is not what you meant, fix the contract
before running it. The guard enforces what it parsed, not what you intended.

## Reporting (upstream channel)

The three upstream kinds are fixed: `progress`, `blocker`, `result`. Where
they go is decided at launch by `--reporter` / `DSH_SPOKE_REPORTER`
(`stdout` default, `jsonl:<path>`, `webhook:<url>`, or a custom module — see
`examples/inbox-adapter.mjs`). The `<reply_route>` section stays useful as
human documentation and as the place the `cid=\`…\`` assignment naturally
lives, but the runner never shells out to anything written inside it.
