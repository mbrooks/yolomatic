import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "./store.js";

describe("SessionStore", () => {
	it("caches sessions in memory", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-store-"));
		const store = new SessionStore(dir);

		const state = {
			issueNumber: 1,
			repo: "tars",
			owner: "mbrooks",
			title: "Test",
			body: "Body",
			status: "pending" as const,
			sessionPath: "/tmp/session.jsonl",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		await store.set(state);

		// Second get should use cache
		const first = await store.get("mbrooks", "tars", 1);
		expect(first?.title).toBe("Test");

		// Get again (from cache)
		const second = await store.get("mbrooks", "tars", 1);
		expect(second).toEqual(first);
	});

	it("returns null for non-existent session", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-store-"));
		const store = new SessionStore(dir);
		const result = await store.get("mbrooks", "tars", 999);
		expect(result).toBeNull();
	});

	it("persists and reads session from disk", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-store-"));
		const store = new SessionStore(dir);

		const state = {
			issueNumber: 2,
			repo: "tars",
			owner: "mbrooks",
			title: "Persisted",
			body: "Body",
			status: "working" as const,
			sessionPath: "/tmp/session.jsonl",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: true,
		};

		await store.set(state);

		// Create a new store instance to force disk read
		const store2 = new SessionStore(dir);
		const result = await store2.get("mbrooks", "tars", 2);
		expect(result?.title).toBe("Persisted");
		expect(result?.seeded).toBe(true);
	});

	it("checks existence of session files", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-store-"));
		const store = new SessionStore(dir);

		const state = {
			issueNumber: 3,
			repo: "tars",
			owner: "mbrooks",
			title: "Exists",
			body: "Body",
			status: "pending" as const,
			sessionPath: "/tmp/session.jsonl",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		expect(await store.exists("mbrooks", "tars", 3)).toBe(false);
		await store.set(state);
		expect(await store.exists("mbrooks", "tars", 3)).toBe(true);
	});

	it("returns all sessions from disk via getAll", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-store-"));
		const store = new SessionStore(dir);

		const stateA = {
			issueNumber: 10,
			repo: "tars",
			owner: "mbrooks",
			title: "A",
			body: "Body",
			status: "pending" as const,
			sessionPath: "/tmp/session.jsonl",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};
		const stateB = {
			issueNumber: 11,
			repo: "case",
			owner: "mbrooks",
			title: "B",
			body: "Body",
			status: "working" as const,
			sessionPath: "/tmp/session.jsonl",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: true,
		};

		await store.set(stateA);
		await store.set(stateB);

		const store2 = new SessionStore(dir);
		const all = await store2.getAll();
		expect(all).toHaveLength(2);
		expect(all.map((s) => s.title).sort()).toEqual(["A", "B"]);
	});

	it("returns empty array from getAll when sessions dir is missing", async () => {
		const dir = path.join(os.tmpdir(), `tars-store-nonexistent-${Date.now()}`);
		const store = new SessionStore(dir);
		const all = await store.getAll();
		expect(all).toEqual([]);
	});

	it("skips invalid state files in getAll and logs warning", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-store-"));
		const store = new SessionStore(dir);

		const valid = {
			issueNumber: 20,
			repo: "tars",
			owner: "mbrooks",
			title: "Valid",
			body: "Body",
			status: "complete" as const,
			sessionPath: "/tmp/session.jsonl",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: true,
		};
		await store.set(valid);

		// Write an invalid state file
		const invalidPath = path.join(dir, "github-mbrooks-tars", "issue-21.state.json");
		await writeFile(invalidPath, "not json", "utf8");

		const store2 = new SessionStore(dir);
		const all = await store2.getAll();
		expect(all).toHaveLength(1);
		expect(all[0].title).toBe("Valid");
	});
});
