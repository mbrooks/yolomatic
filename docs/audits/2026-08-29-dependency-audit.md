# Dependency & Framework Audit — 2026-08-29

**Issue:** mbrooks/yolomatic#602
**Audit date:** 2026-08-29 (UTC)
**Environment audited:** Node v26.8.1, npm 11.19.0, branch `yolomatic/issue-602`, clean working tree
**Method:** Live queries to the npm registry (`npm view`, `npm outdated`, `npm audit`), the GitHub Security Advisory DB (`api.github.com/advisories`), and the official Node.js release schedule (`nodejs/Release` `schedule.json`) performed on 2026-08-29. No recommendations from the issue body were reused.

---

## Executive summary

- **Every direct dependency is installed at the exact registry `latest` version.** `npm outdated` returns no output (exit 0); `npm audit` reports **0 vulnerabilities** across the full tree and with `--omit=dev`.
- **No known advisories** affect any pinned production or development version, verified against the official GitHub Advisory DB for the highest-risk packages.
- **No upgrades are required today.** The repo was refreshed as recently as commit `52048f5` ("Yolomatic: Update npm dependencies").
- Risk is concentrated in **runtime alignment** (server image on Node 24, dev/build/worker on Node 26), **one unpinned runtime install** (`@ollama/pi-web-search` in the Dockerfile), and **two in-flight major lines to watch** (Vitest 5 RC, React 19.3 canary).
- This audit changes no dependency versions. Follow-up issue proposals are listed at the end; this session's tooling cannot create GitHub issues, so filing awaits maintainer approval or a maintainer-run session.

## 1. Current installed and declared versions vs. latest

Installed versions from `package-lock.json`; "Latest" and "Last published" from registry metadata queried 2026-08-29.

| Package | Scope | Declared | Installed | Latest | Δ | Last published |
|---|---|---|---|---|---|---|
| @earendil-works/pi-coding-agent | prod | ^0.84.4 | 0.84.4 | 0.84.4 | — | 2026-08-28 |
| @emnapi/core | prod | ^1.11.3 | 1.11.3 | 1.11.3 | — | 2026-08-10 |
| @emnapi/runtime | prod | ^1.11.3 | 1.11.3 | 1.11.3 | — | 2026-08-10 |
| @octokit/rest | prod | ^22.0.1 | 22.0.1 | 22.0.1 | — | 2026-07-24 |
| dotenv | prod | ^17.4.2 | 17.4.2 | 17.4.2 | — | 2026-08-15 |
| react | prod | ^19.2.8 | 19.2.8 | 19.2.8 | — | 2026-08-28 |
| react-dom | prod | ^19.2.8 | 19.2.8 | 19.2.8 | — | 2026-08-28 |
| scheduler | prod | ^0.27.0 | 0.27.0 | 0.27.0 | — | 2026-08-28 |
| ws | prod | ^8.21.3 | 8.21.3 | 8.21.3 | — | 2026-08-07 |
| @tailwindcss/vite | dev | ^4.3.3 | 4.3.3 | 4.3.3 | — | 2026-08-14 |
| tailwindcss | dev | ^4.3.3 | 4.3.3 | 4.3.3 | — | 2026-08-14 |
| @testing-library/react | dev | ^16.3.3 | 16.3.3 | 16.3.3 | — | 2026-08-27 |
| @types/node | dev | ^26.4.0 | 26.4.0 | 26.4.0 | — | 2026-08-27 |
| @types/react | dev | ^19.2.18 | 19.2.18 | 19.2.18 | — | 2026-07-30 |
| @types/react-dom | dev | ^19.2.5 | 19.2.5 | 19.2.5 | — | 2026-08-23 |
| @types/ws | dev | ^8.18.1 | 8.18.1 | 8.18.1 | — | 2025-08-03 |
| @vitejs/plugin-react | dev | ^6.1.1 | 6.1.1 | 6.1.1 | — | 2026-08-28 |
| @vitest/coverage-v8 | dev | ^4.1.11 | 4.1.11 | 4.1.11 | — | 2026-08-28 |
| happy-dom | dev | ^20.11.15 | 20.11.15 | 20.11.15 | — | 2026-08-28 |
| tsx | dev | ^4.23.12 | 4.23.12 | 4.23.12 | — | 2026-08-10 |
| typescript | dev | ^7.0.2 | 7.0.2 | 7.0.2 | — | 2026-08-28 |
| vite | dev | ^8.2.2 | 8.2.2 | 8.2.2 | — | 2026-08-20 |
| vitest | dev | ^4.1.11 | 4.1.11 | 4.1.11 | — | 2026-08-28 |

