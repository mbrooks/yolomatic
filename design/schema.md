# SQLite Schema

Yeetomatic persists runtime state in SQLite databases opened with `node:sqlite`
(`DatabaseSync`). Each long-lived store opens its own database file and runs
the shared migration set in `src/migrations/index.ts` on construction. All
migrations are idempotent (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF
NOT EXISTS`) so they re-run on every boot and can repair drifted databases.

## Database Files

The control plane does not run a single shared database. Each store owns a
file and runs the full migration set (which creates every table, including
ones the store does not use) so the file is self-consistent:

| Store                                      | Source                                       | Typical file                                                              |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------- |
| `SessionStore`                             | `src/session/store.ts`                       | `${dataDir}/sessions.db` (path supplied by caller)                        |
| `SettingsStore`                             | `src/settings/store.ts`                      | `${dataDir}/settings.db` (path supplied by caller)                        |
| `SkillsStore`                              | `src/skills/store.ts`                        | `${dataDir}/skills.db` (path supplied by caller)                         |
| `GitHubEventStore`                         | `src/github-events/store.ts`                 | `${dataDir}/github-events.db` (path supplied by caller)                   |
| `SessionLogStore`                          | `src/logging/session-log-store.ts`           | `${dataDir}/session-logs.db` (path supplied by caller)                    |

Every store sets `PRAGMA journal_mode = WAL;` on construction for safe
concurrent reads while the control plane writes.

## Migration Tracking

### `_migrations`

Bookkeeping table created by `runMigrations`. Records which migration IDs
have been acknowledged. Re-running a migration does not insert a duplicate
row; the migration body still re-executes because all migrations are
idempotent (see `MIGRATIONS.md` for the rationale).

| Column       | Type    | Constraints        | Notes                                            |
| ------------ | ------- | ------------------ | ------------------------------------------------ |
| `id`         | INTEGER | `PRIMARY KEY`      | Migration `id` from `MIGRATIONS`.                |
| `name`       | TEXT    | `NOT NULL`         | Migration `name` from `MIGRATIONS`.              |
| `applied_at` | TEXT    | `NOT NULL`         | ISO timestamp the row was inserted.             |

## Settings

### `settings`

Key-value store backing `SettingsStore`. Used for arbitrary control-plane
configuration such as onboarding flags and integration metadata.

| Column       | Type | Constraints        | Notes                                                |
| ------------ | ---- | ------------------ | ---------------------------------------------------- |
| `key`        | TEXT | `PRIMARY KEY`      | Setting key.                                         |
| `value`      | TEXT | `NOT NULL`         | Setting value (string; structure is caller-defined). |
| `updated_at` | TEXT | `NOT NULL`         | ISO timestamp of last write.                         |

Upsert pattern: `INSERT ... ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`.

## Skills

### `skills`

Backs `SkillsStore`. Stores user-authored Yeetomatic skills (`name`, `description`,
`content`) with an enable flag.

| Column       | Type    | Constraints                          | Notes                                                          |
| ------------ | ------- | ------------------------------------ | -------------------------------------------------------------- |
| `id`         | TEXT    | `PRIMARY KEY`                        | Stable skill identifier (typically a slug).                    |
| `name`       | TEXT    | `NOT NULL UNIQUE`                    | Human-readable skill name.                                     |
| `description`| TEXT    | `NOT NULL`                           | Short description used for skill matching.                    |
| `content`    | TEXT    | `NOT NULL`                           | Full skill body (SKILL.md content).                           |
| `enabled`    | INTEGER | `NOT NULL DEFAULT 1`                | 1 = active, 0 = disabled. Stored as integer boolean.          |
| `updated_at` | TEXT    | `NOT NULL`                          | ISO timestamp of last write.                                   |
| `created_at` | TEXT    | `NOT NULL`                          | ISO timestamp of first insert.                                 |

List ordering: `ORDER BY updated_at DESC, created_at DESC, rowid DESC` so the
most recently updated skill wins ties deterministically.

## GitHub Events

The GitHub event tables support webhook deduplication and REST polling
catch-up. They live in the same database file as the polling store.

### `github_event_state`

Generic key-value state for the GitHub event pipeline. Currently stores the
`last_event_received_at` cursor used to drive REST-API catch-up polling.

| Column       | Type | Constraints        | Notes                                                  |
| ------------ | ---- | ------------------ | ------------------------------------------------------ |
| `key`        | TEXT | `PRIMARY KEY`      | State key (e.g. `last_event_received_at`).            |
| `value`      | TEXT | `NOT NULL`         | State value (string; cursor or other marker).        |
| `updated_at` | TEXT | `NOT NULL`         | ISO timestamp of last write.                          |

Upsert pattern: `INSERT ... ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`.

### `github_event_dedupe`

Idempotency log for delivered GitHub webhook events. `markSeen` uses
`INSERT OR IGNORE` so re-deliveries of the same `event_id` are a no-op.

| Column       | Type | Constraints        | Notes                                                            |
| ------------ | ---- | ------------------ | ---------------------------------------------------------------- |
| `event_id`   | TEXT | `PRIMARY KEY`      | GitHub event GUID/id used for dedupe.                            |
| `owner`      | TEXT | `NOT NULL`         | Repository owner.                                                |
| `repo`       | TEXT | `NOT NULL`         | Repository name.                                                  |
| `event_type` | TEXT | `NOT NULL`         | GitHub event type (e.g. `issues`, `issue_comment`, `pull_request`). |
| `occurred_at`| TEXT | `NOT NULL`         | When the event occurred on GitHub (ISO timestamp).               |
| `seen_at`    | TEXT | `NOT NULL`         | When Yeetomatic first recorded it (ISO timestamp).                     |

Indexes:

- `idx_github_event_dedupe_owner_repo` on `(owner, repo)` — scope scans to a
  repository.
- `idx_github_event_dedupe_seen_at` on `(seen_at)` — supports pruning of old
  dedupe rows.

### `github_poll_subjects`

Tracks issues and pull requests polled for activity changes between webhook
deliveries. One row per `(owner, repo, subject_type, number)` pair.

| Column            | Type    | Constraints        | Notes                                                              |
| ----------------- | ------- | ------------------ | ------------------------------------------------------------------ |
| `subject_key`     | TEXT    | `PRIMARY KEY`      | Composite key, typically `${owner}/${repo}#${type}:${number}`.    |
| `owner`           | TEXT    | `NOT NULL`         | Repository owner.                                                  |
| `repo`            | TEXT    | `NOT NULL`         | Repository name.                                                   |
| `subject_type`    | TEXT    | `NOT NULL`         | `issue` or `pull_request`.                                         |
| `number`          | INTEGER | `NOT NULL`         | GitHub issue or PR number.                                         |
| `last_activity_at`| TEXT    | `NOT NULL`         | ISO timestamp of the most recent known activity on the subject.   |
| `last_checked_at` | TEXT    | (nullable)         | ISO timestamp of the last poll, or NULL if never polled.          |
| `created_at`      | TEXT    | `NOT NULL`         | ISO timestamp the row was first inserted.                         |
| `updated_at`      | TEXT    | `NOT NULL`         | ISO timestamp of the last mutation.                              |

Upsert pattern: `INSERT ... ON CONFLICT(subject_key) DO UPDATE SET ...`
updates `last_activity_at` and `last_checked_at` while preserving the row.
`markPollingSubjectChecked` runs a targeted `UPDATE` of `last_checked_at` and
`updated_at`.

List ordering: `ORDER BY owner, repo, subject_type, number`.

Indexes:

- `idx_github_poll_subjects_owner_repo` on `(owner, repo)`.
- `idx_github_poll_subjects_last_checked` on `(last_checked_at)` — supports
  selecting stale-poll candidates.

## Sessions

### `sessions`

Primary session state table backing `SessionStore`. The session lifecycle
state itself is serialised to `state_json`; the indexed columns mirror the
fields used for filtering and lookups so SQLite can answer those queries
without parsing JSON.

| Column         | Type    | Constraints        | Notes                                                              |
| -------------- | ------- | ------------------ | ------------------------------------------------------------------ |
| `session_key`  | TEXT    | `PRIMARY KEY`      | `github-${owner}-${repo}-issue-${issueNumber}` (see `getSessionKey`). |
| `owner`        | TEXT    | `NOT NULL`         | Repository owner.                                                  |
| `repo`         | TEXT    | `NOT NULL`         | Repository name.                                                   |
| `issue_number` | INTEGER | `NOT NULL`         | GitHub issue number.                                              |
| `status`       | TEXT    | `NOT NULL`         | One of `pending`, `working`, `waiting-feedback`, `paused`, `complete`, `failed`, `cancelled` (see `SessionStatus`). |
| `archived_at`  | TEXT    | (nullable)         | ISO timestamp when the session was archived, or NULL when active. |
| `state_json`   | TEXT    | `NOT NULL`         | Pretty-printed JSON of the full `SessionState` object.             |
| `updated_at`   | TEXT    | `NOT NULL`         | ISO timestamp of the last write.                                  |

Upsert pattern: `INSERT ... ON CONFLICT(session_key) DO UPDATE SET ...`
mirrors every column from the excluded row, including `state_json` and
`archived_at`.

Active-session listing (`listActiveStmt`):

```sql
SELECT state_json FROM sessions WHERE archived_at IS NULL ORDER BY updated_at
```

A row whose `archived_at` is non-null is treated as archived and excluded from
active reads, even though the row may still physically exist on disk in the
archive directory after `archive()` runs `DELETE FROM sessions WHERE session_key = ?`.

Indexes:

- `idx_sessions_owner_repo` on `(owner, repo)`.
- `idx_sessions_status` on `(status)`.
- `idx_sessions_archived` on `(archived_at)`.

#### `state_json` payload (`SessionState`)

The JSON document stored in `sessions.state_json`. Defined in
`src/session/store.ts`:

| Field                 | Type                                  | Notes                                                              |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `issueNumber`         | number                                | GitHub issue number (required).                                    |
| `repo`                | string                                | Repository name (required).                                        |
| `owner`               | string                                | Repository owner (required).                                       |
| `title`               | string                                | Issue title.                                                       |
| `body`                | string                                | Issue body.                                                        |
| `status`              | `SessionStatus`                       | One of the statuses above.                                         |
| `sessionPath`         | string                                | Path to the on-disk `.jsonl` transcript.                           |
| `workspacePath`       | string                                | Path to the worktree used for execution.                          |
| `lastActivity`        | string                                | ISO timestamp of the last mutation (drives staleness).             |
| `createdAt`           | string (optional)                     | ISO timestamp of creation.                                         |
| `seeded`              | boolean                               | Whether the worktree was seeded for this session.                  |
| `summary`             | string (optional)                     | Final completion summary.                                         |
| `prUrl`               | string (optional)                     | URL of the associated PR.                                          |
| `prNumber`            | number (optional)                     | Number of the associated PR.                                       |
| `iterationCount`      | number (optional)                     | Number of execution iterations.                                   |
| `labels`              | string[] (optional)                   | GitHub labels at pickup.                                           |
| `restartCount`        | number (optional)                     | Number of restarts.                                               |
| `restartedFrom`       | `SessionStatus` (optional)            | Status the session was restarted from.                            |
| `staleDetectedAt`     | string (optional)                     | When the stale detector flagged the session.                      |
| `staleReason`         | string (optional)                     | Human-readable stale reason.                                       |
| `archivedAt`          | string (optional)                     | Mirrors the `archived_at` column.                                  |
| `resumeOnBoot`        | boolean (optional)                   | Whether to resume the session on next control-plane boot.          |
| `queuedComments`      | string[] (optional)                   | Comments queued for the next iteration.                           |
| `sessionTag`          | string (optional)                     | Overrides the default `${repo}-issue-${issueNumber}` log tag.       |
| `branch`              | string (optional)                     | Branch associated with the session (defaults to `yeetomatic/issue-${issueNumber}`). |
| `taskStartedAt`       | string (optional)                     | ISO timestamp of the current/latest task execution start.          |
| `taskFinishedAt`      | string (optional)                     | ISO timestamp of the current/latest task execution finish.         |
| `totalExecutionTimeMs`| number (optional)                     | Cumulative task execution time across iterations.                  |

### `session_logs`

Append-only transcript log backing `SessionLogStore`. One row per log line
written during a session.

| Column         | Type    | Constraints                | Notes                                                          |
| -------------- | ------- | -------------------------- | -------------------------------------------------------------- |
| `id`           | INTEGER | `PRIMARY KEY AUTOINCREMENT`| Monotonic row id, preserves write order.                      |
| `session_key`  | TEXT    | `NOT NULL`                 | Foreign reference to `sessions.session_key` (not enforced).   |
| `timestamp`    | TEXT    | `NOT NULL`                 | ISO timestamp of the log entry.                               |
| `level`        | TEXT    | `NOT NULL`                 | Log level (e.g. `info`, `warn`, `error`).                     |
| `message`      | TEXT    | `NOT NULL`                 | Log message text.                                             |
| `details_json` | TEXT    | (nullable)                 | Optional JSON-encoded structured details, or NULL.            |

Note: `session_key` is not declared as a `REFERENCES` foreign key, so SQLite
does not enforce referential integrity. Deleting a session does not cascade
to `session_logs`; `SessionLogStore.clear()` deletes rows for a key on demand.

Index:

- `idx_session_logs_key_time` on `(session_key, timestamp)` — supports
  per-session, time-ordered reads.

## Lifecycle Notes

- Migrations re-run on every boot. Tables and indexes use `IF NOT EXISTS` so
  this is safe and intentionally repairs databases where `_migrations` has
  drifted from the actual schema (see `runMigrations`).
- All stores open in WAL mode for concurrent reader access.
- `SessionStore` keeps an in-memory cache keyed by `session_key`; SQLite
  remains the source of truth and the cache only short-circuits
  read-modify-write cycles.
- `SessionStore.archive()` deletes the `sessions` row after copying state to
  the archive directory; `session_logs` rows for that key are not removed.
- `SessionStore.migrateFromFileStoreIfNeeded()` imports any pre-existing
  `.state.json` files into `sessions` once per process lifetime; existing
  rows are left untouched and on-disk files are preserved for rollback.