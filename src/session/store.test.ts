import { access, mkdtemp, writeFile, mkdir } from "node:fs/promises";
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

	it("computes correct paths", () => {
		const store = new SessionStore("/tmp/sessions");
		expect(store.getSessionKey("mbrooks", "tars", 1)).toBe("github-mbrooks-tars-issue-1");
		expect(store.getSessionPath("mbrooks", "tars", 1)).toBe("/tmp/sessions/github-mbrooks-tars/issue-1.jsonl");
		expect(store.getStatePath("mbrooks", "tars", 1)).toBe("/tmp/sessions/github-mbrooks-tars/issue-1.state.json");
	});

	it("getAll returns all sessions from disk", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-store-"));
		const store = new SessionStore(dir);

		const state1 = {
			issueNumber: 1,
			repo: "tars",
			owner: "mbrooks",
			title: "One",
			body: "Body",
			status: "pending" as const,
			sessionPath: "/tmp/session1.jsonl",
			workspacePath: "/tmp/workspace1",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};
		const state2 = {
			issueNumber: 2,
			repo: "tars",
			owner: "mbrooks",
			title: "Two",
			body: "Body",
			status: "working" as const,
			sessionPath: "/tmp/session2.jsonl",
			workspacePath: "/tmp/workspace2",
			lastActivity: new Date().toISOString(),
			seeded: true,
		};

		await store.set(state1);
		await store.set(state2);

		const all = await store.getAll();
		expect(all.length).toBe(2);
		expect(all.map((s) => s.issueNumber).sort()).toEqual([1, 2]);
	});

	it("getAll returns empty array when sessions dir is missing", async () => {
		const dir = path.join(os.tmpdir(), "tars-store-missing-" + Date.now());
		const store = new SessionStore(dir);
		const all = await store.getAll();
		expect(all).toEqual([]);
	});

	it("getAll skips invalid state files", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-store-"));
		const repoDir = path.join(dir, "github-mbrooks-tars");
		await mkdir(repoDir, { recursive: true });
		await writeFile(path.join(repoDir, "issue-1.state.json"), "not json");

		const store = new SessionStore(dir);
		const all = await store.getAll();
		expect(all).toEqual([]);
	});

	it("deletes session state and log files", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-store-"));
		const store = new SessionStore(dir);

		const state = {
			issueNumber: 7,
			repo: "tars",
			owner: "mbrooks",
			title: "Delete me",
			body: "Body",
			status: "complete" as const,
			sessionPath: store.getSessionPath("mbrooks", "tars", 7),
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		await store.set(state);
		await writeFile(state.sessionPath, "log line\n");
		expect(await store.exists("mbrooks", "tars", 7)).toBe(true);

		await store.delete("mbrooks", "tars", 7);

		expect(await store.exists("mbrooks", "tars", 7)).toBe(false);
		expect(await store.get("mbrooks", "tars", 7)).toBeNull();
		await expect(access(store.getStatePath("mbrooks", "tars", 7))).rejects.toThrow();
		await expect(access(store.getSessionPath("mbrooks", "tars", 7))).rejects.toThrow();
	});

	it("delete is idempotent for missing sessions", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-store-"));
		const store = new SessionStore(dir);
		await expect(store.delete("mbrooks", "tars", 999)).resolves.toBeUndefined();
	});
});
