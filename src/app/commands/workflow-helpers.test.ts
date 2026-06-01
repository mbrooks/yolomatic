import { describe, expect, it, vi } from "vitest";

import {
	issueSessionKey,
	markIssueWorking,
	queueResumeOnBoot,
	removeWorkflowLabels,
	stopSessionByAdmin,
	ensureSessionExists,
	handleDrainingMode,
	startIssueExecution,
	handleAdminStop,
} from "./workflow-helpers.js";
import type { SessionState } from "../../session/store.js";
import { EmptyRepositoryError } from "../../workspace/errors.js";

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

	describe("ensureSessionExists", () => {
		it("returns an existing session when one is found", async () => {
			const existing = makeSession();
			const sessions = {
				get: vi.fn(async () => existing),
				createSession: vi.fn(),
			};
			const workspaces = {
				createOrGetWorktree: vi.fn(),
			};
			const github = {};

			const result = await ensureSessionExists(
				sessions as never,
				workspaces as never,
				github as never,
				"mbrooks",
				"tars",
				56,
				"Title",
				"Body",
				[],
				"main",
			);

			expect(result).toBe(existing);
			expect(sessions.createSession).not.toHaveBeenCalled();
			expect(workspaces.createOrGetWorktree).not.toHaveBeenCalled();
		});

		it("creates a worktree and session when none exists", async () => {
			const sessions = {
				get: vi.fn(async () => null),
				createSession: vi.fn(async () => makeSession({ status: "pending" })),
			};
			const workspaces = {
				createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/ws", branch: "tars/issue-56" })),
			};
			const github = {
				initializeEmptyRepo: vi.fn(),
			};

			await ensureSessionExists(
				sessions as never,
				workspaces as never,
				github as never,
				"mbrooks",
				"tars",
				56,
				"Title",
				"Body",
				["tars"],
				"main",
			);

			expect(workspaces.createOrGetWorktree).toHaveBeenCalledWith("mbrooks", "tars", 56);
			expect(sessions.createSession).toHaveBeenCalledWith(
				"mbrooks",
				"tars",
				56,
				"Title",
				"Body",
				"/tmp/ws",
				["tars"],
			);
			expect(github.initializeEmptyRepo).not.toHaveBeenCalled();
		});

		it("initializes an empty repo and retries worktree creation", async () => {
			let callCount = 0;
			const sessions = {
				get: vi.fn(async () => null),
				createSession: vi.fn(async () => makeSession({ status: "pending" })),
			};
			const workspaces = {
				createOrGetWorktree: vi.fn(async () => {
					callCount++;
					if (callCount === 1) {
						throw new EmptyRepositoryError("/tmp/ws/mbrooks-tars");
					}
					return { path: "/tmp/ws", branch: "tars/issue-56" };
				}),
			};
			const github = {
				initializeEmptyRepo: vi.fn(async () => {}),
			};

			await ensureSessionExists(
				sessions as never,
				workspaces as never,
				github as never,
				"mbrooks",
				"tars",
				56,
				"Title",
				"Body",
				[],
				"main",
			);

			expect(github.initializeEmptyRepo).toHaveBeenCalledWith("mbrooks", "tars", "main");
			expect(workspaces.createOrGetWorktree).toHaveBeenCalledTimes(2);
			expect(sessions.createSession).toHaveBeenCalled();
		});

		it("rethrows non-empty-repo errors from worktree creation", async () => {
			const sessions = {
				get: vi.fn(async () => null),
				createSession: vi.fn(),
			};
			const workspaces = {
				createOrGetWorktree: vi.fn(async () => {
					throw new Error("some other error");
				}),
			};
			const github = {
				initializeEmptyRepo: vi.fn(),
			};

			await expect(
				ensureSessionExists(
					sessions as never,
					workspaces as never,
					github as never,
					"mbrooks",
					"tars",
					56,
					"Title",
					"Body",
					[],
					"main",
				),
			).rejects.toThrow("some other error");
			expect(github.initializeEmptyRepo).not.toHaveBeenCalled();
		});
	});

	describe("handleDrainingMode", () => {
		it("returns false when not in draining mode", async () => {
			const tasks = {
				isDraining: vi.fn(() => false),
			};
			const sessions = {
				updateStatus: vi.fn(),
			};
			const github = {
				postComment: vi.fn(),
			};

			const result = await handleDrainingMode(tasks as never, sessions as never, github as never, makeSession());

			expect(result).toBe(false);
			expect(sessions.updateStatus).not.toHaveBeenCalled();
			expect(github.postComment).not.toHaveBeenCalled();
		});

		it("updates session to pending and posts message when no comments are provided", async () => {
			const tasks = {
				isDraining: vi.fn(() => true),
			};
			const sessions = {
				updateStatus: vi.fn(),
			};
			const github = {
				postComment: vi.fn(),
			};

			const result = await handleDrainingMode(tasks as never, sessions as never, github as never, makeSession({ status: "working" }));

			expect(result).toBe(true);
			expect(sessions.updateStatus).toHaveBeenCalledWith(
				"mbrooks",
				"tars",
				56,
				"pending",
				{ resumeOnBoot: true },
			);
			expect(github.postComment).toHaveBeenCalledWith(
				"mbrooks",
				"tars",
				56,
				"Deploy in progress. Task will resume after restart.",
			);
		});

		it("queues comments and posts message when comment bodies are provided", async () => {
			const tasks = {
				isDraining: vi.fn(() => true),
			};
			const sessions = {
				updateStatus: vi.fn(),
			};
			const github = {
				postComment: vi.fn(),
			};

			const result = await handleDrainingMode(
				tasks as never,
				sessions as never,
				github as never,
				makeSession({ queuedComments: ["existing"] }),
				["new comment"],
			);

			expect(result).toBe(true);
			expect(sessions.updateStatus).toHaveBeenCalledWith(
				"mbrooks",
				"tars",
				56,
				"working",
				expect.objectContaining({
					resumeOnBoot: true,
					queuedComments: ["existing", "new comment"],
				}),
			);
			expect(github.postComment).toHaveBeenCalledWith(
				"mbrooks",
				"tars",
				56,
				"Deploy in progress. Feedback will be processed after restart.",
			);
		});
	});

	describe("startIssueExecution", () => {
		it("marks issue working and runs the executor", async () => {
			const executor = {
				run: vi.fn(async () => {}),
			};
			const github = {
				removeLabel: vi.fn(),
				addLabels: vi.fn(),
				postComment: vi.fn(),
			};
			const session = makeSession({ status: "pending" });

			await startIssueExecution(
				executor as never,
				github as never,
				"mbrooks",
				"tars",
				56,
				session,
				"Picked up by TARS. Working on it...",
			);

			expect(github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 56, ["tars-working"]);
			expect(github.postComment).toHaveBeenCalledWith("mbrooks", "tars", 56, "Picked up by TARS. Working on it...");
			expect(executor.run).toHaveBeenCalledWith(session, undefined);
		});

		it("passes an optional comment body to the executor", async () => {
			const executor = {
				run: vi.fn(async () => {}),
			};
			const github = {
				removeLabel: vi.fn(),
				addLabels: vi.fn(),
				postComment: vi.fn(),
			};
			const session = makeSession({ status: "pending" });

			await startIssueExecution(
				executor as never,
				github as never,
				"mbrooks",
				"tars",
				56,
				session,
				"Feedback received. Resuming work.",
				"hello",
			);

			expect(executor.run).toHaveBeenCalledWith(session, "hello");
		});
	});

	describe("handleAdminStop", () => {
		it("posts an admin-only message when sender is not an admin", async () => {
			const github = {
				postComment: vi.fn(),
			};
			const tasks = {
				cancel: vi.fn(() => false),
			};
			const sessions = {
				get: vi.fn(),
			};

			const result = await handleAdminStop(
				github as never,
				tasks as never,
				sessions as never,
				"user",
				"admin",
				"mbrooks",
				"tars",
				56,
				56,
			);

			expect(result).toBe("not-admin");
			expect(github.postComment).toHaveBeenCalledWith("mbrooks", "tars", 56, "Only admins can stop TARS.");
			expect(tasks.cancel).not.toHaveBeenCalled();
		});

		it("passes through to stopSessionByAdmin when sender is an admin", async () => {
			const github = {
				postComment: vi.fn(),
				removeLabel: vi.fn(),
				addLabels: vi.fn(),
			};
			const tasks = {
				cancel: vi.fn(() => false),
			};
			const sessions = {
				get: vi.fn(async () => makeSession()),
				cancelSession: vi.fn(),
			};

			const result = await handleAdminStop(
				github as never,
				tasks as never,
				sessions as never,
				"admin",
				"admin",
				"mbrooks",
				"tars",
				56,
				99,
			);

			expect(result).toBe("cancelled");
			expect(sessions.cancelSession).toHaveBeenCalledWith("mbrooks", "tars", 56);
			expect(github.postComment).toHaveBeenCalledWith("mbrooks", "tars", 99, "Task cancelled by admin. TARS is idle.");
		});

		it("returns stopping when an active task is cancelled", async () => {
			const github = {
				postComment: vi.fn(),
			};
			const tasks = {
				cancel: vi.fn(() => true),
			};
			const sessions = {
				get: vi.fn(),
			};

			const result = await handleAdminStop(
				github as never,
				tasks as never,
				sessions as never,
				"admin",
				"admin",
				"mbrooks",
				"tars",
				56,
				56,
			);

			expect(result).toBe("stopping");
			expect(tasks.cancel).toHaveBeenCalledWith("mbrooks/tars#56");
			expect(github.postComment).toHaveBeenCalledWith("mbrooks", "tars", 56, "Stopping TARS...");
			expect(sessions.get).not.toHaveBeenCalled();
		});
	});
});
