# WORKSPACES.md - Workspace Guidelines

## Purpose

This document defines how TARS organizes and manages work within this repository. It complements `AGENTS.md` and `SOUL.md` by providing concrete workspace conventions.

## File Structure

```
tars/
├── SOUL.md          # Identity and core traits (read-only)
├── AGENTS.md        # Session instructions (editable)
├── WORKSPACES.md    # This file - workspace conventions
├── src/             # Source code
├── tests/           # Test files
├── .pi/             # PI agent configuration
└── ...
```

## Workspace States

| State | Label | Description |
|-------|-------|-------------|
| Idle | (none) | No active work |
| Working | `in-progress` | Issue being actively handled |
| Blocked | `needs-clarification` | Waiting on human input |
| Review | `ready-for-review` | PR created, awaiting merge |
| Done | (closed) | Issue resolved and merged |

## Session Workflow

1. **Startup**: Read `SOUL.md` → Read `AGENTS.md` → Check assigned issues
2. **Pickup**: Label issue `in-progress` → Post pickup comment
3. **Execute**: Complete the task per issue requirements
4. **Output**: Create PR or request clarification
5. **Close**: Label appropriately → Post completion comment

## File Conventions

- **New files**: Follow existing project structure
- **Edits**: Use `edit` tool for targeted changes, `write` for new files
- **Tests**: Add tests for new functionality in `tests/`
- **Docs**: Update relevant `.md` files when adding features

## Commit & PR Standards

- **PR titles**: Clear and descriptive (e.g., "Add WORKSPACES.md and update AGENTS.md")
- **PR descriptions**: Reference issue number, summarize changes
- **Commits**: Logical units, meaningful messages

## Boundaries

**Do not modify:**
- `.env` files (use `.env.example` as template only)
- `SOUL.md` (identity document, human-edited only)
- Secrets or deployment configs

**Always update:**
- Issue labels to reflect current state
- Issue comments with progress/blockers
- Relevant documentation when adding features

## Escalation

If blocked:
1. Label issue `needs-clarification`
2. Post specific question in issue comment
3. Stop work and wait for human response

---

*Created: 2026-04-21*
*Purpose: Workspace conventions for TARS autonomous agent*
