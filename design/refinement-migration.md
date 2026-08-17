# Refinement Store Migration: Consolidating into `bot-state.sqlite`

This document covers the data-lifecycle migration that moves refinement
persistence out of the standalone `refinement.sqlite` database and into the
canonical `bot-state.sqlite` database.

> Companion to `design/schema.md` and the SQLite migration set in
> `src/migrations/refinement-consolidation.ts` (migration 16, registered via
> `src/migrations/index.ts` as `migrate_refinement_store_into_bot_state`).

## Why this migration exists

Historically `RefinementStore` opened its own `refinement.sqlite` file while
every other long-lived store opened `bot-state.sqlite`. Because every store
runs the shared `runMigrations()` set, both database files received the
complete schema even though each file only used part of it. The result was
that the canonical `bot-state.sqlite` could contain empty refinement tables
while live refinement rows lived in the separate file.

This migration copies all refinement rows into `bot-state.sqlite` once, marks
the copy as complete, and lets `RefinementStore` read and write the canonical
database. It is storage migration work, not a refactor.

## Source and destination

| Role         | File                                                | Notes                                                            |
| ------------ | --------------------------------------------------- | ---------------------------------------------------------------- |
| Source       | `${memoryDir}/refinement.sqlite`                    | Legacy file written by previous releases. Preserved by this migration. |
| Destination  | `${memoryDir}/bot-state.sqlite`                     | Canonical control-plane database. Already holds the rest of the schema. |

`memoryDir` is the control-plane memory directory (the same directory every
other store opens `bot-state.sqlite` from). The migration derives the source
path from the destination file's directory via `PRAGMA database_list`, so it
does not need a separate configured path.

## Supported pre-migration states

The migration handles each of the following states deterministically:

- **No legacy file.** The migration is a no-op. The marker table is created
  on `bot-state.sqlite` but no marker row is written.
- **Legacy file with refinement rows, empty destination.** All rows are
  copied in a single transaction and a marker row is recorded.
- **Legacy file with rows that already exist identically in the destination.**
  Identical rows are left untouched; only rows missing from the destination
  are copied.
- **Legacy file exists but lacks refinement tables** (e.g. a stray empty
  file created by an aborted startup). The migration skips cleanly; no copy
  is attempted and no marker is written.
- **Conflicting ids.** A legacy row whose primary key already exists in the
  destination but whose content differs aborts the migration. No partial copy
  survives (see Rollback below).

## How the copy runs

Migration 16 only acts when the database being migrated is `bot-state.sqlite`
(the canonical file). The shared migration set is still applied to the legacy
`refinement.sqlite` by older code paths; copying from a file into itself is
skipped by name.

The copy is orchestrated with explicit, local SQL:

1. `ATTACH DATABASE ? AS legacy_refinement` — the legacy file is attached so
   its rows can be read directly. It is detached in a `finally` block.
2. `BEGIN IMMEDIATE` — the entire copy runs in one transaction.
3. **Attempts.** Rows whose `id` is not already present in the destination
   are inserted. Then any legacy row whose `id` already exists in the
   destination with differing content is treated as a conflict and aborts the
   transaction. Identical rows are left untouched.
4. **Instructions.** Rows whose composite key
   `(owner, repo, issue_number)` is not already present are inserted. As with
   attempts, a same-key row with differing content aborts the transaction.
5. A marker row is inserted into `refinement_store_migration` inside the same
   transaction.
6. `COMMIT`.

All SQL is written inline in the migration. There are no generic query
builders or shared SQL fragments; column lists are local constants within the
migration function.

## Idempotence and startup safety

`runMigrations()` re-runs every migration on every boot (the existing
convention — see `design/schema.md` "Lifecycle Notes"). Migration 16 is
idempotent:

- A marker row (`refinement_store_migration.id = 1`) records a successful
  copy. When the marker is present, the migration returns immediately.
- The new-row `INSERT` only copies ids/keys missing from the destination.
- The conflict check is read-only and deterministic.

Re-running the migration after a successful copy changes no rows and writes
no duplicate marker.

## Rollback

The copy runs inside a single `BEGIN IMMEDIATE` transaction. If any statement
fails — a conflict, a malformed legacy row, or any SQLite error — the
transaction is rolled back and the error is re-thrown. No marker is recorded.
The next startup re-attempts the copy.

Because the conflict check runs after the new-row inserts, a conflict rolls
back every row copied in that attempt, so a partially-completed prior attempt
cannot leave the destination in a mixed state.

The legacy `refinement.sqlite` file is never modified or deleted by this
migration. It remains on disk as the rollback source for at least one
release/deployment cycle.

### Operator rollback

To roll back a deployment that has already migrated:

1. Stop the control plane.
2. Restore the previous release (which still opens `refinement.sqlite`).
3. The legacy file is intact, so refinement reads and writes resume from it.
   Any rows written to `bot-state.sqlite` after the migration are not in the
   legacy file; if those rows matter, restore them manually before reverting.

Because the legacy file is preserved, rollback is always possible until the
explicit legacy-file cleanup step (below) is run.

## Explicit legacy-file cleanup (separate operational step)

This release does **not** delete `refinement.sqlite`. After confirming a
deployment has migrated cleanly (marker row present, refinement reads return
expected data), remove the legacy file as a deliberate, reviewed operational
step:

```sh
# Only after verifying the migration marker exists and refinement reads work:
rm "${memoryDir}/refinement.sqlite" "${memoryDir}/refinement.sqlite-wal" "${memoryDir}/refinement.sqlite-shm"
```

Bulk cleanup is the operator's responsibility so deletion is always
intentional and reviewable. Do not run it until the marker row is present and
refinement reads from `bot-state.sqlite` return the expected historical data.

## What is preserved

- Every `refinement_attempts` field: proposed title/body, summary,
  investigation, steering prompt, state, failure reason, delivery id, and
  timestamps.
- `refinement_instructions` deduplication records.
- Attempt ordering and latest-attempt lookup behavior.
- Concurrent-read WAL behavior (`PRAGMA journal_mode = WAL` on every store).
- Existing session, settings, user, skill, repository, event, log, and
  metrics rows in `bot-state.sqlite` (the migration only writes refinement
  tables and the marker table).

## Checklist for operators

1. Back up `${memoryDir}/bot-state.sqlite` and `${memoryDir}/refinement.sqlite`
   before deploying.
2. Deploy this release.
3. Watch the startup log; migration 16 runs as part of `runMigrations()` on
   the first `bot-state.sqlite` open.
4. Verify the marker row:
   ```sh
   sqlite3 "${memoryDir}/bot-state.sqlite" \
     "SELECT id, source_path, attempts_copied, instructions_copied, migrated_at FROM refinement_store_migration;"
   ```
5. Verify refinement reads return historical data through the admin UI or
   `RefinementStore` queries.
6. After confirming success on every deployment, run the explicit
   legacy-file cleanup step above.

## What this migration does not do

- It does not introduce a new repository abstraction or shared SQL layer.
- It does not delete the legacy file.
- It does not change the `refinement_attempts` or `refinement_instructions`
  schema; both tables already exist in `bot-state.sqlite` via the shared
  migration set.
- It does not alter migration bookkeeping (`_migrations`); the durable marker
  is a separate table so re-running the idempotent migration body can skip the
  copy without relying on `_migrations` semantics.