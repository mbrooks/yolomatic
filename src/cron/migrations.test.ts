import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { unlinkSync } from "node:fs";
import { runMigrations, MIGRATIONS } from "./migrations.js";
import { CronStore } from "./store.js";

describe("cron migrations", () => {
	const dbPath = "/tmp/tars-cron-migrations-test.sqlite";

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
		expect(rows[0].name).toBe("create_cron_tables");
		db.close();
	});

	it("creates cron_jobs and cron_runs tables", () => {
		const db = new DatabaseSync(dbPath);
		runMigrations(db);

		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
		const tableNames = tables.map((t) => t.name);
		expect(tableNames).toContain("cron_jobs");
		expect(tableNames).toContain("cron_runs");
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

	it("works when invoked via CronStore constructor", () => {
		const store = new CronStore(dbPath);

		const db = new DatabaseSync(dbPath);
		const stmt = db.prepare("SELECT id, name FROM _migrations ORDER BY id");
		const rows = stmt.all() as Array<{ id: number; name: string }>;
		expect(rows.length).toBe(MIGRATIONS.length);
		expect(rows[0].id).toBe(1);
		db.close();
	});
});
