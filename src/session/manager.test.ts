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

	it("marks a session as stale", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 20, "Title", "Body", "/tmp/ws");
		const updated = await manager.markStale("mbrooks", "tars", 20, "interrupted_or_abandoned");
		expect(updated.staleDetectedAt).toBeTruthy();
		expect(updated.staleReason).toBe("interrupted_or_abandoned");
		expect(updated.status).toBe("pending");
	});

	it("throws when marking a non-existent session as stale", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await expect(manager.markStale("mbrooks", "tars", 999, "reason")).rejects.toThrow(
			"No session for mbrooks/tars#999",
		);
	});

	it("marks a session as failed with reason", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 21, "Title", "Body", "/tmp/ws");
		const updated = await manager.markFailed("mbrooks", "tars", 21, "stale_session_cleanup");
		expect(updated.status).toBe("failed");
		expect(updated.staleDetectedAt).toBeTruthy();
		expect(updated.staleReason).toBe("stale_session_cleanup");
	});

	it("throws when marking a non-existent session as failed", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await expect(manager.markFailed("mbrooks", "tars", 999)).rejects.toThrow(
			"No session for mbrooks/tars#999",
		);
	});

	it("marks a session as complete", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 22, "Title", "Body", "/tmp/ws");
		const updated = await manager.markComplete("mbrooks", "tars", 22);
		expect(updated.status).toBe("complete");
	});

	it("throws when marking a non-existent session as complete", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await expect(manager.markComplete("mbrooks", "tars", 999)).rejects.toThrow(
			"No session for mbrooks/tars#999",
		);
	});

	it("archives a session to archive dir", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const archiveDir = await mkdtemp(path.join(os.tmpdir(), "tars-archive-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await manager.createSession("mbrooks", "tars", 23, "Title", "Body", "/tmp/ws");
		await manager.archiveSession("mbrooks", "tars", 23, archiveDir);

		expect(await manager.getSession("mbrooks", "tars", 23)).toBeNull();
	});

	it("throws when archiving a non-existent session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const archiveDir = await mkdtemp(path.join(os.tmpdir(), "tars-archive-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await expect(manager.archiveSession("mbrooks", "tars", 999, archiveDir)).rejects.toThrow(
			"No session for mbrooks/tars#999",
		);
	});
});
