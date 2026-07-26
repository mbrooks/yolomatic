import { DatabaseSync } from "node:sqlite";

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
