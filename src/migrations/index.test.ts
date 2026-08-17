import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { unlinkSync } from "node:fs";
import { runMigrations, MIGRATIONS } from "./index.js";

describe("migrations", () => {
	const dbPath = "/tmp/yolomatic-migrations-test.sqlite";

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
		expect(tableNames).toContain("session_metrics");
		expect(tableNames).toContain("_migrations");
		db.close();
	});

	it("creates the session_metrics table via migration 15", () => {
		const db = new DatabaseSync(dbPath);
		runMigrations(db);

		const columns = db.prepare("PRAGMA table_info(session_metrics)").all() as Array<{ name: string }>;
		const names = columns.map((c) => c.name);
		expect(names).toContain("id");
		expect(names).toContain("session_key");
		expect(names).toContain("owner");
		expect(names).toContain("repo");
		expect(names).toContain("issue_number");
		expect(names).toContain("kind");
		expect(names).toContain("status");
		expect(names).toContain("started_at");
		expect(names).toContain("finished_at");
		expect(names).toContain("duration_ms");
		expect(names).toContain("tokens_available");
		expect(names).toContain("input_tokens");
		expect(names).toContain("output_tokens");
		expect(names).toContain("total_tokens");
		expect(names).toContain("cost");
		expect(names).toContain("recorded_at");

		db.prepare(
			"INSERT INTO session_metrics (session_key, owner, repo, issue_number, kind, status, started_at, finished_at, duration_ms, tokens_available, input_tokens, output_tokens, total_tokens, cost, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run("k", "mbrooks", "yolomatic", 1, "implementation", "complete", "2026-08-01T00:00:00Z", "2026-08-01T00:01:00Z", 60000, 1, 30, 12, 42, 1.26, "2026-08-01T00:01:00Z");
		const row = db.prepare("SELECT total_tokens, cost FROM session_metrics WHERE session_key = ?").get("k") as { total_tokens: number; cost: number };
		expect(row.total_tokens).toBe(42);
		expect(row.cost).toBeCloseTo(1.26, 10);
		db.close();
	});

	it("is idempotent when creating the session_metrics table", () => {
		const db = new DatabaseSync(dbPath);
		runMigrations(db);
		runMigrations(db);

		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_metrics'").all();
		expect(tables).toHaveLength(1);
		const rows = db.prepare("SELECT id FROM _migrations WHERE id = 15").all() as Array<{ id: number }>;
		expect(rows).toHaveLength(1);
		db.close();
	});

	it("adds the nullable worker_template repository override", () => {
		const db = new DatabaseSync(dbPath);
		runMigrations(db);

		const columns = db.prepare("PRAGMA table_info(repositories)").all() as Array<{ name: string }>;
		expect(columns.some((column) => column.name === "worker_template")).toBe(true);
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

	it("adds the proposed_title column to refinement_attempts via migration 11", () => {
		const db = new DatabaseSync(dbPath);
		runMigrations(db);

		const columns = db.prepare("PRAGMA table_info(refinement_attempts)").all() as Array<{ name: string }>;
		expect(columns.some((c) => c.name === "proposed_title")).toBe(true);

		db.prepare(
			"INSERT INTO refinement_attempts (id, owner, repo, issue_number, requester, original_title, original_body, original_body_fingerprint, instruction_source, state, proposed_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run("r2", "o", "r", 1, "admin", "T", "B", "fp", "prompt-defaults", "applied", "Clearer Title", "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z");
		const row = db.prepare("SELECT proposed_title FROM refinement_attempts WHERE id = ?").get("r2") as { proposed_title: string };
		expect(row.proposed_title).toBe("Clearer Title");
		db.close();
	});

	it("is idempotent when adding the proposed_title column", () => {
		const db = new DatabaseSync(dbPath);
		runMigrations(db);
		runMigrations(db);

		const columns = db.prepare("PRAGMA table_info(refinement_attempts)").all() as Array<{ name: string }>;
		const proposedTitleColumns = columns.filter((c) => c.name === "proposed_title");
		expect(proposedTitleColumns).toHaveLength(1);
		db.close();
	});

	it("migrates legacy session rows and logs to kind-aware keys", () => {
		const db = new DatabaseSync(dbPath);
		for (const migration of MIGRATIONS.filter((entry) => entry.id < 9)) migration.up(db);
		const legacyKey = "github-mbrooks-yolomatic-issue-534";
		const state = {
			owner: "mbrooks",
			repo: "yolomatic",
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
		).run(legacyKey, "mbrooks", "yolomatic", 534, "working", null, JSON.stringify(state), state.lastActivity);
		db.prepare(
			"INSERT INTO session_logs (session_key, timestamp, level, message) VALUES (?, ?, ?, ?)",
		).run(legacyKey, state.lastActivity, "info", "legacy log");

		runMigrations(db);

		const expectedKey = "github-mbrooks-yolomatic-issue-534-implementation";
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

	describe("migration 14: normalize_session_kinds_durable", () => {
		function insertSession(db: DatabaseSync, key: string, state: Record<string, unknown>, updatedAt = "2026-08-01T00:00:00.000Z") {
			db.prepare(
				"INSERT INTO sessions (session_key, owner, repo, issue_number, status, archived_at, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				key,
				String(state.owner ?? "mbrooks"),
				String(state.repo ?? "yolomatic"),
				Number(state.issueNumber ?? 1),
				String(state.status ?? "working"),
				null,
				JSON.stringify(state),
				updatedAt,
			);
		}

		function sessions(db: DatabaseSync): Array<{ session_key: string; state_json: string }> {
			return db.prepare("SELECT session_key, state_json FROM sessions ORDER BY session_key").all() as Array<{ session_key: string; state_json: string }>;
		}

		function migration14() {
			const migration = MIGRATIONS.find((entry) => entry.id === 14);
			if (!migration) throw new Error("migration 14 not defined");
			return migration;
		}

		// Isolate migration 14 from migration 9 (which also normalizes kinds) by
		// running the full migration set first, then inserting fresh rows that
		// miss `kind` and invoking migration 14 directly.

		it("durably normalizes sessions missing kind to implementation", () => {
			const db = new DatabaseSync(dbPath);
			runMigrations(db);
			insertSession(db, "github-mbrooks-yolomatic-issue-1-implementation", {
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 1,
				title: "No kind",
				status: "working",
			});

			migration14().up(db);

			const rows = sessions(db);
			expect(rows).toHaveLength(1);
			expect(JSON.parse(rows[0].state_json)).toMatchObject({ kind: "implementation" });
			db.close();
		});

		it("preserves refinement sessions as refinement", () => {
			const db = new DatabaseSync(dbPath);
			runMigrations(db);
			insertSession(db, "github-mbrooks-yolomatic-issue-2-implementation", {
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 2,
				kind: "implementation",
				title: "Impl",
				status: "working",
			});
			insertSession(db, "github-mbrooks-yolomatic-issue-2-refinement", {
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 2,
				kind: "refinement",
				title: "Refine",
				status: "working",
			});

			migration14().up(db);

			const rows = sessions(db);
			const byKey = Object.fromEntries(rows.map((r) => [r.session_key, JSON.parse(r.state_json).kind]));
			expect(byKey["github-mbrooks-yolomatic-issue-2-implementation"]).toBe("implementation");
			expect(byKey["github-mbrooks-yolomatic-issue-2-refinement"]).toBe("refinement");
			db.close();
		});

		it("is idempotent and does not rewrite rows whose kind is already set", () => {
			const db = new DatabaseSync(dbPath);
			runMigrations(db);
			insertSession(db, "github-mbrooks-yolomatic-issue-3-implementation", {
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 3,
				kind: "implementation",
				title: "Already normalized",
				status: "working",
			});
			const beforeUpdatedAt = db.prepare("SELECT updated_at FROM sessions").get() as { updated_at: string };

			migration14().up(db);
			migration14().up(db);

			const afterUpdatedAt = db.prepare("SELECT updated_at FROM sessions").get() as { updated_at: string };
			expect(afterUpdatedAt.updated_at).toBe(beforeUpdatedAt.updated_at);
			expect(sessions(db)).toHaveLength(1);
			db.close();
		});

		it("skips malformed state_json rows without corrupting valid rows", () => {
			const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const db = new DatabaseSync(dbPath);
			runMigrations(db);
			// Valid row missing kind.
			insertSession(db, "github-mbrooks-yolomatic-issue-4-implementation", {
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 4,
				title: "Valid",
				status: "working",
			});
			// Malformed row that cannot be parsed.
			db.prepare(
				"INSERT INTO sessions (session_key, owner, repo, issue_number, status, archived_at, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				"github-mbrooks-yolomatic-issue-5-implementation",
				"mbrooks",
				"yolomatic",
				5,
				"working",
				null,
				"{not valid json",
				"2026-08-01T00:00:00.000Z",
			);

			migration14().up(db);

			const rows = sessions(db);
			expect(rows).toHaveLength(2);
			const valid = rows.find((r) => r.session_key === "github-mbrooks-yolomatic-issue-4-implementation");
			expect(JSON.parse(valid!.state_json)).toMatchObject({ kind: "implementation" });
			// Malformed row is left untouched (still unparseable) and not dropped.
			const malformed = rows.find((r) => r.session_key === "github-mbrooks-yolomatic-issue-5-implementation");
			expect(malformed!.state_json).toBe("{not valid json");
			writeSpy.mockRestore();
			db.close();
		});
	});
});
