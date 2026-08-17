# Guardrails: Coverage Enforcement and Mock-Boundary Policy

This document describes how Yolomatic enforces the `AGENTS.md` testing
guidance: 80% coverage on guardrail-relevant business logic, and the
mock-boundary policy that keeps unit tests from inflating execution coverage
with low-value internal mocks.

## Guardrail entrypoint

`npm run guardrail:test` runs:

1. `preflight` — verifies dev tooling is installed.
2. `npm test` — the full unit suite (see `vitest.config.ts` for whole-suite
   thresholds).
3. `npm run test:coverage` — `scripts/run-guardrail-coverage.js` runs vitest
   with `vitest.guardrail.config.ts` over the test files adjacent to the
   changed guardrail-relevant source files and writes
   `coverage/coverage-summary.json`.
4. `npm run build` — TypeScript + admin UI build.
5. `node ./dist/guardrails.js` — the enforcement entrypoint. It runs the
   coverage guardrail (`runGuardrail`) and the mock-boundary guardrail
   (`runMockBoundaryGuardrail`) over the changed files and exits non-zero on
   any failure.

`src/guardrails.ts` is the canonical enforcement implementation.
`scripts/run-guardrail-coverage.js` re-implements the same classification to
decide which test files to measure; `tests/integration/guardrail-coverage-parity.test.ts`
asserts the two agree so measured coverage and enforced coverage always match.

## What counts as business logic

The guardrail measures and enforces coverage on **guardrail-relevant source
files**: business logic, utilities, and state transitions under `src/`.

A file is guardrail-relevant when it:

- lives under `src/`, and
- has a `.ts` or `.tsx` extension, and
- is not in one of the excluded categories below.

### Excluded categories (kept out of coverage and enforcement)

Per `AGENTS.md`, styling, type exports, configuration, and third-party setup
are excluded from coverage expectations. The exclusion rules are deterministic
path patterns so the excluded set stays reviewable. They are defined in
`src/guardrails.ts` and mirrored in `scripts/run-guardrail-coverage.js`.

| Category | Pattern | Examples |
| --- | --- | --- |
| Test files | `*.test.ts` | `src/session/manager.test.ts` |
| Type-export modules | `**/types.ts` | `src/skills/types.ts`, `src/admin/app/types.ts` |
| Styling | `**/(styles\|style\|*.styles\|*.style).ts` and all `*.tsx` | `src/admin/theme/styles.ts`, `src/admin/components/Modal.tsx` |
| Configuration | `**/config.ts` and `**/*.config.ts` | `src/config.ts`, `src/workspace/config.ts` |
| Third-party setup / SDK wiring | `**/octokit.ts` | `src/adapters/github/octokit.ts` |
| Declaration files | `*.d.ts` | `src/admin/css-modules.d.ts` |

`*.tsx` is excluded because admin UI components are styling/view code for
coverage purposes; the explicit rule keeps the exclusion intentional rather
than incidental to the `.ts` include.

To exclude a new third-party SDK-wiring module, add its basename to
`THIRD_PARTY_SETUP_PATTERN` in both `src/guardrails.ts` and
`scripts/run-guardrail-coverage.js` (the parity test will catch a drift).

## Coverage enforcement

For each changed guardrail-relevant source file, the guardrail requires:

- an adjacent test file (`src/foo/bar.ts` → `src/foo/bar.test.ts`), and
- **80% statements, branches, functions, and lines** in
  `coverage/coverage-summary.json`.

`MINIMUM_COVERAGE` is `80` in `src/guardrails.ts`, matching `AGENTS.md`. The
`vitest.guardrail.config.ts` thresholds are intentionally `0`; enforcement is
done by `dist/guardrails.js` reading the per-file summary so that a changed
business-logic file cannot bypass coverage through a zero-threshold run. The
whole-suite thresholds in `vitest.config.ts` are a separate, repo-wide floor.

There is no staged migration plan: per-changed-file 80% enforcement already
matches the project guidance, so new and modified business logic is held to
the target immediately.

## Mock-boundary policy

`AGENTS.md` permits mocking only external boundaries — network requests and
third-party SDKs. Mocking internal relative modules inflates execution
coverage without a useful quality signal. The mock-boundary guardrail
rejects new relative-module `vi.mock(...)` calls in unit tests unless they
are listed in `mock-exceptions.json` with an explicit, auditable reason.

### What is flagged

`src/mock-boundary.ts` scans each changed `*.test.ts` / `*.test.tsx` file
under `src/` or `tests/` for `vi.mock("./..." )` / `vi.mock("../..." )`
calls (relative module specs). Bare package names, scoped packages, and
`node:` builtins are not flagged. `vi.mocked(...)` is not a mock call and is
ignored. Only `vi.mock(` at statement position is matched, so
`vi.mock(...)` text embedded in string/template-literal fixtures (for
example in `src/mock-boundary.test.ts` itself) is not flagged.

### Exception mechanism

`mock-exceptions.json` (repo root) is the auditable escape hatch. Each entry
permits one relative mock in one test file:

```json
{
  "testFile": "src/admin/api/users.test.ts",
  "module": "./client.js",
  "category": "composition-root",
  "reason": "HTTP transport client wiring; mocking isolates API unit tests from network I/O."
}
```

Allowed categories:

- `external-adapter` — wraps a third-party SDK or an external side-effect
  boundary (e.g. the Octokit GitHub SDK, the LLM provider logger, the
  persistent session-log store).
- `composition-root` — wires an external transport client at the
  composition boundary (e.g. the admin API HTTP client, the admin WebSocket
  transport).
- `legacy` — a pre-existing internal-collaborator mock that does not fit the
  policy but is grandfathered. Each `legacy` entry must carry a removal plan
  in its `reason`.

A missing `mock-exceptions.json` is treated as empty, so every relative mock
is unauthorized and the guardrail fails.

### Completeness audit

`src/mock-boundary.test.ts` pins the grandfathered set: every known
relative mock in the suite must appear in `mock-exceptions.json` with a valid
category and a non-empty reason. Any new relative mock must therefore be
added deliberately — either as a justified `external-adapter` /
`composition-root` exception or it is rejected by the guardrail.