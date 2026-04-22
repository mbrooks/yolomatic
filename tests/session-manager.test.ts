import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";

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
});