### Runtime matrix (not npm-managed, but upgrade-relevant)

| Surface | Node version | Official status (2026-08-29) |
|---|---|---|
| Local dev / CI (`node -v`) | 26.8.1 | "current" line; LTS on 2026-10-28; EOL 2029-04-30 |
| Server image runtime (`Dockerfile`) | node:24-bookworm-slim | Active LTS until 2026-10-20, then maintenance; EOL 2028-04-30 |
| Build stages (`Dockerfile`, `workers/base-runtime.Dockerfile`) | node:26-bookworm-slim | Same as dev |
| Worker image (`workers/node.Dockerfile`) | nvm-installed Node 26 (nvm v0.40.3, pinned tag) | Same as dev |

Source: official nodejs/Release schedule (`schedule.json`).

## 2. Security, maintenance, and end-of-support findings

**Security**
- `npm audit`: **0 vulnerabilities** (full tree) and **0 vulnerabilities** (prod-only).
- GitHub Security Advisory DB queried per exact version — no advisories affecting `ws@8.21.3`, `happy-dom@20.11.15`, `undici@8.9.0` (transitive via pi-coding-agent), `@octokit/rest@22.0.1`, `dotenv@17.4.2`, `react-dom@19.2.8`, `vite@8.2.2`, `@earendil-works/pi-coding-agent@0.84.4`.
- **Supply-chain note (action recommended):** `Dockerfile` runs `npm install @ollama/pi-web-search || true` at container build without a version constraint. Latest is `0.0.5` today, but the mutable target and the silent `|| true` failure mode are risks. Pin the version (and prefer a lockfile-verified install).
- One deprecated transitive in the tree: `node-domexception@1.0.0` (stub under `@earendil-works/pi-coding-agent`). Harmless on Node ≥20 (global `DOMException`); disappears when the upstream chain drops it. No action.

**Maintenance health**
- All 23 direct deps publish within the last ~13 months; 21 within the last ~5 weeks (most recent waves on 2026-08-27/28: `react`, `react-dom`, `scheduler`, `typescript`, `vitest`, `@vitest/coverage-v8`, `happy-dom`, `@vitejs/plugin-react`, `pi-coding-agent`). Only outlier: `@types/ws` (8.18.1, published 2025-08) — `ws` itself is still 8.x, so this is normal.

**End-of-support / runtime concerns**
- Node 20 went EOL 2026-04-30. No repo surface targets Node 20 anymore; `pi-coding-agent` even publishes a `legacy-node20` dist-tag (0.74.2) for such consumers — **not needed here**.
- `node:sqlite` (`DatabaseSync`) underpins settings/skills/session/logging persistence. It requires Node ≥22.5 and is mature on the Node 24/26 runtimes in use. Any downgrade of the worker/server images back to Node 22 would move it back to experimental territory — don't.
- Server runtime (Node 24) is on the **Active LTS** track; build/dev/worker (Node 26) are on the **current** track until 2026-10-28. This build-vs-run skew (compiled on 26, served on 24) is a deliberate pin worth documenting before anyone "fixes" it.

## 3. In-flight majors: breaking changes and migration exposure

