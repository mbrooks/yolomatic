import { DatabaseSync } from "node:sqlite";
import { migrateRefinementStoreIntoBotState } from "./refinement-consolidation.js";

export interface Migration {
	id: number;
	name: string;
	up(db: DatabaseSync): void;
}

export const MIGRATIONS: Migration[] = [
	{
		id: 1,
		name: "create_settings_table",
		up(db) {
			db.exec(`
				CREATE TABLE IF NOT EXISTS settings (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
		},
	},
	{
		id: 2,
		name: "create_skills_table",
		up(db) {
			db.exec(`
				CREATE TABLE IF NOT EXISTS skills (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL UNIQUE,
					description TEXT NOT NULL,
					content TEXT NOT NULL,
					enabled INTEGER NOT NULL DEFAULT 1,
					updated_at TEXT NOT NULL,
					created_at TEXT NOT NULL
				)
			`);
		},
	},
	{
		id: 3,
		name: "create_github_event_tables",
		up(db) {
			db.exec(`
				CREATE TABLE IF NOT EXISTS github_event_state (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
			db.exec(`
				CREATE TABLE IF NOT EXISTS github_event_dedupe (
					event_id TEXT PRIMARY KEY,
					owner TEXT NOT NULL,
					repo TEXT NOT NULL,
					event_type TEXT NOT NULL,
					occurred_at TEXT NOT NULL,
					seen_at TEXT NOT NULL
				)
			`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_github_event_dedupe_owner_repo ON github_event_dedupe(owner, repo)`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_github_event_dedupe_seen_at ON github_event_dedupe(seen_at)`);
		},
	},
	{
		id: 4,
		name: "create_github_poll_subjects",
		up(db) {
			db.exec(`
				CREATE TABLE IF NOT EXISTS github_poll_subjects (
					subject_key TEXT PRIMARY KEY,
					owner TEXT NOT NULL,
					repo TEXT NOT NULL,
					subject_type TEXT NOT NULL,
					number INTEGER NOT NULL,
					last_activity_at TEXT NOT NULL,
					last_checked_at TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_github_poll_subjects_owner_repo ON github_poll_subjects(owner, repo)`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_github_poll_subjects_last_checked ON github_poll_subjects(last_checked_at)`);
		},
	},
	{
		id: 5,
		name: "create_sessions_tables",
		up(db) {
			db.exec(`
				CREATE TABLE IF NOT EXISTS sessions (
					session_key TEXT PRIMARY KEY,
					owner TEXT NOT NULL,
					repo TEXT NOT NULL,
					issue_number INTEGER NOT NULL,
					status TEXT NOT NULL,
					archived_at TEXT,
					state_json TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_owner_repo ON sessions(owner, repo)`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived_at)`);

			db.exec(`
				CREATE TABLE IF NOT EXISTS session_logs (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					session_key TEXT NOT NULL,
					timestamp TEXT NOT NULL,
					level TEXT NOT NULL,
					message TEXT NOT NULL,
					details_json TEXT
				)
			`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_session_logs_key_time ON session_logs(session_key, timestamp)`);
		},
	},
	{
		id: 6,
		name: "create_repositories_table",
		up(db) {
			db.exec(`
				CREATE TABLE IF NOT EXISTS repositories (
					id TEXT PRIMARY KEY,
					owner TEXT NOT NULL COLLATE NOCASE,
					repo TEXT NOT NULL COLLATE NOCASE,
					full_name TEXT,
					visibility TEXT CHECK(visibility IN ('public', 'private', 'internal')),
					github_event_mode TEXT CHECK(github_event_mode IN ('webhook', 'polling', 'both')),
					default_branch TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					UNIQUE(owner, repo)
				)
			`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_repositories_owner_repo ON repositories(owner, repo)`);
		},
	},
	{
		id: 7,
		name: "create_refinement_tables",
		up(db) {
			db.exec(`
				CREATE TABLE IF NOT EXISTS refinement_attempts (
					id TEXT PRIMARY KEY,
					owner TEXT NOT NULL,
					repo TEXT NOT NULL,
					issue_number INTEGER NOT NULL,
					instruction_comment_id INTEGER,
					command_comment_id INTEGER,
					requester TEXT NOT NULL,
					original_title TEXT NOT NULL,
					original_body TEXT NOT NULL,
					original_body_fingerprint TEXT NOT NULL,
					proposed_task_body TEXT,
					summary TEXT,
					investigation TEXT,
					instruction_source TEXT NOT NULL,
					repo_commit TEXT,
					state TEXT NOT NULL,
					failure_reason TEXT,
					delivery_id TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_refinement_attempts_owner_repo ON refinement_attempts(owner, repo)`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_refinement_attempts_issue ON refinement_attempts(owner, repo, issue_number)`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_refinement_attempts_delivery_id ON refinement_attempts(delivery_id)`);

			db.exec(`
				CREATE TABLE IF NOT EXISTS refinement_instructions (
					owner TEXT NOT NULL,
					repo TEXT NOT NULL,
					issue_number INTEGER NOT NULL,
					comment_id INTEGER NOT NULL,
					created_at TEXT NOT NULL,
					PRIMARY KEY (owner, repo, issue_number)
				)
			`);
		},
	},
	{
		id: 8,
		name: "add_refinement_attempts_steering_prompt",
		up(db) {
			const columns = db.prepare("PRAGMA table_info(refinement_attempts)").all() as Array<{ name: string }>;
			if (!columns.some((c) => c.name === "steering_prompt")) {
				db.exec("ALTER TABLE refinement_attempts ADD COLUMN steering_prompt TEXT");
			}
		},
	},
	{
		id: 9,
		name: "make_session_keys_kind_aware",
		up(db) {
			const rows = db.prepare(
				"SELECT session_key, owner, repo, issue_number, state_json FROM sessions",
			).all() as Array<{
				session_key: string;
				owner: string;
				repo: string;
				issue_number: number;
				state_json: string;
			}>;
			const updateSession = db.prepare("UPDATE sessions SET session_key = ?, state_json = ? WHERE session_key = ?");
			const updateLogs = db.prepare("UPDATE session_logs SET session_key = ? WHERE session_key = ?");

			db.exec("BEGIN IMMEDIATE");
			try {
				for (const row of rows) {
					let state: Record<string, unknown>;
					try {
						state = JSON.parse(row.state_json) as Record<string, unknown>;
					} catch {
						continue;
					}
					const kind = state.kind === "refinement" ? "refinement" : "implementation";
					state.kind = kind;
					const nextKey = `github-${row.owner}-${row.repo}-issue-${row.issue_number}-${kind}`;
					if (row.session_key !== nextKey) {
						updateLogs.run(nextKey, row.session_key);
					}
					updateSession.run(nextKey, JSON.stringify(state, null, 2), row.session_key);
				}
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	},
	{
		id: 10,
		name: "create_users_table",
		up(db) {
			db.exec(`
				CREATE TABLE IF NOT EXISTS users (
					id TEXT PRIMARY KEY,
					full_name TEXT NOT NULL,
					username TEXT NOT NULL UNIQUE COLLATE NOCASE,
					password_hash TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);
		},
	},
	{
		id: 11,
		name: "add_refinement_attempts_proposed_title",
		up(db) {
			const columns = db.prepare("PRAGMA table_info(refinement_attempts)").all() as Array<{ name: string }>;
			if (!columns.some((c) => c.name === "proposed_title")) {
				db.exec("ALTER TABLE refinement_attempts ADD COLUMN proposed_title TEXT");
			}
		},
	},
	{
		id: 12,
		name: "create_github_poll_repo_baselines",
		up(db) {
			db.exec(`
				CREATE TABLE IF NOT EXISTS github_poll_repo_baselines (
					owner TEXT NOT NULL,
					repo TEXT NOT NULL,
					baseline_at TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					PRIMARY KEY (owner, repo)
				)
			`);
		},
	},
	{
		id: 13,
		name: "add_repositories_worker_template",
		up(db) {
			const columns = db.prepare("PRAGMA table_info(repositories)").all() as Array<{ name: string }>;
			if (!columns.some((column) => column.name === "worker_template")) {
				db.exec("ALTER TABLE repositories ADD COLUMN worker_template TEXT");
			}
		},
	},
	{
		id: 14,
		name: "normalize_session_kinds_durable",
		up(db) {
			const rows = db.prepare(
				"SELECT session_key, state_json FROM sessions",
			).all() as Array<{ session_key: string; state_json: string }>;
			const updateStmt = db.prepare(
				"UPDATE sessions SET state_json = ? WHERE session_key = ?",
			);

			db.exec("BEGIN IMMEDIATE");
			try {
				for (const row of rows) {
					let state: Record<string, unknown>;
					try {
						state = JSON.parse(row.state_json) as Record<string, unknown>;
					} catch {
						// Leave malformed rows untouched so they cannot corrupt valid data.
						continue;
					}
				const kind = state.kind === "refinement" ? "refinement" : "implementation";
				if (state.kind === kind) continue;
				state.kind = kind;
				updateStmt.run(JSON.stringify(state, null, 2), row.session_key);
				}
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	},
	{
		id: 15,
		name: "create_session_metrics_table",
		up(db) {
			db.exec(`
				CREATE TABLE IF NOT EXISTS session_metrics (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					session_key TEXT NOT NULL,
					owner TEXT NOT NULL,
					repo TEXT NOT NULL,
					issue_number INTEGER NOT NULL,
					kind TEXT NOT NULL,
					status TEXT NOT NULL,
					started_at TEXT NOT NULL,
					finished_at TEXT NOT NULL,
					duration_ms INTEGER NOT NULL,
					tokens_available INTEGER NOT NULL,
					input_tokens INTEGER NOT NULL,
					output_tokens INTEGER NOT NULL,
					total_tokens INTEGER NOT NULL,
					cost REAL NOT NULL,
					recorded_at TEXT NOT NULL
				)
			`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_session_metrics_recorded ON session_metrics(recorded_at)`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_session_metrics_owner_repo ON session_metrics(owner, repo)`);
		},
	},
	{
		id: 16,
		name: "migrate_refinement_store_into_bot_state",
		up(db) {
			// Delegates to `refinement-consolidation.ts`. See that module and
			// `design/refinement-migration.md` for the documented, idempotent,
			// rollback-safe copy of legacy `refinement.sqlite` rows into
			// `bot-state.sqlite`.
			migrateRefinementStoreIntoBotState(db);
		},
	},
];

export function runMigrations(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at TEXT NOT NULL
		)
	`);

	const appliedStmt = db.prepare("SELECT id FROM _migrations");
	const appliedRows = appliedStmt.all() as Array<{ id: number }>;
	const applied = new Set(appliedRows.map((r) => r.id));

	for (const migration of MIGRATIONS) {
		// Re-run bootstrap migrations even if the bookkeeping row exists.
		// Every current migration is intentionally idempotent, and this lets
		// startup repair databases where `_migrations` drifted from reality.
		migration.up(db);

		if (!applied.has(migration.id)) {
			const insertStmt = db.prepare("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)");
			insertStmt.run(migration.id, migration.name, new Date().toISOString());
		}
	}
}
