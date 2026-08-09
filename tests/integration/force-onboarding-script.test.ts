import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve("scripts/force-onboarding.js");
const testDirs: string[] = [];

afterEach(async () => {
	await Promise.all(testDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("force-onboarding script", () => {
	it("marks onboarding incomplete without removing other settings", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-force-onboarding-"));
		testDirs.push(dir);
		const dbPath = path.join(dir, "bot-state.sqlite");
		const db = new DatabaseSync(dbPath);
		db.exec(`
			CREATE TABLE settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);
		const insert = db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
		insert.run("github_username", "yolomatic-bot", new Date().toISOString());
		insert.run("onboarding_complete", "true", new Date().toISOString());
		db.close();

		const { stdout } = await execFileAsync(process.execPath, [scriptPath, dbPath]);

		const updatedDb = new DatabaseSync(dbPath);
		expect(updatedDb.prepare("SELECT value FROM settings WHERE key = ?").get("onboarding_complete")).toEqual({
			value: "false",
		});
		expect(updatedDb.prepare("SELECT value FROM settings WHERE key = ?").get("github_username")).toEqual({
			value: "yolomatic-bot",
		});
		updatedDb.close();
		expect(stdout).toContain("Refresh /yolomatic/admin to run the wizard");
	});
});
