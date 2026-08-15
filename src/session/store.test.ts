import { access, mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { SessionStore } from "./store.js";

function dbPathFor(dir: string): string {
	return path.join(dir, "sessions.sqlite");
}

describe("SessionStore (SQLite-backed)", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-store-"));
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
			repo: "yolomatic",
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

		const first = await store.get("mbrooks", "yolomatic", 1);
		expect(first?.title).toBe("Test");
		expect(first?.kind).toBe("implementation");

		// Get again (served from cache, same object identity)
		const second = await store.get("mbrooks", "yolomatic", 1);
		expect(second).toBe(first);
	});

	it("returns null for non-existent session", async () => {
		const store = new SessionStore(dbPath, dir);
		const result = await store.get("mbrooks", "yolomatic", 999);
		expect(result).toBeNull();
	});

	it("persists and reads session across store instances", async () => {
		const store = new SessionStore(dbPath, dir);

		const state = {
			issueNumber: 2,
			repo: "yolomatic",
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
		const result = await store2.get("mbrooks", "yolomatic", 2);
		expect(result?.title).toBe("Persisted");
		expect(result?.seeded).toBe(true);
	});

	it("checks existence of sessions", async () => {
		const store = new SessionStore(dbPath, dir);

		const state = {
			issueNumber: 3,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Exists",
			body: "Body",
			status: "pending" as const,
			sessionPath: "/tmp/session.jsonl",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		expect(await store.exists("mbrooks", "yolomatic", 3)).toBe(false);
		await store.set(state);
		expect(await store.exists("mbrooks", "yolomatic", 3)).toBe(true);
	});

	it("computes correct paths", () => {
		const store = new SessionStore(dbPath, "/tmp/sessions");
		expect(store.getSessionKey("mbrooks", "yolomatic", 1)).toBe("github-mbrooks-yolomatic-issue-1-implementation");
		expect(store.getSessionKey("mbrooks", "yolomatic", 1, "refinement")).toBe("github-mbrooks-yolomatic-issue-1-refinement");
		expect(store.getSessionPath("mbrooks", "yolomatic", 1)).toBe("/tmp/sessions/github-mbrooks-yolomatic/issue-1.jsonl");
		expect(store.getSessionPath("mbrooks", "yolomatic", 1, "refinement")).toBe("/tmp/sessions/github-mbrooks-yolomatic/issue-1-refinement.jsonl");
		expect(store.getStatePath("mbrooks", "yolomatic", 1)).toBe("/tmp/sessions/github-mbrooks-yolomatic/issue-1.state.json");
	});

	it("stores implementation and refinement rows independently for one issue", async () => {
		const store = new SessionStore(dbPath, dir);
		const base = {
			issueNumber: 7,
			repo: "yolomatic",
			owner: "mbrooks",
			body: "Body",
			status: "pending" as const,
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};
		await store.set({ ...base, kind: "implementation", title: "Implementation", sessionPath: "/tmp/implementation.jsonl" });
		await store.set({ ...base, kind: "refinement", title: "Refinement", sessionPath: "/tmp/refinement.jsonl" });

		expect(await store.get("mbrooks", "yolomatic", 7, "implementation")).toMatchObject({ title: "Implementation" });
		expect(await store.get("mbrooks", "yolomatic", 7, "refinement")).toMatchObject({ title: "Refinement" });
		expect(await store.getAll()).toHaveLength(2);
	});

	it("getAll returns all active sessions", async () => {
		const store = new SessionStore(dbPath, dir);

		const state1 = {
			issueNumber: 1,
			repo: "yolomatic",
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
			repo: "yolomatic",
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
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Archived",
			body: "Body",
			status: "complete" as const,
			sessionPath: store.getSessionPath("mbrooks", "yolomatic", 5),
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
			archivedAt: new Date().toISOString(),
		};

		await store.set(state);
		expect(await store.getAll()).toHaveLength(0);
		expect(await store.get("mbrooks", "yolomatic", 5)).toBeNull();
		expect(await store.exists("mbrooks", "yolomatic", 5)).toBe(false);
	});

	it("getAll returns empty array when no sessions", async () => {
		const store = new SessionStore(dbPath, dir);
		expect(await store.getAll()).toEqual([]);
	});

	it("deletes only the SQLite row; legacy state and transcript files remain", async () => {
		const store = new SessionStore(dbPath, dir);

		const state = {
			issueNumber: 7,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Delete me",
			body: "Body",
			status: "complete" as const,
			sessionPath: store.getSessionPath("mbrooks", "yolomatic", 7),
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		await store.set(state);
		await mkdir(path.dirname(state.sessionPath), { recursive: true });
		await writeFile(state.sessionPath, "log line\n");
		// Simulate a legacy state file alongside the SQLite row.
		await writeFile(store.getStatePath("mbrooks", "yolomatic", 7), "{}\n");

		expect(await store.exists("mbrooks", "yolomatic", 7)).toBe(true);

		await store.delete("mbrooks", "yolomatic", 7);

		expect(await store.exists("mbrooks", "yolomatic", 7)).toBe(false);
		expect(await store.get("mbrooks", "yolomatic", 7)).toBeNull();
		// Legacy-file deletion is a separate explicit operational step: the
		// on-disk state and transcript files are NOT removed automatically.
		await expect(access(store.getStatePath("mbrooks", "yolomatic", 7))).resolves.toBeUndefined();
		await expect(access(store.getSessionPath("mbrooks", "yolomatic", 7))).resolves.toBeUndefined();
	});

	it("computes archive paths", () => {
		const store = new SessionStore(dbPath, "/tmp/sessions");
		expect(store.getArchivePath("/tmp/archive", "mbrooks", "yolomatic", 1)).toBe(
			"/tmp/archive/github-mbrooks-yolomatic/issue-1.state.json",
		);
		expect(store.getSessionArchivePath("/tmp/archive", "mbrooks", "yolomatic", 1)).toBe(
			"/tmp/archive/github-mbrooks-yolomatic/issue-1.jsonl",
		);
	});

	it("archives session state and transcript, removes SQLite row", async () => {
		const store = new SessionStore(dbPath, dir);

		const state = {
			issueNumber: 8,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Archive me",
			body: "Body",
			status: "complete" as const,
			sessionPath: store.getSessionPath("mbrooks", "yolomatic", 8),
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		await store.set(state);
		await mkdir(path.dirname(state.sessionPath), { recursive: true });
		await writeFile(state.sessionPath, "log line\n");
		expect(await store.exists("mbrooks", "yolomatic", 8)).toBe(true);

		const archiveDir = path.join(dir, "archive");
		await store.archive(state, archiveDir);

		expect(await store.exists("mbrooks", "yolomatic", 8)).toBe(false);
		expect(await store.get("mbrooks", "yolomatic", 8)).toBeNull();
		await expect(access(store.getArchivePath(archiveDir, "mbrooks", "yolomatic", 8))).resolves.toBeUndefined();
		await expect(access(store.getSessionArchivePath(archiveDir, "mbrooks", "yolomatic", 8))).resolves.toBeUndefined();

		// Archived state file should contain the archived state JSON.
		const archived = JSON.parse(
			await readFile(store.getArchivePath(archiveDir, "mbrooks", "yolomatic", 8), "utf8"),
		) as { title: string };
		expect(archived.title).toBe("Archive me");
	});

	it("archive leaves legacy state file in place and writes fresh state to archive", async () => {
		const store = new SessionStore(dbPath, dir);

		const state = {
			issueNumber: 11,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Legacy",
			body: "Body",
			status: "complete" as const,
			sessionPath: store.getSessionPath("mbrooks", "yolomatic", 11),
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		// Write a legacy state file directly (no SQLite row yet) plus a transcript.
		await mkdir(path.dirname(store.getStatePath("mbrooks", "yolomatic", 11)), { recursive: true });
		await writeFile(store.getStatePath("mbrooks", "yolomatic", 11), JSON.stringify({ stale: "legacy" }, null, 2));
		await writeFile(state.sessionPath, "log line\n");

		const archiveDir = path.join(dir, "archive");
		await store.archive(state, archiveDir);

		// Transcript archiving remains intact: the transcript is moved to the archive.
		await expect(access(state.sessionPath)).rejects.toThrow();
		await expect(access(store.getSessionArchivePath(archiveDir, "mbrooks", "yolomatic", 11))).resolves.toBeUndefined();
		// Legacy state JSON is NOT auto-deleted/moved; it remains in place for a
		// separate explicit operational cleanup step.
		await expect(access(store.getStatePath("mbrooks", "yolomatic", 11))).resolves.toBeUndefined();
		// The archived state file is written fresh from the SQLite state.
		const archived = JSON.parse(
			await readFile(store.getArchivePath(archiveDir, "mbrooks", "yolomatic", 11), "utf8"),
		) as { title: string };
		expect(archived.title).toBe("Legacy");
	});

	it("archive is idempotent when files are missing", async () => {
		const store = new SessionStore(dbPath, dir);

		const state = {
			issueNumber: 10,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Missing files",
			body: "Body",
			status: "complete" as const,
			sessionPath: store.getSessionPath("mbrooks", "yolomatic", 10),
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		await store.set(state);
		await store.delete("mbrooks", "yolomatic", 10);

		await expect(store.archive(state, path.join(dir, "archive"))).resolves.toBeUndefined();
	});

	it("delete is idempotent for missing sessions", async () => {
		const store = new SessionStore(dbPath, dir);
		await expect(store.delete("mbrooks", "yolomatic", 999)).resolves.toBeUndefined();
	});

	describe("migrateFromFileStoreIfNeeded", () => {
		it("imports existing file-backed sessions into SQLite", async () => {
			const store = new SessionStore(dbPath, dir);

			const state = {
				issueNumber: 1,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Legacy",
				body: "Body",
				status: "working" as const,
				sessionPath: store.getSessionPath("mbrooks", "yolomatic", 1),
				workspacePath: "/tmp/workspace",
				lastActivity: new Date().toISOString(),
				seeded: false,
			};
			// Pre-existing file-backed session written directly to disk.
			await mkdir(path.dirname(store.getStatePath("mbrooks", "yolomatic", 1)), { recursive: true });
			await writeFile(store.getStatePath("mbrooks", "yolomatic", 1), JSON.stringify(state, null, 2));

			const imported = await store.migrateFromFileStoreIfNeeded();
			expect(imported).toBe(1);

			// Readable via a fresh store instance (proves SQLite, not the file).
			const store2 = new SessionStore(dbPath, dir);
			const result = await store2.get("mbrooks", "yolomatic", 1);
			expect(result?.title).toBe("Legacy");
			expect(result?.status).toBe("working");
			expect(result?.kind).toBe("implementation");

			// Original file is preserved (rollback path).
			await expect(access(store.getStatePath("mbrooks", "yolomatic", 1))).resolves.toBeUndefined();
		});

		it("is idempotent and skips already-imported sessions", async () => {
			const store = new SessionStore(dbPath, dir);

			const state = {
				issueNumber: 2,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Legacy",
				body: "Body",
				status: "pending" as const,
				sessionPath: store.getSessionPath("mbrooks", "yolomatic", 2),
				workspacePath: "/tmp/workspace",
				lastActivity: new Date().toISOString(),
				seeded: false,
			};
			await mkdir(path.dirname(store.getStatePath("mbrooks", "yolomatic", 2)), { recursive: true });
			await writeFile(store.getStatePath("mbrooks", "yolomatic", 2), JSON.stringify(state, null, 2));

			expect(await store.migrateFromFileStoreIfNeeded()).toBe(1);
			// Second invocation is a no-op even though the file still exists.
			expect(await store.migrateFromFileStoreIfNeeded()).toBe(0);
			expect(await store.getAll()).toHaveLength(1);
		});

		it("preserves archivedAt on imported sessions so they stay excluded", async () => {
			const store = new SessionStore(dbPath, dir);

			const state = {
				issueNumber: 3,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Already archived",
				body: "Body",
				status: "complete" as const,
				sessionPath: store.getSessionPath("mbrooks", "yolomatic", 3),
				workspacePath: "/tmp/workspace",
				lastActivity: new Date().toISOString(),
				seeded: false,
				archivedAt: "2026-01-01T00:00:00.000Z",
			};
			await mkdir(path.dirname(store.getStatePath("mbrooks", "yolomatic", 3)), { recursive: true });
			await writeFile(store.getStatePath("mbrooks", "yolomatic", 3), JSON.stringify(state, null, 2));

			await store.migrateFromFileStoreIfNeeded();

			expect(await store.getAll()).toHaveLength(0);
			expect(await store.get("mbrooks", "yolomatic", 3)).toBeNull();
		});

		it("skips invalid state files with a warning", async () => {
			const store = new SessionStore(dbPath, dir);
			const repoDir = path.join(dir, "github-mbrooks-yolomatic");
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
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Filtered",
				body: "Body",
				status: "pending" as const,
				sessionPath: store.getSessionPath("mbrooks", "yolomatic", 9),
				workspacePath: "/tmp/workspace",
				lastActivity: new Date().toISOString(),
				seeded: false,
			};
			await mkdir(path.dirname(store.getStatePath("mbrooks", "yolomatic", 9)), { recursive: true });
			await writeFile(store.getStatePath("mbrooks", "yolomatic", 9), JSON.stringify(state, null, 2));
			await writeFile(path.join(dir, "not-a-dir.txt"), "ignore me");
			await writeFile(path.join(dir, "github-mbrooks-yolomatic", "issue-9.log"), "ignore me");

			await store.migrateFromFileStoreIfNeeded();
			const all = await store.getAll();
			expect(all.length).toBe(1);
			expect(all[0].issueNumber).toBe(9);
		});
	});

	describe("auditLegacyState (read-only preflight)", () => {
		it("returns an empty report when there are no legacy files and all sessions have kind", async () => {
			const store = new SessionStore(dbPath, dir);
			await store.set({
				issueNumber: 1,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Clean",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/session.jsonl",
				workspacePath: "/tmp/workspace",
				lastActivity: new Date().toISOString(),
				seeded: false,
			});

			const report = await store.auditLegacyState();

			expect(report.legacyStateFiles).toEqual([]);
			expect(report.sessionsMissingKind).toEqual([]);
			expect(report.malformedStateFiles).toEqual([]);
			expect(report.clean).toBe(true);
		});

		it("detects legacy state files without modifying them", async () => {
			const store = new SessionStore(dbPath, dir);
			const repoDir = path.join(dir, "github-mbrooks-yolomatic");
			await mkdir(repoDir, { recursive: true });
			const legacyPath = path.join(repoDir, "issue-42.state.json");
			const legacyContent = JSON.stringify({ owner: "mbrooks", repo: "yolomatic", issueNumber: 42 }, null, 2);
			await writeFile(legacyPath, legacyContent);

			const report = await store.auditLegacyState();

			expect(report.legacyStateFiles).toContain(legacyPath);
			expect(report.clean).toBe(false);
			// Read-only: the legacy file is left byte-for-byte intact.
			expect(await readFile(legacyPath, "utf8")).toBe(legacyContent);
		});

		it("detects sessions missing kind in the SQLite store", async () => {
			const store = new SessionStore(dbPath, dir);
			// Insert a row directly into SQLite that omits `kind`, bypassing the
			// store's `set()` normalization.
			const key = store.getSessionKey("mbrooks", "yolomatic", 55);
			store["upsertStmt"].run(
				key,
				"mbrooks",
				"yolomatic",
				55,
				"working",
				null,
				JSON.stringify({
					owner: "mbrooks",
					repo: "yolomatic",
					issueNumber: 55,
					title: "No kind",
					status: "working",
					sessionPath: "/tmp/s.jsonl",
					workspacePath: "/tmp/ws",
					lastActivity: new Date().toISOString(),
					seeded: false,
				}),
				new Date().toISOString(),
			);

			const report = await store.auditLegacyState();

			expect(report.sessionsMissingKind).toEqual([key]);
			expect(report.clean).toBe(false);
		});

		it("reports malformed legacy files without throwing", async () => {
			const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const store = new SessionStore(dbPath, dir);
			const repoDir = path.join(dir, "github-mbrooks-yolomatic");
			await mkdir(repoDir, { recursive: true });
			const malformedPath = path.join(repoDir, "issue-1.state.json");
			await writeFile(malformedPath, "not json");

			const report = await store.auditLegacyState();

			expect(report.malformedStateFiles).toContain(malformedPath);
			expect(report.legacyStateFiles).not.toContain(malformedPath);
			expect(report.clean).toBe(false);
			// Malformed artifacts cannot corrupt valid SQLite rows: the report is
			// returned and no rows were inserted.
			expect(await store.getAll()).toEqual([]);
			writeSpy.mockRestore();
		});
	});

	describe("removeLegacyStateFiles (explicit operational cleanup)", () => {
		it("removes on-disk state and transcript files for a session", async () => {
			const store = new SessionStore(dbPath, dir);
			const statePath = store.getStatePath("mbrooks", "yolomatic", 77);
			const sessionPath = store.getSessionPath("mbrooks", "yolomatic", 77);
			await mkdir(path.dirname(statePath), { recursive: true });
			await writeFile(statePath, "{}\n");
			await writeFile(sessionPath, "log\n");

			await store.removeLegacyStateFiles("mbrooks", "yolomatic", 77);

			await expect(access(statePath)).rejects.toThrow();
			await expect(access(sessionPath)).rejects.toThrow();
		});

		it("is idempotent when files are missing", async () => {
			const store = new SessionStore(dbPath, dir);
			await expect(store.removeLegacyStateFiles("mbrooks", "yolomatic", 999)).resolves.toBeUndefined();
		});
	});

	describe("retired boot-time file-state import", () => {
		it("does not import legacy state files on construction (repeated startup does not re-import)", async () => {
			const repoDir = path.join(dir, "github-mbrooks-yolomatic");
			await mkdir(repoDir, { recursive: true });
			await writeFile(
				path.join(repoDir, "issue-88.state.json"),
				JSON.stringify({ owner: "mbrooks", repo: "yolomatic", issueNumber: 88 }, null, 2),
			);

			// Constructing a store never imports the legacy file; the import is now
			// an explicit operational tool (`migrateFromFileStoreIfNeeded`).
			const store = new SessionStore(dbPath, dir);
			expect(await store.getAll()).toEqual([]);
			// The legacy file is left in place.
			await expect(access(path.join(repoDir, "issue-88.state.json"))).resolves.toBeUndefined();

			// The explicit importer is still available as a recovery/rollback tool.
			expect(await store.migrateFromFileStoreIfNeeded()).toBe(1);
			expect((await store.getAll()).length).toBe(1);
		});
	});
});