| Upcoming line | Status 2026-08-29 | Exposure for yolomatic | Migration surface |
|---|---|---|---|
| **Vitest 5** + `@vitest/coverage-v8` 5 | `5.0.0-rc.3` (V3 tag frozen at 3.2.7) | Test runner + coverage guardrail | Small: `vitest.config.ts`, `vitest.guardrail.config.ts`, `scripts/run-guardrail-coverage.js`. Watch `pool: "threads"`/`maxThreads`, coverage thresholds, and the happy-dom setup file. Single focused issue once stable. |
| **React 19.3** | canary only | Admin UI | None today. Hold on `^19.2.8`. `scheduler@^0.27.0` must move only when `react-dom`'s own range moves (react-dom 19.2.8 depends on `scheduler ^0.27.0`). |
| **@emnapi 2.0** | `2.0.0-alpha.4` | Tailwind WASM fallback path | None. Adopt only when Tailwind's `@tailwindcss/oxide-wasm32-wasi` requires it. |
| **TypeScript 7.x** | 7.0.2 stable already latest; 7.1 in dev | Already migrated; repo compiles on 7.0.2 | Routine 7.x minors only. |
| **Vite 9** | no pre-release line yet | Already on 8.2.2 | None. Config (`vite.config.ts`) uses standard `defineConfig`; plugins (`@vitejs/plugin-react` 6.1.1, `@tailwindcss/vite` 4.3.3) all latest. |
| **Tailwind v3-lts** | 3.4.19 tag, legacy-only | On 4.3.x already | None. |

## 4. Recommended upgrade order and groupings

**G0 — Record only (zero risk).** Everything current. This audit is the record. No code, no `package.json`/lockfile changes.

**G1 — Routine same-major lockfile refresh (low risk; recurring).**
- Group **safely together**: all direct deps within their declared `^` ranges — including `pi-coding-agent` 0.x minors **conditionally** (see risk note) and all `@types/*`.
- Risk: `pi-coding-agent` is 0.x semver → minor bumps may break protocol/behavior; it spans executor, model-registry, and worker interaction paths.
- Validation: `npm run guardrail:test` (preflight + full suite + coverage thresholds + server/admin typecheck + build); worker image build or protocol verification for any `pi-coding-agent` bump; lockfile diff review; advisory re-scan (`npm audit`, GH Advisory DB).
- Cadence: existing practice (see commits `a7420ee`, `52048f5`). Keep monthly.

**G2 — Node 26 LTS alignment for server runtime image (medium risk; date-gated ≥ 2026-10-28).**
- Decision needed then, not now: move `Dockerfile` runtime from `node:24-bookworm-slim` to `node:26-bookworm-slim` once 26 is LTS, or keep 24 through its maintenance window (until 2027-10-20) and plan the jump before EOL 2028-04-30. Also align `workers/node.Dockerfile` in the same decision.
- Risk: image rebuild vs. runtime mismatch; `node:sqlite` behavior differences; worker protocol.
- Validation: server + worker image builds, SQLite persistence smoke (settings/session/skills/logging stores), browser onboarding + admin UI smoke, `npm run guardrail:test`.

**G3 — Vitest 5 + `@vitest/coverage-v8` 5 (medium risk; gated on stable release).**
- Breaking-major; separate issue; do **not** bundle with G1.
- Validation: run guardrail coverage script against existing thresholds (lines 76 / functions 71 / branches 70 / statements 76 in `vitest.config.ts`), happy-dom local-storage setup file works, `maxThreads: 1` semantics preserved, `npm run guardrail:test`.

