# Session State Migration: Retiring File-Backed Compatibility

This document covers the data-lifecycle migration that retires the legacy
file-backed session compatibility layer. SQLite is the session source of
truth; the file-backed `.state.json` format is legacy and is being removed in
stages so no deployment loses data.

> Companion to `design/schema.md` ("Lifecycle Notes") and the SQLite
> migrations in `src/migrations/index.ts`.

## Supported migration window

The oldest supported persisted session shape is:

- **Pre-migration-9 file-backed `.state.json`** — sessions persisted before
  kind-aware session keys, where `state.kind` may be absent and the on-disk
  file was the source of truth.
- **Migration 9 (`make_session_keys_kind_aware`)** — rewrites legacy
  `github-{owner}-{repo}-issue-{n}` keys to kind-aware
  `github-{owner}-{repo}-issue-{n}-{kind}` keys and sets `state.kind` in
  `state_json`. Re-runs on every boot and is idempotent.
- **Migration 14 (`normalize_session_kinds_durable`)** — dedicated durable
  normalization that ensures every `sessions` row has `kind` set
  (`implementation` default; `refinement` preserved) in `state_json`.
  Malformed rows are skipped, never dropped. Idempotent.

Rollout window: deploy the initial retirement release (this version) to every
supported deployment and confirm each one is clean via the audit below before
proceeding to the explicit legacy-file deletion step. There is no time-bounded
deadline; the gate is the audit result, not the calendar.

## Read-only preflight audit

`SessionStore.auditLegacyState()` is read-only. It reports:

- `legacyStateFiles` — readable `.state.json` files still on disk.
- `sessionsMissingKind` — `session_key`s whose `state_json` omits `kind`.
- `malformedStateFiles` — `.state.json` files that cannot be parsed as JSON.
- `clean` — `true` only when all of the above are empty.

The control plane runs this audit once at boot and logs a one-line summary when
legacy data remains. The audit never modifies files or SQLite rows, so it is
safe to run repeatedly. Malformed legacy files are reported and skipped so they
cannot corrupt valid SQLite rows.

Run the audit manually (e.g. from a one-off script or admin tool) before each
operational step below:

```ts
const audit = await sessionStore.auditLegacyState();
// audit.clean === true means the deployment is ready for legacy-file deletion
```

## Normalizing session kinds durably

Kinds are normalized durably **before** any compatibility code is removed:

1. Migration 9 sets `state.kind` and rewrites keys on every boot.
2. Migration 14 re-normalizes `kind` in every row's `state_json` and writes it
   back only when it was missing. Idempotent; no `updated_at` churn on rows
   that are already normalized.

Because both migrations re-run on every boot, kinds are durably normalized for
the current release. The `auditLegacyState()` `sessionsMissingKind` list
should be empty on any supported deployment; if it is not, restart the control
plane to re-run the migrations, then re-audit.

## Transcript archiving is preserved independently

`SessionStore.archive()` continues to move the session transcript (`.jsonl`)
to the archive directory. This behavior is decoupled from the legacy state
JSON lifecycle:

- The archived `.state.json` is written **fresh from the SQLite row**, not
  moved from the legacy on-disk file.
- The legacy on-disk `.state.json` is **not** moved or deleted by `archive()`.

`SessionStore.delete()` removes only the SQLite row. It no longer removes
on-disk `.state.json` or `.jsonl` files. Legacy-file deletion is a separate
explicit operational step (see below), never an automatic side effect of a
code deployment.

## No automatic legacy data deletion in this release

This release does **not** automatically delete any legacy `.state.json` or
`.jsonl` file. Specifically:

- `delete()` removes the SQLite row only.
- `archive()` writes fresh archived state from SQLite and moves the
  transcript, but leaves the legacy `.state.json` in place.
- The boot-time file-state importer (`migrateFromFileStoreIfNeeded()`) is no
  longer called automatically. It is retained as an explicit operational
  recovery tool and does not delete files.

## Explicit legacy-file deletion (operational step)

After the audit reports `clean: true` on a deployment, remove the legacy
on-disk files as a deliberate, separate operational step:

```ts
// Per session, once you have confirmed the SQLite row is the source of truth:
await sessionStore.removeLegacyStateFiles(owner, repo, issueNumber, kind);
```

`removeLegacyStateFiles()` removes the `.state.json` and `.jsonl` for a single
session and is idempotent. It is the only path that deletes legacy on-disk
files. Do not run it until the audit is clean. Bulk cleanup is the operator's
responsibility (e.g. a script that walks the audit results) so deletion is
always intentional and reviewable.

## Recovery and rollback

Before running the explicit deletion step on any deployment:

1. Back up the SQLite database file (`bot-state.sqlite`) and the `sessions/`
   directory containing any `.state.json` / `.jsonl` files.
2. Confirm `auditLegacyState()` reports `clean: true`.

Rollback paths:

- **Roll back the code** to the previous release. The previous release still
  runs `migrateFromFileStoreIfNeeded()` at boot, so any preserved legacy
  `.state.json` files are re-imported. No data is lost as long as the legacy
  files were not deleted.
- **Re-import legacy files** with the explicit operational importer:
  `await sessionStore.migrateFromFileStoreIfNeeded()`. This is safe to run
  repeatedly; existing SQLite rows are left untouched and on-disk files are
  preserved.
- **Re-normalize kinds** by restarting the control plane, which re-runs
  migrations 9 and 14.
- **Recover a malformed SQLite row** by deleting it and re-importing from the
  preserved legacy `.state.json` file via the explicit importer. Malformed
  legacy files are skipped by the importer and reported by the audit; they
  never overwrite valid SQLite rows.

Because no legacy file is deleted automatically in this release, rollback is
always possible until the operator runs `removeLegacyStateFiles()`.

## What is preserved

- Active and archived session state (SQLite rows; archived state written fresh
  to the archive directory).
- Implementation and refinement session identity (`kind`).
- Session transcripts and archive paths (transcript archiving intact).
- Restart, pause, cancellation, stale detection, cleanup, and PR association
  behavior.
- Recovery from malformed SQLite rows (skipped, never corrupted).
- Safe repeated startup (no re-import; no re-creation of legacy files).

## Checklist for operators

1. Deploy this release.
2. Watch the boot log for `[session-store] legacy audit: ...` lines.
3. Run `auditLegacyState()` until `clean: true` (restart to re-run
   normalization migrations if `sessionsMissingKind` is non-empty).
4. Back up `bot-state.sqlite` and the `sessions/` directory.
5. Run `removeLegacyStateFiles()` per session (or a reviewed bulk script) to
   delete legacy on-disk files.
6. Re-run `auditLegacyState()` to confirm `clean: true` after deletion.