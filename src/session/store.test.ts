import { access, mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { SessionStore } from "./store.js";

function dbPathFor(dir: string): string {
	return path.join(dir, "sessions.sqlite");
}

describe("SessionStore (SQLite-backed)", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-store-"));
		dbPath = dbPathFor(dir);
	});

	afterEach(() => {
		try {
			unlinkSync(dbPath);
		} catch {
			// ignore
		}
		try {
			unlinkSync(`${dbPath}-wal`);
		} catch {
			// ignore
		}
		try {
			unlinkSync(`${dbPath}-shm`);
		} catch {
			// ignore
		}
	});

	it("caches sessions in memory", async () => {
		const store = new SessionStore(dbPath, dir);

		const state = {
			issueNumber: 1,
			repo: "yeetomatic",
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

		const first = await store.get("mbrooks", "yeetomatic", 1);
		expect(first?.title).toBe("Test");
		expect(first?.kind).toBe("implementation");

		// Get again (served from cache, same object identity)
		const second = await store.get("mbrooks", "yeetomatic", 1);
		expect(second).toBe(first);
	});

	it("returns null for non-existent session", async () => {
		const store = new SessionStore(dbPath, dir);
		const result = await store.get("mbrooks", "yeetomatic", 999);
		expect(result).toBeNull();
	});

	it("persists and reads session across store instances", async () => {
		const store = new SessionStore(dbPath, dir);

		const state = {
			issueNumber: 2,
			repo: "yeetomatic",
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

		// New store instance sharing the same SQLite file should read it back.
		const store2 = new SessionStore(dbPath, dir);
		const result = await store2.get("mbrooks", "yeetomatic", 2);
		expect(result?.title).toBe("Persisted");
		expect(result?.seeded).toBe(true);
	});

	it("checks existence of sessions", async () => {
		const store = new SessionStore(dbPath, dir);

		const state = {
			issueNumber: 3,
			repo: "yeetomatic",
			owner: "mbrooks",
			title: "Exists",
			body: "Body",
			status: "pending" as const,
			sessionPath: "/tmp/session.jsonl",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		expect(await store.exists("mbrooks", "yeetomatic", 3)).toBe(false);
		await store.set(state);
		expect(await store.exists("mbrooks", "yeetomatic", 3)).toBe(true);
	});

	it("computes correct paths", () => {
		const store = new SessionStore(dbPath, "/tmp/sessions");
		expect(store.getSessionKey("mbrooks", "yeetomatic", 1)).toBe("github-mbrooks-yeetomatic-issue-1");
		expect(store.getSessionPath("mbrooks", "yeetomatic", 1)).toBe("/tmp/sessions/github-mbrooks-yeetomatic/issue-1.jsonl");
		expect(store.getStatePath("mbrooks", "yeetomatic", 1)).toBe("/tmp/sessions/github-mbrooks-yeetomatic/issue-1.state.json");
	});

	it("getAll returns all active sessions", async () => {
		const store = new SessionStore(dbPath, dir);

		const state1 = {
			issueNumber: 1,
			repo: "yeetomatic",
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
			repo: "yeetomatic",
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

	it("getAll excludes archived sessions", async () => {
		const store = new SessionStore(dbPath, dir);

		const state = {
			issueNumber: 5,
			repo: "yeetomatic",
			owner: "mbrooks",
			title: "Archived",
			body: "Body",
			status: "complete" as const,
			sessionPath: store.getSessionPath("mbrooks", "yeetomatic", 5),
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
			archivedAt: new Date().toISOString(),
		};

		await store.set(state);
		expect(await store.getAll()).toHaveLength(0);
		expect(await store.get("mbrooks", "yeetomatic", 5)).toBeNull();
		expect(await store.exists("mbrooks", "yeetomatic", 5)).toBe(false);
	});

	it("getAll returns empty array when no sessions", async () => {
		const store = new SessionStore(dbPath, dir);
		expect(await store.getAll()).toEqual([]);
	});

	it("deletes session state, log files, and SQLite row", async () => {
		const store = new SessionStore(dbPath, dir);

		const state = {
			issueNumber: 7,
			repo: "yeetomatic",
			owner: "mbrooks",
			title: "Delete me",
			body: "Body",
			status: "complete" as const,
			sessionPath: store.getSessionPath("mbrooks", "yeetomatic", 7),
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		await store.set(state);
		await mkdir(path.dirname(state.sessionPath), { recursive: true });
		await writeFile(state.sessionPath, "log line\n");
		// Simulate a legacy state file alongside the SQLite row.
		await writeFile(store.getStatePath("mbrooks", "yeetomatic", 7), "{}\n");

		expect(await store.exists("mbrooks", "yeetomatic", 7)).toBe(true);

		await store.delete("mbrooks", "yeetomatic", 7);

		expect(await store.exists("mbrooks", "yeetomatic", 7)).toBe(false);
		expect(await store.get("mbrooks", "yeetomatic", 7)).toBeNull();
		await expect(access(store.getStatePath("mbrooks", "yeetomatic", 7))).rejects.toThrow();
		await expect(access(store.getSessionPath("mbrooks", "yeetomatic", 7))).rejects.toThrow();
	});

	it("computes archive paths", () => {
		const store = new SessionStore(dbPath, "/tmp/sessions");
		expect(store.getArchivePath("/tmp/archive", "mbrooks", "yeetomatic", 1)).toBe(
			"/tmp/archive/github-mbrooks-yeetomatic/issue-1.state.json",
		);
		expect(store.getSessionArchivePath("/tmp/archive", "mbrooks", "yeetomatic", 1)).toBe(
			"/tmp/archive/github-mbrooks-yeetomatic/issue-1.jsonl",
		);
	});

	it("archives session state and transcript, removes SQLite row", async () => {
		const store = new SessionStore(dbPath, dir);

		const state = {
			issueNumber: 8,
			repo: "yeetomatic",
			owner: "mbrooks",
			title: "Archive me",
			body: "Body",
			status: "complete" as const,
			sessionPath: store.getSessionPath("mbrooks", "yeetomatic", 8),
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		await store.set(state);
		await mkdir(path.dirname(state.sessionPath), { recursive: true });
		await writeFile(state.sessionPath, "log line\n");
		expect(await store.exists("mbrooks", "yeetomatic", 8)).toBe(true);

		const archiveDir = path.join(dir, "archive");
		await store.archive(state, archiveDir);

		expect(await store.exists("mbrooks", "yeetomatic", 8)).toBe(false);
		expect(await store.get("mbrooks", "yeetomatic", 8)).toBeNull();
		await expect(access(store.getArchivePath(archiveDir, "mbrooks", "yeetomatic", 8))).resolves.toBeUndefined();
		await expect(access(store.getSessionArchivePath(archiveDir, "mbrooks", "yeetomatic", 8))).resolves.toBeUndefined();

		// Archived state file should contain the archived state JSON.
		const archived = JSON.parse(
			await readFile(store.getArchivePath(archiveDir, "mbrooks", "yeetomatic", 8), "utf8"),
		) as { title: string };
		expect(archived.title).toBe("Archive me");
	});

	it("archive moves legacy on-disk state file when present", async () => {
		const store = new SessionStore(dbPath, dir);

		const state = {
			issueNumber: 11,
			repo: "yeetomatic",
			owner: "mbrooks",
			title: "Legacy",
			body: "Body",
			status: "complete" as const,
			sessionPath: store.getSessionPath("mbrooks", "yeetomatic", 11),
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		// Write a legacy state file directly (no SQLite row yet) then archive.
		await mkdir(path.dirname(store.getStatePath("mbrooks", "yeetomatic", 11)), { recursive: true });
		await writeFile(store.getStatePath("mbrooks", "yeetomatic", 11), JSON.stringify(state, null, 2));
		await writeFile(state.sessionPath, "log line\n");

		const archiveDir = path.join(dir, "archive");
		await store.archive(state, archiveDir);

		// Legacy state file was moved (not copied) to the archive dir.
		await expect(access(store.getStatePath("mbrooks", "yeetomatic", 11))).rejects.toThrow();
		await expect(access(store.getArchivePath(archiveDir, "mbrooks", "yeetomatic", 11))).resolves.toBeUndefined();
	});

	it("archive is idempotent when files are missing", async () => {
		const store = new SessionStore(dbPath, dir);

		const state = {
			issueNumber: 10,
			repo: "yeetomatic",
			owner: "mbrooks",
			title: "Missing files",
			body: "Body",
			status: "complete" as const,
			sessionPath: store.getSessionPath("mbrooks", "yeetomatic", 10),
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		await store.set(state);
		await store.delete("mbrooks", "yeetomatic", 10);

		await expect(store.archive(state, path.join(dir, "archive"))).resolves.toBeUndefined();
	});

	it("delete is idempotent for missing sessions", async () => {
		const store = new SessionStore(dbPath, dir);
		await expect(store.delete("mbrooks", "yeetomatic", 999)).resolves.toBeUndefined();
	});

	describe("migrateFromFileStoreIfNeeded", () => {
		it("imports existing file-backed sessions into SQLite", async () => {
			const store = new SessionStore(dbPath, dir);

			const state = {
				issueNumber: 1,
				repo: "yeetomatic",
				owner: "mbrooks",
				title: "Legacy",
				body: "Body",
				status: "working" as const,
				sessionPath: store.getSessionPath("mbrooks", "yeetomatic", 1),
				workspacePath: "/tmp/workspace",
				lastActivity: new Date().toISOString(),
				seeded: false,
			};
			// Pre-existing file-backed session written directly to disk.
			await mkdir(path.dirname(store.getStatePath("mbrooks", "yeetomatic", 1)), { recursive: true });
			await writeFile(store.getStatePath("mbrooks", "yeetomatic", 1), JSON.stringify(state, null, 2));

			const imported = await store.migrateFromFileStoreIfNeeded();
			expect(imported).toBe(1);

			// Readable via a fresh store instance (proves SQLite, not the file).
			const store2 = new SessionStore(dbPath, dir);
			const result = await store2.get("mbrooks", "yeetomatic", 1);
			expect(result?.title).toBe("Legacy");
			expect(result?.status).toBe("working");
			expect(result?.kind).toBe("implementation");

			// Original file is preserved (rollback path).
			await expect(access(store.getStatePath("mbrooks", "yeetomatic", 1))).resolves.toBeUndefined();
		});

		it("is idempotent and skips already-imported sessions", async () => {
			const store = new SessionStore(dbPath, dir);

			const state = {
				issueNumber: 2,
				repo: "yeetomatic",
				owner: "mbrooks",
				title: "Legacy",
				body: "Body",
				status: "pending" as const,
				sessionPath: store.getSessionPath("mbrooks", "yeetomatic", 2),
				workspacePath: "/tmp/workspace",
				lastActivity: new Date().toISOString(),
				seeded: false,
			};
			await mkdir(path.dirname(store.getStatePath("mbrooks", "yeetomatic", 2)), { recursive: true });
			await writeFile(store.getStatePath("mbrooks", "yeetomatic", 2), JSON.stringify(state, null, 2));

			expect(await store.migrateFromFileStoreIfNeeded()).toBe(1);
			// Second invocation is a no-op even though the file still exists.
			expect(await store.migrateFromFileStoreIfNeeded()).toBe(0);
			expect(await store.getAll()).toHaveLength(1);
		});

		it("preserves archivedAt on imported sessions so they stay excluded", async () => {
			const store = new SessionStore(dbPath, dir);

			const state = {
				issueNumber: 3,
				repo: "yeetomatic",
				owner: "mbrooks",
				title: "Already archived",
				body: "Body",
				status: "complete" as const,
				sessionPath: store.getSessionPath("mbrooks", "yeetomatic", 3),
				workspacePath: "/tmp/workspace",
				lastActivity: new Date().toISOString(),
				seeded: false,
				archivedAt: "2026-01-01T00:00:00.000Z",
			};
			await mkdir(path.dirname(store.getStatePath("mbrooks", "yeetomatic", 3)), { recursive: true });
			await writeFile(store.getStatePath("mbrooks", "yeetomatic", 3), JSON.stringify(state, null, 2));

			await store.migrateFromFileStoreIfNeeded();

			expect(await store.getAll()).toHaveLength(0);
			expect(await store.get("mbrooks", "yeetomatic", 3)).toBeNull();
		});

		it("skips invalid state files with a warning", async () => {
			const store = new SessionStore(dbPath, dir);
			const repoDir = path.join(dir, "github-mbrooks-yeetomatic");
			await mkdir(repoDir, { recursive: true });
			await writeFile(path.join(repoDir, "issue-1.state.json"), "not json");

			expect(await store.migrateFromFileStoreIfNeeded()).toBe(0);
			expect(await store.getAll()).toEqual([]);
		});

		it("returns 0 when sessions dir is missing", async () => {
			const store = new SessionStore(dbPath, path.join(dir, "does-not-exist"));
			expect(await store.migrateFromFileStoreIfNeeded()).toBe(0);
		});

		it("skips non-directory entries and non-state files", async () => {
			const store = new SessionStore(dbPath, dir);

			const state = {
				issueNumber: 9,
				repo: "yeetomatic",
				owner: "mbrooks",
				title: "Filtered",
				body: "Body",
				status: "pending" as const,
				sessionPath: store.getSessionPath("mbrooks", "yeetomatic", 9),
				workspacePath: "/tmp/workspace",
				lastActivity: new Date().toISOString(),
				seeded: false,
			};
			await mkdir(path.dirname(store.getStatePath("mbrooks", "yeetomatic", 9)), { recursive: true });
			await writeFile(store.getStatePath("mbrooks", "yeetomatic", 9), JSON.stringify(state, null, 2));
			await writeFile(path.join(dir, "not-a-dir.txt"), "ignore me");
			await writeFile(path.join(dir, "github-mbrooks-yeetomatic", "issue-9.log"), "ignore me");

			await store.migrateFromFileStoreIfNeeded();
			const all = await store.getAll();
			expect(all.length).toBe(1);
			expect(all[0].issueNumber).toBe(9);
		});
	});
});
