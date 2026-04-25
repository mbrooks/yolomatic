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

	it("throws when incrementing iteration count for a non-existent session", async () => {
		const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "tars-sessions-"));
		const store = new SessionStore(sessionsDir);
		const manager = new SessionManager(sessionsDir, store);

		await expect(manager.incrementIterationCount("mbrooks", "tars", 999)).rejects.toThrow(
			"No session for mbrooks/tars#999",
		);
	});
});
