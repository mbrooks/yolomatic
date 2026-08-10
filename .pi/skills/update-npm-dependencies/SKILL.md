---
name: update-npm-dependencies
description: Upgrade Yolomatic's direct npm dependencies and development dependencies to their latest stable, mutually compatible versions. Use when asked to refresh packages, update npm modules, upgrade dependencies, resolve stale package versions, or perform a dependency-maintenance pass in this repository.
---

# Update NPM Dependencies

Upgrade the dependency manifest, installed modules, and lockfile together. Preserve application behavior, repository metadata, and unrelated work while adapting the code only where a new package version requires it.

## Scope

- Treat "latest" as the latest stable npm release. Do not select prerelease, beta, release-candidate, canary, or experimental tags unless explicitly requested.
- Update every direct entry in `dependencies` and `devDependencies` when the request covers the whole project. Limit the inventory when the request names specific packages.
- Preserve each package's runtime or development classification.
- Keep tightly coupled packages on a compatible set. Examples include React and its type packages, Vite and its plugins, Vitest and its coverage provider, and Tailwind CSS and its integration.
- Let npm resolve transitive dependencies through `package-lock.json`; do not independently chase every transitive package unless a direct constraint or unresolved vulnerability requires it.
- Do not change unrelated fields in `package.json` or the root metadata in `package-lock.json`.

## Workflow

### 1. Establish the baseline

Read `SOUL.md` and `AGENTS.md` before changing anything.

Inspect the working tree and package setup:

```bash
git status --short
git diff -- package.json package-lock.json
node --version
npm --version
npm ls --depth=0
npm outdated --depth=0
```

Treat a nonzero exit from `npm outdated` as an outdated-package report, not automatically as a command failure. Record the current direct versions and the latest stable versions before editing.

Preserve all unrelated edits. If `package.json` or `package-lock.json` already contains overlapping dependency work that cannot be separated safely, stop and report the conflict instead of overwriting it.

Run `npm run guardrail:test` before the upgrade so new failures can be distinguished from baseline failures. If the baseline is already red, capture the exact failure and continue only when the dependency work can still be evaluated safely.

### 2. Research compatibility

Use current npm registry metadata and primary release notes for every major-version jump. Check at least:

- the package's stable `latest` dist-tag
- supported Node.js versions in `engines`
- required peer dependency ranges
- migration guides and documented breaking changes
- compatibility with other packages in the same ecosystem

Prefer the newest mutually compatible stable set. Do not conceal conflicts with `--force`, `--legacy-peer-deps`, broad overrides, or an unexplained downgrade. If no compatible latest set exists, keep the highest compatible stable versions and report the precise constraint.

Plan small batches before installing. Group packages only when they must move together; update unrelated major versions separately so failures remain attributable.

### 3. Upgrade packages and the lockfile

Use npm install commands so `package.json`, `package-lock.json`, and `node_modules` stay synchronized:

```bash
npm install <runtime-package>@latest
npm install --save-dev <development-package>@latest
```

Install a tightly coupled compatibility set in one command. Preserve the repository's existing semver range style. Do not hand-edit dependency resolutions in `package-lock.json`, delete the lockfile, or regenerate it with a different package manager.

After each batch:

1. Inspect the manifest and lockfile diff for unrelated churn.
2. Run `npm ls --depth=0` and resolve invalid, missing, or extraneous direct packages.
3. Run the most relevant focused tests and build or typecheck command.
4. Continue only after the batch is understood and stable.

### 4. Adapt breaking changes with TDD

Follow `AGENTS.md` for every required change under `src/`:

1. Describe the new or preserved behavior as plain-English test scenarios.
2. Add or update focused unit tests and confirm the red state.
3. Make the smallest production change needed for the new dependency API.
4. Rerun the focused tests before continuing.

Preserve externally visible behavior unless the user explicitly requests a product change. Mock only external boundaries. Do not weaken tests, coverage thresholds, TypeScript settings, or guardrails to make an upgrade pass.

### 5. Verify the final dependency set

Run all of the following:

```bash
npm ls --depth=0
npm outdated --depth=0
npm audit --omit=dev
npm audit
npm run guardrail:test
git diff --check
```

Interpret audit findings rather than applying `npm audit fix --force`. Address findings within scope when a compatible stable version exists; otherwise report the affected package, severity, dependency path, and available remediation.

Do not claim that the project is fully current unless the final direct-dependency inventory confirms it. Explain any remaining `npm outdated` entries, peer constraints, prereleases intentionally excluded, audit findings, or guardrail failures.

### 6. Report the result

Summarize:

- each direct package changed, with before and after versions
- major-version migrations or source adaptations
- packages left below latest and the exact compatibility reason
- audit status and unresolved advisories
- focused verification and the final `npm run guardrail:test` result
- files changed, including `package.json` and `package-lock.json`

Keep registry claims current and evidence-backed. Never report a partial test run as a successful full guardrail.
