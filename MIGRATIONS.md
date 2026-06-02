# Migration Tracking

This note separates compatibility-sensitive migrations from behavior-preserving
refactors. Refactor passes should keep existing public APIs, storage layouts,
branch conventions, and user-facing contracts stable. The items below require
their own migration tickets before implementation.

## Migration Candidates

### Dependency And Framework Upgrades

Scope:
- React
- Vite
- Vitest
- TypeScript
- Node.js APIs

Compatibility plan:
- Document the supported runtime and toolchain versions before changing them.
- Keep application behavior and generated artifacts stable unless the migration
  ticket explicitly scopes a change.
- Capture any dependency lockfile churn and test-environment changes in the
  migration PR.

Contract tests:
- Full admin build.
- Full guardrail test suite.
- Targeted tests for any changed test runner, bundler, or runtime behavior.

### File-Backed Sessions To SQLite

Scope:
- Session state files
- Session transcript files
- Session archive layout

Compatibility plan:
- Define the on-disk schema and migration path from existing session files.
- Preserve reads for existing sessions until a deliberate cleanup window.
- Include rollback notes for restoring file-backed reads if migration fails.

Contract tests:
- Existing session files remain readable after migration.
- SQLite-backed sessions preserve status transitions, PR metadata, queued
  feedback, stale-session metadata, and archive behavior.
- Resume-on-boot behavior works for both migrated and newly-created sessions.

### Admin REST And WebSocket Contracts

Scope:
- `/api/*` responses and request payloads
- Admin session commands
- WebSocket message types, channels, and authentication behavior

Compatibility plan:
- Document old and new payloads.
- Add transitional handling for renamed fields or message types when possible.
- Version or explicitly announce breaking contract changes.

Contract tests:
- REST route tests for old and new payload expectations.
- WebSocket integration tests for status, log, and issue-chat channels.
- Authentication and onboarding-mode behavior stays covered.

### GitHub Label And Status Naming

Scope:
- GitHub labels such as `tars-working`, `tars-feedback-required`,
  `tars-pr-created`, and `tars-complete`
- Session status names and status-transition semantics

Compatibility plan:
- Define label aliases or a label migration sequence before renaming labels.
- Keep old labels recognized until existing issues and PRs are migrated.
- Document any change to issue comments or status protocol text.

Contract tests:
- Webhook handling accepts old and new labels during the compatibility window.
- Status transitions still update labels correctly.
- Existing sessions with old labels remain resumable.

### Workspace Storage And Branch Naming

Scope:
- Workspace root layout
- Worktree paths
- Issue branch names
- Cron branch names

Compatibility plan:
- Define path and branch-name mapping from old to new conventions.
- Avoid force-moving existing worktrees without a cleanup or recovery plan.
- Preserve PR branch association checks during the migration window.

Contract tests:
- Existing issue and cron worktrees are detected correctly.
- Branch-to-session invariant checks keep rejecting mismatches.
- Commit, push, cleanup, and archive behavior works across old and new layouts.

## Migration Ticket Template

Each migration ticket should include:

- Scope: exact contracts, files, APIs, or storage layouts affected.
- Compatibility plan: how existing users, sessions, PRs, and deployments keep
  working during rollout.
- Rollout notes: sequencing, operational checks, rollback path, and cleanup
  timing.
- Contract tests: tests that prove old behavior still works or intentionally
  documents the breaking change.

If a task lacks those details, keep it out of behavior-preserving refactor work
until a migration ticket is written.
