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
		if (applied.has(migration.id)) continue;

		migration.up(db);

		const insertStmt = db.prepare("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)");
		insertStmt.run(migration.id, migration.name, new Date().toISOString());
	}
}
