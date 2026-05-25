import { describe, expect, it, vi } from "vitest";

import { issueSessionKey, markIssueWorking, queueResumeOnBoot, removeWorkflowLabels, stopSessionByAdmin } from "./workflow-helpers.js";
import type { SessionState } from "../../session/store.js";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
	return {
		owner: "mbrooks",
		repo: "tars",
		issueNumber: 56,
		title: "Title",
		body: "Body",
		status: "working",
		sessionPath: "/tmp/session.jsonl",
		workspacePath: "/tmp/ws/.worktrees/issue-56",
		lastActivity: new Date().toISOString(),
		seeded: true,
		sessionType: "github_issue",
		...overrides,
	};
}

describe("workflow helpers", () => {
	it("builds the canonical issue session key", () => {
		expect(issueSessionKey("mbrooks", "tars", 56)).toBe("mbrooks/tars#56");
	});

	it("removes the workflow labels in a stable order", async () => {
		const github = {
			removeLabel: vi.fn(),
		};

		await removeWorkflowLabels(github as never, "mbrooks", "tars", 56);

		expect(github.removeLabel.mock.calls).toEqual([
			["mbrooks", "tars", 56, "tars-working"],
			["mbrooks", "tars", 56, "tars-feedback-required"],
			["mbrooks", "tars", 56, "tars-pr-created"],
			["mbrooks", "tars", 56, "tars-complete"],
		]);
	});

	it("marks an issue working after clearing workflow labels", async () => {
		const github = {
			removeLabel: vi.fn(),
			addLabels: vi.fn(),
			postComment: vi.fn(),
		};

		await markIssueWorking(github as never, "mbrooks", "tars", 56, "Picked up by TARS. Working on it...");

		expect(github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 56, ["tars-working"]);
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "tars", 56, "Picked up by TARS. Working on it...");
	});

	it("stops an active session immediately when a cancellation signal is sent", async () => {
		const sessions = {
			get: vi.fn(),
			cancelSession: vi.fn(),
		};
		const github = {
			postComment: vi.fn(),
			removeLabel: vi.fn(),
			addLabels: vi.fn(),
		};
		const tasks = {
			cancel: vi.fn(() => true),
		};

		const result = await stopSessionByAdmin(sessions as never, github as never, tasks as never, "mbrooks", "tars", 56);

		expect(result).toBe("stopping");
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "tars", 56, "Stopping TARS...");
		expect(sessions.get).not.toHaveBeenCalled();
	});

	it("cancels a working stored session when no active task exists", async () => {
		const sessions = {
			get: vi.fn(async () => makeSession()),
			cancelSession: vi.fn(),
		};
		const github = {
			postComment: vi.fn(),
			removeLabel: vi.fn(),
			addLabels: vi.fn(),
		};
		const tasks = {
			cancel: vi.fn(() => false),
		};

		const result = await stopSessionByAdmin(
			sessions as never,
			github as never,
			tasks as never,
			"mbrooks",
			"tars",
			56,
			99,
		);

		expect(result).toBe("cancelled");
		expect(sessions.cancelSession).toHaveBeenCalledWith("mbrooks", "tars", 56);
		expect(github.removeLabel).toHaveBeenCalledWith("mbrooks", "tars", 56, "tars-working");
		expect(github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 56, ["tars-cancelled"]);
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "tars", 99, "Task cancelled by admin. TARS is idle.");
	});

	it("queues feedback for resume on boot", async () => {
		const sessions = {
			updateStatus: vi.fn(),
		};

		await queueResumeOnBoot(sessions as never, makeSession({ queuedComments: ["existing"] }), ["new one", "new two"]);

		expect(sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			56,
			"working",
			expect.objectContaining({
				resumeOnBoot: true,
				queuedComments: ["existing", "new one", "new two"],
			}),
		);
	});
});
