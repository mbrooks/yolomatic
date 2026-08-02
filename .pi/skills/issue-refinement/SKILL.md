---
name: issue-refinement
description: Repository-specific guidance for Yeetomatic's issue-refinement worker. Used when a maintainer runs `/yeetomatic issue-refinement` on an issue in mbrooks/yeetomatic; instructs the worker how to investigate the issue and produce a Proposed Task body that matches this repository's conventions.
---

# Issue Refinement

This skill governs how to investigate an issue in `mbrooks/yeetomatic` and produce a Proposed Task body. It supplements the base refinement prompt with repository-specific judgment. Do not restate the JSON output fields, allowed actions, or generic workflow already provided in the base prompt.

## Investigation approach

Read local guidance and relevant source before drawing conclusions. Prefer evidence (file references, commands, test output) over assumptions.

Read in this order, stopping when the issue is understood:

- `AGENTS.md` and `SOUL.md` — house style, guardrail rules, and boundaries.
- `README.md` — feature behavior and user-facing contracts.
- `design/issue-refinement.md` — the authoritative workflow, trust model, and result contract for this refinement flow.
- `design/architecture.md` and `design/github-workflow.md` — how events flow into sessions, worktrees, and pull requests.
- The `src/` modules referenced by the issue, plus adjacent tests and the relevant `design/*.md` documents.

Use `rg`, `ls`, and file reads to locate relevant code. Run `npm run guardrail:test` only to validate hypotheses about test behavior; do not treat a passing run as a reason to expand scope.

Record concrete findings in `investigation`: file paths, commands, and observations. Cite the specific lines or modules that support each conclusion.

## Fidelity rules

Preserve the original issue's intent and scope.

- Do not invent requirements the requester did not state.
- Do not escalate scope, rename the underlying request, or fold in adjacent work the issue does not ask for.
- Do not silently change the request. If the issue's wording is loose, keep the Proposed Task aligned with the most natural reading.
- When the issue is ambiguous, note the ambiguity in `investigation` and pick the most conservative interpretation in the Proposed Task. State the interpretation explicitly so a maintainer can correct it.
- Preserve any constraints, acceptance hints, or out-of-scope notes the original issue already contains.

## Proposed Task structure

Write `proposedTaskBody` as self-contained Markdown. A reader should understand the task from the body alone, without the original issue text.

Use these sections, omitting any that add nothing:

- **Summary** — one or two short paragraphs stating what to do and why.
- **Background** — include only when repository context (modules, design docs, prior decisions) is needed to understand the task.
- **Requirements** — concrete, scoped bullet points.
- **Acceptance criteria** — verifiable bullets. Each criterion should be checkable by a command, a file inspection, or a clear observable behavior.
- **Out of scope** — name the adjacent work explicitly excluded, including anything the issue might have implied but should not be pulled in.

Reference files with paths (e.g. `src/app/commands/handle-issue-refinement.ts`). Reference design docs by path when they constrain the work.

## Repo-specific verification guidance

Tailor acceptance criteria to what the change would touch:

- For changes that would modify files under `src/`: reference `npm run guardrail:test` as the required verification command, and state the 80% coverage requirement for changed guardrail-relevant source files (statements, branches, functions, and lines). Call out which existing or new tests cover the changed behavior.
- For changes confined to docs, skills, or `design/`: do not require test coverage. Require instead that the suite remains green (`npm run guardrail:test` still passes) and that the prose is internally consistent with the cited source files.

Do not invent new verification commands. Prefer the commands `AGENTS.md` and `README.md` already name.

## Constraints

- Do not commit, push, create a pull request, or modify any GitHub state. The control plane owns issue body replacement and comment posting; do not attempt them.
- Discard all experimental edits; leave the worktree as you found it.
- Do not instruct the control plane to take actions. The skill informs the worker's judgment only.
- Stay within the worker's boundaries: inspect files, run shell commands, make temporary edits, run tests, and use the network to validate conclusions.
- If you cannot form a credible Proposed Task, return the best conservative interpretation and explain the gap in `investigation` rather than fabricating a confident task.