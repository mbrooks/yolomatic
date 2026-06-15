import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SessionManager } from "./manager.js";
import { SessionStore } from "./store.js";

describe("SessionManager", () => {
	it("creates 1:1 issue session paths with owner and repo", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		const session = await manager.createSession(
			"mbrooks",
			"casebot",
			17,
			"Fix issue routing",
			"Make sure workspaces are isolated.",
			"/tmp/workspaces/mbrooks-casebot",
		);

		expect(session.sessionPath).toBe(path.join(sessionsDir, "github-mbrooks-casebot", "issue-17.jsonl"));
		expect(session.status).toBe("pending");

		const persisted = JSON.parse(
			await readFile(path.join(sessionsDir, "github-mbrooks-casebot", "issue-17.state.json"), "utf8"),
		) as { sessionPath: string; workspacePath: string };
		expect(persisted.sessionPath).toBe(path.join(sessionsDir, "github-mbrooks-casebot", "issue-17.jsonl"));
		expect(persisted.workspacePath).toBe("/tmp/workspaces/mbrooks-casebot");
	});

	it("stores labels when provided", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		const session = await manager.createSession(
			"mbrooks",
			"tars",
			99,
			"Title",
			"Body",
			"/tmp/ws",
			["bug", "enhancement"],
		);

		expect(session.labels).toEqual(["bug", "enhancement"]);
		const persisted = JSON.parse(
			await readFile(path.join(sessionsDir, "github-mbrooks-tars", "issue-99.state.json"), "utf8"),
		) as { labels?: string[] };
		expect(persisted.labels).toEqual(["bug", "enhancement"]);
	});

	it("enforces 1:1 mapping by returning existing session on duplicate create", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		const first = await manager.createSession(
			"mbrooks",
			"casebot",
			42,
			"First title",
			"First body.",
			"/tmp/workspaces/mbrooks-casebot",
		);

		const second = await manager.createSession(
			"mbrooks",
			"casebot",
			42,
			"Second title",
			"Second body.",
			"/tmp/workspaces/other",
		);

		expect(second.sessionPath).toBe(first.sessionPath);
		expect(second.title).toBe("First title");
		expect(second.body).toBe("First body.");
		expect(second.workspacePath).toBe("/tmp/workspaces/mbrooks-casebot");
	});

	it("isolates sessions across owners for the same repo name", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		const first = await manager.createSession("mbrooks", "shared", 5, "One", "Body", "/tmp/workspaces/mbrooks-shared");
		const second = await manager.createSession("acme", "shared", 5, "Two", "Body", "/tmp/workspaces/acme-shared");

		expect(first.sessionPath).not.toBe(second.sessionPath);
		expect(await manager.getSession("mbrooks", "shared", 5)).toMatchObject({ owner: "mbrooks", title: "One" });
		expect(await manager.getSession("acme", "shared", 5)).toMatchObject({ owner: "acme", title: "Two" });
	});

	it("resumes an existing session and updates status to working", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession(
			"mbrooks",
			"tars",
			8,
			"Add tests",
			"Increase coverage.",
			"/tmp/workspaces/mbrooks-tars",
		);

		const resumed = await manager.resumeSession("mbrooks", "tars", 8, "Some feedback");
		expect(resumed.status).toBe("working");
		expect(resumed.issueNumber).toBe(8);
		expect(resumed.repo).toBe("tars");
	});

	it("throws when resuming a non-existent session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await expect(manager.resumeSession("mbrooks", "tars", 999)).rejects.toThrow(
			"No session for mbrooks/tars#999",
		);
	});

	it("gets an existing session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 5, "Title", "Body", "/tmp/ws");
		const session = await manager.getSession("mbrooks", "tars", 5);
		expect(session).not.toBeNull();
		expect(session?.title).toBe("Title");
	});

	it("returns null for missing session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		const session = await manager.getSession("mbrooks", "tars", 999);
		expect(session).toBeNull();
	});

	it("updates status and partial fields of an existing session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 6, "Title", "Body", "/tmp/ws");
		const updated = await manager.updateStatus("mbrooks", "tars", 6, "complete", { summary: "Done." });
		expect(updated.status).toBe("complete");
		expect(updated.summary).toBe("Done.");
	});

	it("throws when updating status of a non-existent session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await expect(manager.updateStatus("mbrooks", "tars", 999, "working")).rejects.toThrow(
			"No session for mbrooks/tars#999",
		);
	});

	it("persists execution time fields through updateStatus", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 24, "Title", "Body", "/tmp/ws");
		const started = await manager.updateStatus("mbrooks", "tars", 24, "working", {
			taskStartedAt: "2026-01-01T00:00:00Z",
			taskFinishedAt: undefined,
		});
		expect(started.taskStartedAt).toBe("2026-01-01T00:00:00Z");
		expect(started.taskFinishedAt).toBeUndefined();

		const finished = await manager.updateStatus("mbrooks", "tars", 24, "working", {
			taskFinishedAt: "2026-01-01T00:01:00Z",
			totalExecutionTimeMs: 60000,
		});
		expect(finished.taskFinishedAt).toBe("2026-01-01T00:01:00Z");
		expect(finished.totalExecutionTimeMs).toBe(60000);

		const persisted = JSON.parse(
			await readFile(path.join(sessionsDir, "github-mbrooks-tars", "issue-24.state.json"), "utf8"),
		) as { taskStartedAt?: string; taskFinishedAt?: string; totalExecutionTimeMs?: number };
		expect(persisted.taskStartedAt).toBe("2026-01-01T00:00:00Z");
		expect(persisted.taskFinishedAt).toBe("2026-01-01T00:01:00Z");
		expect(persisted.totalExecutionTimeMs).toBe(60000);
	});

	it("marks session as seeded", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 7, "Title", "Body", "/tmp/ws");
		const updated = await manager.markSeeded("mbrooks", "tars", 7);
		expect(updated.seeded).toBe(true);
	});

	it("throws when marking a non-existent session as seeded", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await expect(manager.markSeeded("mbrooks", "tars", 999)).rejects.toThrow(
			"No session for mbrooks/tars#999",
		);
	});

	it("associates a PR with an existing session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 10, "Title", "Body", "/tmp/ws");
		const updated = await manager.associatePR("mbrooks", "tars", 10, 99, "https://github.com/mbrooks/tars/pull/99");
		expect(updated.prNumber).toBe(99);
		expect(updated.prUrl).toBe("https://github.com/mbrooks/tars/pull/99");
	});

	it("throws when associating PR with a non-existent session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await expect(manager.associatePR("mbrooks", "tars", 999, 1, "url")).rejects.toThrow(
			"No session for mbrooks/tars#999",
		);
	});

	it("finds a session by associated PR number", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 10, "Title", "Body", "/tmp/ws");
		await manager.associatePR("mbrooks", "tars", 10, 99, "https://github.com/mbrooks/tars/pull/99");

		const found = await manager.findSessionByPR("mbrooks", "tars", 99);
		expect(found?.issueNumber).toBe(10);
		await expect(manager.findSessionByPR("mbrooks", "tars", 100)).resolves.toBeNull();
	});

	it("increments iteration count on an existing session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 11, "Title", "Body", "/tmp/ws");
		const first = await manager.incrementIterationCount("mbrooks", "tars", 11);
		expect(first.iterationCount).toBe(1);
		const second = await manager.incrementIterationCount("mbrooks", "tars", 11);
		expect(second.iterationCount).toBe(2);
	});

	it("throws when incrementing iteration count for a non-existent session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await expect(manager.incrementIterationCount("mbrooks", "tars", 999)).rejects.toThrow(
			"No session for mbrooks/tars#999",
		);
	});

	it("cancels an existing session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 12, "Title", "Body", "/tmp/ws");
		const updated = await manager.cancelSession("mbrooks", "tars", 12);
		expect(updated.status).toBe("cancelled");
	});

	it("restarts a failed session, resetting state and tracking audit", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		const created = await manager.createSession("mbrooks", "tars", 13, "Title", "Body", "/tmp/ws", ["bug"]);
		await manager.updateStatus("mbrooks", "tars", 13, "failed", {
			summary: "Boom",
			prNumber: 7,
			prUrl: "https://github.com/mbrooks/tars/pull/7",
			seeded: true,
			iterationCount: 2,
		});

		const restarted = await manager.restartSession("mbrooks", "tars", 13);
		expect(restarted.status).toBe("pending");
		expect(restarted.summary).toBeUndefined();
		expect(restarted.prNumber).toBeUndefined();
		expect(restarted.prUrl).toBeUndefined();
		expect(restarted.seeded).toBe(false);
		expect(restarted.iterationCount).toBeUndefined();
		expect(restarted.restartCount).toBe(1);
		expect(restarted.restartedFrom).toBe("failed");
		expect(restarted.title).toBe("Title");
		expect(restarted.body).toBe("Body");
		expect(restarted.labels).toEqual(["bug"]);
	});

	it("restarts a cancelled session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 14, "Title", "Body", "/tmp/ws");
		await manager.cancelSession("mbrooks", "tars", 14);
		const restarted = await manager.restartSession("mbrooks", "tars", 14);
		expect(restarted.status).toBe("pending");
		expect(restarted.restartedFrom).toBe("cancelled");
		expect(restarted.restartCount).toBe(1);
	});

	it("increments restart count on multiple restarts", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 15, "Title", "Body", "/tmp/ws");
		await manager.updateStatus("mbrooks", "tars", 15, "failed");
		const first = await manager.restartSession("mbrooks", "tars", 15);
		expect(first.restartCount).toBe(1);

		await manager.updateStatus("mbrooks", "tars", 15, "failed");
		const second = await manager.restartSession("mbrooks", "tars", 15);
		expect(second.restartCount).toBe(2);
		expect(second.restartedFrom).toBe("failed");
	});

	it("throws when restarting a non-existent session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await expect(manager.restartSession("mbrooks", "tars", 999)).rejects.toThrow(
			"No session for mbrooks/tars#999",
		);
	});

	it("throws when restarting a completed session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 16, "Title", "Body", "/tmp/ws");
		await manager.updateStatus("mbrooks", "tars", 16, "complete");
		await expect(manager.restartSession("mbrooks", "tars", 16)).rejects.toThrow(
			"Cannot restart a completed session.",
		);
	});

	it("throws when restarting a working session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 17, "Title", "Body", "/tmp/ws");
		await manager.updateStatus("mbrooks", "tars", 17, "working");
		await expect(manager.restartSession("mbrooks", "tars", 17)).rejects.toThrow(
			"Cannot restart session in 'working' status. Only failed or cancelled sessions can be restarted.",
		);
	});

	it("pauses a working session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 18, "Title", "Body", "/tmp/ws");
		await manager.updateStatus("mbrooks", "tars", 18, "working");
		const paused = await manager.pauseSession("mbrooks", "tars", 18);
		expect(paused.status).toBe("paused");
	});

	it("pauses a pending session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 19, "Title", "Body", "/tmp/ws");
		const paused = await manager.pauseSession("mbrooks", "tars", 19);
		expect(paused.status).toBe("paused");
	});

	it("throws when pausing an already paused session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 20, "Title", "Body", "/tmp/ws");
		await manager.pauseSession("mbrooks", "tars", 20);
		await expect(manager.pauseSession("mbrooks", "tars", 20)).rejects.toThrow(
			"Session is already paused.",
		);
	});

	it("throws when pausing a terminal session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 21, "Title", "Body", "/tmp/ws");
		await manager.updateStatus("mbrooks", "tars", 21, "complete");
		await expect(manager.pauseSession("mbrooks", "tars", 21)).rejects.toThrow(
			"Cannot pause a session in 'complete' status.",
		);
	});

	it("unpauses a paused session and restores to pending", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 22, "Title", "Body", "/tmp/ws");
		await manager.pauseSession("mbrooks", "tars", 22);
		const resumed = await manager.unpauseSession("mbrooks", "tars", 22);
		expect(resumed.status).toBe("pending");
	});

	it("throws when unpausing a non-paused session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 23, "Title", "Body", "/tmp/ws");
		await expect(manager.unpauseSession("mbrooks", "tars", 23)).rejects.toThrow(
			"Cannot resume a session in 'pending' status. Only paused sessions can be resumed.",
		);
	});

	it("exposes getSessionKey and getSessionPath helpers", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		expect(manager.getSessionKey("mbrooks", "tars", 30)).toContain("mbrooks");
		expect(manager.getSessionPath("mbrooks", "tars", 30)).toContain("issue-30");
	});

	it("implements SessionRepository.get as an alias for getSession", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 31, "Title", "Body", "/tmp/ws");
		const session = await manager.get("mbrooks", "tars", 31);
		expect(session?.title).toBe("Title");
		await expect(manager.get("mbrooks", "tars", 999)).resolves.toBeNull();
	});

	it("saves, lists, and deletes sessions", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		const created = await manager.createSession("mbrooks", "tars", 32, "Title", "Body", "/tmp/ws");
		created.status = "working";
		const saved = await manager.save(created);
		expect(saved.status).toBe("working");

		const all = await manager.getAll();
		expect(all.length).toBeGreaterThan(0);

		await manager.delete("mbrooks", "tars", 32);
		await expect(manager.getSession("mbrooks", "tars", 32)).resolves.toBeNull();
	});

	it("archives a session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const archiveDir = path.join(sessionsDir, "archive");
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		const created = await manager.createSession("mbrooks", "tars", 33, "Title", "Body", "/tmp/ws");
		await manager.archive(created, archiveDir);
		await expect(manager.getSession("mbrooks", "tars", 33)).resolves.toBeNull();
	});

	it("archives a session by owner/repo/issue number", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const archiveDir = path.join(sessionsDir, "archive");
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 38, "Title", "Body", "/tmp/ws");
		await manager.archiveSession("mbrooks", "tars", 38, archiveDir);
		await expect(manager.getSession("mbrooks", "tars", 38)).resolves.toBeNull();
	});

	it("marks a session complete", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 34, "Title", "Body", "/tmp/ws");
		const updated = await manager.markComplete("mbrooks", "tars", 34);
		expect(updated.status).toBe("complete");
	});

	it("marks a session failed with a reason", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 35, "Title", "Body", "/tmp/ws");
		const existing = await manager.updateStatus("mbrooks", "tars", 35, "working", {
			staleReason: "old",
		});
		const updated = await manager.markFailed("mbrooks", "tars", 35, "boom");
		expect(updated.status).toBe("failed");
		expect(updated.staleReason).toBe("boom");
		expect(updated.summary).toBe("boom");
	});

	it("preserves existing staleReason when markFailed has no reason", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 36, "Title", "Body", "/tmp/ws");
		await manager.updateStatus("mbrooks", "tars", 36, "working", { staleReason: "existing" });
		const updated = await manager.markFailed("mbrooks", "tars", 36);
		expect(updated.staleReason).toBe("existing");
	});

	it("marks a session stale", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 37, "Title", "Body", "/tmp/ws");
		const updated = await manager.markStale("mbrooks", "tars", 37, "no activity");
		expect(updated.staleReason).toBe("no activity");
		expect(updated.staleDetectedAt).toBeDefined();
	});

	it("throws for archive, complete, failed, stale and cancel on missing sessions", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await expect(manager.markComplete("mbrooks", "tars", 999)).rejects.toThrow("No session");
		await expect(manager.markFailed("mbrooks", "tars", 999)).rejects.toThrow("No session");
		await expect(manager.markStale("mbrooks", "tars", 999, "reason")).rejects.toThrow("No session");
		await expect(manager.cancelSession("mbrooks", "tars", 999)).rejects.toThrow("No session");
	});
});
