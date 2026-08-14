# Contributing

Small project, strict shape. The rules below are load-bearing.

## Repository shape

- **Source only.** `src/*.mjs` runs directly under Node ≥ 18. No build step,
  no transpiled output, no committed artifacts. PRs adding a build pipeline
  need a very good reason.
- **Dependencies stay pinned exact** (no `^`/`~`). Bumping a pin is its own
  commit with the reason in the message. `package-lock.json` is committed.
- **No secrets, no infrastructure names.** Gateways appear only as
  `DSH_SPOKE_BASE_URL` placeholders; keys only as env-var names.

## Changing the guard layer

`src/guards.mjs` is pure logic with no SDK/network/subprocess imports — keep
it that way; it is what makes the guard testable offline.

- Every behavioral change lands with a test in `test/`. If you are fixing a
  parsing or adjudication defect, write the failing shape first
  (red-then-green) and keep the fixture close to the real incident.
- Every non-obvious rule gets a line in the README's **Design provenance**
  table: what broke, what rule now prevents it. A guardrail without its
  incident is indistinguishable from superstition.
- Read the NOTES block at the end of `src/dsh-spoke.mjs` before touching the
  runtime wiring — each point there broke before it was written down.

## Tests

```bash
npm test        # node --test, offline, no dsh binary or gateway needed
```

All green before any PR. Live-fire changes (anything touching the SDK wiring
or the HTTP face) should additionally state in the PR what you ran against a
real runtime and what the event log showed.

## Reporters

New built-in reporters belong in `src/reporters.mjs` only if they have no
dependencies; anything with an external dependency ships as an example module
under `examples/` instead. `report()` must never throw.
