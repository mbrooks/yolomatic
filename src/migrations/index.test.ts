import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { unlinkSync } from "node:fs";
import { runMigrations, MIGRATIONS } from "./index.js";

describe("migrations", () => {
	const dbPath = "/tmp/yeetomatic-migrations-test.sqlite";

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

	it("adds the steering_prompt column to refinement_attempts via migration 8", () => {
		const db = new DatabaseSync(dbPath);
		runMigrations(db);

		const columns = db.prepare("PRAGMA table_info(refinement_attempts)").all() as Array<{ name: string }>;
		expect(columns.some((c) => c.name === "steering_prompt")).toBe(true);

		db.prepare(
			"INSERT INTO refinement_attempts (id, owner, repo, issue_number, requester, original_title, original_body, original_body_fingerprint, instruction_source, state, steering_prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run("r1", "o", "r", 1, "admin", "T", "B", "fp", "prompt-defaults", "running", "Focus on rollback", "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z");
		const row = db.prepare("SELECT steering_prompt FROM refinement_attempts WHERE id = ?").get("r1") as { steering_prompt: string };
		expect(row.steering_prompt).toBe("Focus on rollback");
		db.close();
	});

	it("is idempotent when adding the steering_prompt column", () => {
		const db = new DatabaseSync(dbPath);
		runMigrations(db);
		runMigrations(db);

		const columns = db.prepare("PRAGMA table_info(refinement_attempts)").all() as Array<{ name: string }>;
		const steeringColumns = columns.filter((c) => c.name === "steering_prompt");
		expect(steeringColumns).toHaveLength(1);
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
