---
name: modernize-refactor
description: Plan behavior-preserving modernization and refactor work for an existing codebase. Use when the agent needs to inspect a repo, identify dead code, duplicated paths, oversized modules, stale abstractions, legacy patterns, and other structural debt, then pr
---

# Modernize Refactor

## Overview

Inspect the codebase before proposing changes. Produce a concrete refactor plan that preserves current behavior unless the user explicitly requests a functional change.

Keep the output reviewable: identify debt, group it into safe passes, name what stays the same, and define the checks that prove parity.

## Workflow

### 1. Inspect the repository

Read local project guidance first if present, then inspect the repo layout before drawing conclusions.

Prioritize evidence over generic advice:

- list modules by size and responsibility
- identify duplicated store, repository, transport, validation, or orchestration logic
- note dead code, alias exports, stale adapters, or compatibility shims
- distinguish active abstractions from legacy layers that are slowing changes down
- note framework or dependency surfaces separately from ordinary refactors

Use concrete file references when calling out hotspots.

### 2. Classify the debt

Sort findings into categories that map cleanly to reviewable refactor work:

- dead code or duplicate entrypoints
- duplicated logic or parallel implementations
- oversized modules with mixed responsibilities
- stale abstractions or compatibility layers
- outdated patterns relative to current repo conventions

Do not collapse migration work into normal refactor work. Call out dependency upgrades, framework migrations, storage changes, API changes, or architecture moves as separate follow-up tasks.

### 3. Build small refactor passes

Break the plan into small, reviewable passes. Prefer passes such as:

- deleting dead code
- simplifying control flow
- extracting shared helpers
- splitting oversized modules
- normalizing repository or transport patterns
- replacing outdated internal patterns with the repo's current conventions

For each pass, always state:

1. Current behavior
2. Structural improvement
3. Validation check

Keep public APIs stable unless the refactor requires a deliberate API change. If an API change is required, isolate it as its own migration task.

When working around SQL-backed repositories or data access code, prefer keeping query execution local and readable. Do not abstract SQL queries or their execution flow behind generic helpers unless it is absolutely necessary to preserve behavior, remove proven duplication that is actively causing defects, or support a concrete cross-cutting constraint. If an SQL abstraction is proposed, justify why inline queries are insufficient and treat readability of the query path as a first-order concern.

Strive to keep SQL text fully local to the repository methods that execute it. Avoid shared query fragments such as `select...Columns`, `...OrderBy`, or similar SQL string constants in repositories unless a concrete constraint requires them and that tradeoff is explicitly justified.

### 4. Define parity checks

Name the fastest credible validation for each pass. Reuse the repo's existing guardrails first:

- unit or integration tests already covering the module
- build or typecheck commands
- lint or guardrail suites
- snapshot, API contract, or schema assertions when relevant
- focused parity tests when existing coverage is weak

When the scope is broad or the current coverage is thin, propose prep work before implementation:

- a parity checklist for critical behaviors
- narrow docs on protected public APIs
- fixture or snapshot coverage for risky flows
- migration notes for legacy schemas or wire contracts

### 5. Stay in planning mode unless redirected

Default to proposing the plan, not implementing it. If the user later asks to execute the work, use the plan as the implementation backlog and preserve the same pass boundaries.

## Output Shape

Use a concise structure:

1. Brief summary of the repo hotspots
2. Refactor passes, each with current behavior, structural improvement, and validation check
3. Separate migration tasks
4. Prep docs, specs, or parity checks if the scope justifies them

Keep the plan concrete. Prefer file references and named modules over abstract architecture language.

## Guardrails

- Preserve behavior unless the user explicitly requests a functional change.
- Prefer evidence from the repository over assumptions.
- Keep public APIs stable during refactors.
- Split migrations from refactors.
- Avoid broad rewrites when smaller passes can reach the same outcome.
- Do not abstract SQL queries unless it is absolutely necessary; prefer explicit, locally readable query code.
- Do not factor repository SQL into shared query fragments such as `select...Columns` or `...OrderBy` constants unless there is a concrete, justified need.