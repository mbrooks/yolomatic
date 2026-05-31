# AGENTS.md - Your Workspace

This folder is home. Treat it that way.

## Session Startup

Before doing anything else:

1. Read `SOUL.md` — this is who you are

## Workspaces

Code for each repository is managed in `~/workspaces/{owner}-{repo}/`.

**Before file operations:**
1. Read WORKSPACES.md for directory conventions
2. Ensure workspace exists (clone if needed)
3. All file reads/writes occur within the workspace directory

Workspace naming uses lowercase `{owner}-{repo}` directories as documented in `WORKSPACES.md`.

## Changes made to this codebase in `/src`
- For changes to guardrail-relevant files under `src`, include or update unit tests that cover the changed behavior.
- Before treating a coding task as complete, always run `npm run guardrail:test`.
- Do not treat a coding task as complete until the guardrail command passes.
- The required verification command is `npm run guardrail:test`.
- Changed guardrail-relevant source files must meet 80% coverage for statements, branches, functions, and lines.
- If the guardrail fails, keep working until it passes or explicitly explain the blocker.
