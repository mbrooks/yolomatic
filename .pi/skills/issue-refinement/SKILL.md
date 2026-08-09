---
name: issue-refinement
description: Repository-specific guidance for Yolomatic's issue-refinement worker. Used when a maintainer runs `/yolomatic issue-refinement` on an issue in mbrooks/yolomatic; instructs the worker how to investigate the issue and produce a Proposed Task body that matches this repository's conventions.
---

# Issue Refinement

This skill governs how to investigate an issue in `mbrooks/yolomatic` and produce a Proposed Task body. It supplements the base refinement prompt with repository-specific judgment. Do not restate the JSON output fields, allowed actions, or generic workflow already provided in the base prompt.

## Investigation approach

Read local guidance and relevant source before drawing conclusions. Prefer evidence (file references, commands, test output) over assumptions.

Read `AGENTS.md` and `SOUL.md` first. Then read only the material needed for the issue:

- Use `README.md` for user-facing behavior and supported workflows.
- Read the `design/*.md` documents that directly constrain the requested change. Do not read the issue-refinement or GitHub workflow designs unless the issue concerns those systems.
- Inspect the `src/` modules referenced by the issue, their adjacent tests, and the nearest callers or consumers needed to understand the behavior.

Stop once the requested behavior, important constraints, and credible verification are understood. Use `rg`, `ls`, and file reads to locate relevant code. Run tests only to validate a concrete hypothesis; do not run the full guardrail merely to make the investigation look comprehensive.

Record the detailed evidence in `investigation`: file paths, commands, tests, and observations. Promote a finding into `proposedTaskBody` only when it helps a maintainer understand the requested outcome or helps an implementation agent avoid a material mistake.

## Fidelity rules

Preserve the original issue's intent and scope.

- Do not invent requirements the requester did not state.
- Do not escalate scope, rename the underlying request, or fold in adjacent work the issue does not ask for.
- Do not turn a possible implementation into a requirement unless the repository or requester already constrains the solution.
- Do not silently change the request. If the issue's wording is loose, keep the Proposed Task aligned with the most natural reading.
- When the issue is ambiguous, note the ambiguity in `investigation` and pick the most conservative interpretation in the Proposed Task. If the ambiguity materially affects product behavior, scope, or architecture, surface it briefly as an open question instead of speculating through detailed requirements.
- Preserve any constraints, acceptance hints, or out-of-scope notes the original issue already contains.

## Proposed Task structure

Write `proposedTaskBody` as self-contained Markdown for two audiences: a concise human-facing task at the top and optional implementation guidance for agents at the bottom.

### Human-facing task

The top of the issue is the authoritative task contract. Target 250–500 words; exceed that only when the request genuinely needs more context. A maintainer should be able to review this portion without expanding the agent notes.

Use only the sections that improve understanding:

- **Summary** — one or two short paragraphs stating the requested outcome and why it matters.
- **Desired behavior** or **Requirements** — scoped, observable behavior rather than a file-by-file implementation plan.
- **Acceptance criteria** — a short list of verifiable outcomes.
- **Out of scope** or **Open questions** — only when needed to prevent scope drift or request a material human decision.

Include background only when it is essential to understand the task. State each requirement once. Do not include an investigation transcript, dependency inventory, exhaustive file list, or speculative architecture in the human-facing portion.

### Agent implementation notes

When repository findings would materially help implementation, put them after the human-facing task in a collapsed block at the bottom:

```markdown
---

<details>
<summary>Implementation notes for agents</summary>

The human-facing requirements above are authoritative. These notes are non-binding guidance. Verify them against the current repository before implementation.

### Repository findings

- Relevant current behavior and constraints.

### Likely implementation areas

- `src/example.ts`

### Test scenarios

1. Observable scenario to cover.

</details>
```

Use only the subsections that add value. Put task-specific source paths, dependency details, likely test locations, and technical cautions here. Keep decisions requiring human approval visible in the human-facing portion rather than burying them in the collapsed block.

The agent notes may be more detailed than the human-facing task, but they must remain relevant and non-repetitive. Do not copy repository-wide policies from `AGENTS.md`, restate the requirements, or use hidden HTML comments.

## Repo-specific verification guidance

Keep verification proportional to the task:

- For changes under `src/`, include one human-facing criterion that `npm run guardrail:test` passes. `AGENTS.md` already governs TDD and coverage; do not repeat its policy in the issue.
- Put task-specific test scenarios or likely test locations in the agent notes when they clarify behavior. Do not prescribe an exhaustive test-file checklist.
- For changes confined to docs, skills, or `design/`, require internal consistency and a green `npm run guardrail:test`; do not add coverage requirements.

Do not invent new verification commands. Prefer commands already named by `AGENTS.md` and `README.md`.

## Optional title

The base prompt lists `proposedTitle` as an optional field in the JSON result.
Use it sparingly:

- Omit `proposedTitle` (or leave it empty) when the original issue title is
  already clear and descriptive.
- Only propose a title when the original is unclear, misleading, or too vague to
  identify the task.
- Keep any proposed title concise and descriptive. Do not reframe the underlying
  request or expand scope through the title.

The control plane applies the proposed title only when it differs from the
original and the issue title has not changed during the run.

## Constraints

- Do not commit, push, create a pull request, or modify any GitHub state. The control plane owns issue body and title replacement and comment posting; do not attempt them.
- Discard all experimental edits; leave the worktree as you found it.
- Do not instruct the control plane to take actions. The skill informs the worker's judgment only.
- Stay within the worker's boundaries: inspect files, run shell commands, make temporary edits, run tests, and use the network to validate conclusions.
- If you cannot form a credible Proposed Task, return the best conservative interpretation and explain the gap in `investigation` rather than fabricating a confident task.
