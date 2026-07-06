import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { unlinkSync } from "node:fs";
import { runMigrations, MIGRATIONS } from "./index.js";

describe("migrations", () => {
	const dbPath = "/tmp/tars-migrations-test.sqlite";

	beforeEach(() => {
		try {
			unlinkSync(dbPath);
		} catch {
			// ignore if file doesn't exist
		}
	});

	afterEach(() => {
		try {
			unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("creates _migrations table and records applied migrations", () => {
		const db = new DatabaseSync(dbPath);
		runMigrations(db);

		const stmt = db.prepare("SELECT id, name FROM _migrations ORDER BY id");
		const rows = stmt.all() as Array<{ id: number; name: string }>;
		expect(rows.length).toBe(MIGRATIONS.length);
		expect(rows[0].id).toBe(1);
		expect(rows[0].name).toBe("create_settings_table");
		db.close();
	});

	it("creates settings, skills, and GitHub event tables", () => {
		const db = new DatabaseSync(dbPath);
		runMigrations(db);

		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
		const tableNames = tables.map((t) => t.name);
		expect(tableNames).toContain("settings");
		expect(tableNames).toContain("skills");
		expect(tableNames).toContain("github_event_state");
		expect(tableNames).toContain("github_event_dedupe");
		expect(tableNames).toContain("github_poll_subjects");
		expect(tableNames).toContain("sessions");
		expect(tableNames).toContain("session_logs");
		expect(tableNames).toContain("_migrations");
		db.close();
	});

	it("is idempotent on subsequent runs", () => {
		const db = new DatabaseSync(dbPath);
		runMigrations(db);
		runMigrations(db);

		const stmt = db.prepare("SELECT id FROM _migrations ORDER BY id");
		const rows = stmt.all() as Array<{ id: number }>;
		expect(rows.length).toBe(MIGRATIONS.length);
		db.close();
	});

	it("repairs missing tables when migration bookkeeping is ahead of schema", () => {
		const db = new DatabaseSync(dbPath);
		db.exec(`
			CREATE TABLE _migrations (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				applied_at TEXT NOT NULL
			)
		`);
		db.prepare("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)")
			.run(5, "create_sessions_tables", new Date().toISOString());

		runMigrations(db);

		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
		const tableNames = tables.map((t) => t.name);
		expect(tableNames).toContain("sessions");
		expect(tableNames).toContain("session_logs");

		const rows = db.prepare("SELECT id FROM _migrations WHERE id = 5").all() as Array<{ id: number }>;
		expect(rows).toHaveLength(1);
		db.close();
	});
});
