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

	it("migrates legacy session rows and logs to kind-aware keys", () => {
		const db = new DatabaseSync(dbPath);
		for (const migration of MIGRATIONS.filter((entry) => entry.id < 9)) migration.up(db);
		const legacyKey = "github-mbrooks-yeetomatic-issue-534";
		const state = {
			owner: "mbrooks",
			repo: "yeetomatic",
			issueNumber: 534,
			title: "Legacy implementation",
			body: "Body",
			status: "working",
			sessionPath: "/tmp/issue-534.jsonl",
			workspacePath: "/tmp/issue-534",
			lastActivity: "2026-08-01T00:00:00.000Z",
			seeded: false,
		};
		db.prepare(
			"INSERT INTO sessions (session_key, owner, repo, issue_number, status, archived_at, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(legacyKey, "mbrooks", "yeetomatic", 534, "working", null, JSON.stringify(state), state.lastActivity);
		db.prepare(
			"INSERT INTO session_logs (session_key, timestamp, level, message) VALUES (?, ?, ?, ?)",
		).run(legacyKey, state.lastActivity, "info", "legacy log");

		runMigrations(db);

		const expectedKey = "github-mbrooks-yeetomatic-issue-534-implementation";
		const row = db.prepare("SELECT session_key, state_json FROM sessions").get() as {
			session_key: string;
			state_json: string;
		};
		expect(row.session_key).toBe(expectedKey);
		expect(JSON.parse(row.state_json)).toMatchObject({ kind: "implementation", sessionPath: state.sessionPath });
		expect(db.prepare("SELECT session_key FROM session_logs").get()).toEqual({ session_key: expectedKey });
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
