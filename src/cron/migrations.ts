import { DatabaseSync } from "node:sqlite";

export interface Migration {
	id: number;
	name: string;
	up(db: DatabaseSync): void;
}

export const MIGRATIONS: Migration[] = [
	{
		id: 1,
		name: "create_cron_tables",
		up(db) {
			db.exec(`
				CREATE TABLE IF NOT EXISTS cron_jobs (
					id TEXT PRIMARY KEY,
					owner TEXT NOT NULL,
					repo TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL,
					prompt TEXT NOT NULL,
					scheduleType TEXT NOT NULL,
					scheduleValue TEXT NOT NULL,
					branch TEXT NOT NULL,
					notificationChannel TEXT,
					enabled INTEGER NOT NULL DEFAULT 1,
					nextRunAt TEXT NOT NULL,
					lastRunAt TEXT,
					lastRunStatus TEXT,
					lastError TEXT,
					createdAt TEXT NOT NULL
				)
			`);
			db.exec(`
				CREATE TABLE IF NOT EXISTS cron_runs (
					id TEXT PRIMARY KEY,
					cronId TEXT NOT NULL,
					owner TEXT NOT NULL,
					repo TEXT NOT NULL,
					startedAt TEXT NOT NULL,
					finishedAt TEXT NOT NULL,
					status TEXT NOT NULL,
					output TEXT NOT NULL,
					error TEXT
				)
			`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_jobs_owner_repo ON cron_jobs(owner, repo)`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(nextRunAt)`);
			db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_runs_cronId ON cron_runs(cronId)`);
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