**G4 — Container runtime install hardening (small, independent).**
- Pin `@ollama/pi-web-search` to `0.0.5` in `Dockerfile` (and workers' equivalent usage if any), prefer lockfile/hash-verified install, remove silent `|| true` or add a warning path.
- Validation: worker/base image build; container boot with web-search enabled; protocol verification.

**Watchlist (no issue yet):** React 19.3 stable → evaluate; `@emnapi` 2.0 only after Tailwind adopts it; TypeScript 7.1 (dev); Vite 9 when announced.

## 5. Pinned-dependency decisions

| Dependency | Decision | Rationale |
|---|---|---|
| `scheduler ^0.27.0` | **Keep as manual direct pin** | No direct source usage; exists to co-pin the internal `react-dom` depends on. Bump only in lockstep with react/react-dom. |
| `@emnapi/core ^1.11.3`, `@emnapi/runtime ^1.11.3` | **Keep as manual direct pins** | No direct source usage; satisfy `@tailwindcss/oxide-wasm32-wasi` WASM fallback. Bump only with Tailwind; hold 2.0 until Tailwind requires it. |
| `@types/*` | Keep ranges, refresh monthly | Follow the runtime package's major line (`@types/ws` ↔ `ws@8`, `@types/node` ↔ Node 26 build line). |
| `@ollama/pi-web-search` | **Pin in Dockerfile** (G4) | Currently mutable at build time. |
| nvm install script | Already tag-pinned (v0.40.3) | Keep. |
| All others | Caret ranges + lockfile | Existing refresh cadence covers them; no exact pins needed. |

## 6. Expected validation per follow-up upgrade (all groups)

Each implementation issue requires, as applicable:
- focused unit/integration tests touching the upgraded surface;
- `npm run build` (server `tsc -p tsconfig.json` and admin `tsc -p tsconfig.admin.json && vite build`);
- worker image build (`workers/base-runtime.Dockerfile`, `workers/node.Dockerfile`) or worker protocol verification;
- updated lockfile review (`package-lock.json` diff checked per group, no unrelated drift);
- security advisory confirmation (`npm audit` full tree + prod-only, GH Advisory DB spot-check for upgraded packages);
- `npm run guardrail:test` (preflight + vitest + changed-file coverage thresholds + server/admin builds + guardrail suite) — final gate, must pass.

Behavior to be preserved in every case: server and admin builds; Node 24+ runtime support; SQLite persistence; worker image/runtime compatibility; GitHub API behavior (`@octokit/rest` usage paths); browser onboarding and admin UI; Vitest and changed-file coverage guardrails.

## 7. Proposed follow-up issues (awaiting approval to file)

1. **"Maintenance: routine npm dependency refresh (September 2026 cycle)"** — G1, includes advisory re-scan and worker protocol check for `pi-coding-agent` if it moves.
2. **"Upgrade: Node 26 LTS alignment for server runtime image (post 2026-10-28)"** — G2, with the keep-24-vs-move-to-26 decision as its first checklist item.
3. **"Upgrade: Vitest 5 + @vitest/coverage-v8 5 (when 5.0 stable ships)"** — G3.
4. **"Harden: pin @ollama/pi-web-search in container runtime install"** — G4.

This session's GitHub tooling is scoped to the session issue only (no issue-creation capability), so these proposals require a maintainer to file them or to re-run in a session with that capability. None blocks G0/G1.

## 8. Sources

- npm registry metadata (`npm view <pkg> version dist-tags engines deprecated time`), queried 2026-08-29 UTC.
- `npm outdated` (exit 0, no rows) and `npm audit` (0 vulnerabilities, full and prod-only), run 2026-08-29.
- Official GitHub Security Advisory DB (`api.github.com/advisories?ecosystem=npm&affects=<pkg>@<ver>`), queried 2026-08-29.
- Official Node.js release schedule (`nodejs/Release` repo, `schedule.json`), queried 2026-08-29.
- Official release tags confirmed on GitHub: `vitest-dev/vitest` v4.1.11, `microsoft/TypeScript` v7.0.2, `websockets/ws` 8.21.3, `tailwindlabs/tailwindcss` v4.3.3.
- Repo state: `package.json` / `package-lock.json` at commit `52048f5` lineage, worktree `yolomatic/issue-602`, clean tree at audit time.