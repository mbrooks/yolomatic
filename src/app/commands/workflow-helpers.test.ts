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
	resolveIssueContext,
	guardEvent,
	prepareIssueSession,
	routePRTimelineComment,
} from "./workflow-helpers.js";
import type { SessionState } from "../../session/store.js";
import { EmptyRepositoryError } from "../../workspace/errors.js";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
	return {
		owner: "mbrooks",
		repo: "yolomatic",
		issueNumber: 56,
		title: "Title",
		body: "Body",
		status: "working",
		sessionPath: "/tmp/session.jsonl",
		workspacePath: "/tmp/ws/.worktrees/issue-56",
		lastActivity: new Date().toISOString(),
		seeded: true,
		...overrides,
	};
}

describe("workflow helpers", () => {
	it("builds the canonical issue session key", () => {
		expect(issueSessionKey("mbrooks", "yolomatic", 56)).toBe("mbrooks/yolomatic#56");
	});

	it("removes the workflow labels in a stable order", async () => {
		const github = {
			removeLabel: vi.fn(),
		};

		await removeWorkflowLabels(github as never, "mbrooks", "yolomatic", 56);

		expect(github.removeLabel.mock.calls).toEqual([
			["mbrooks", "yolomatic", 56, "yolomatic-working"],
			["mbrooks", "yolomatic", 56, "yolomatic-feedback-required"],
			["mbrooks", "yolomatic", 56, "yolomatic-pr-created"],
			["mbrooks", "yolomatic", 56, "yolomatic-complete"],
		]);
	});

	it("marks an issue working after clearing workflow labels", async () => {
		const github = {
			removeLabel: vi.fn(),
			addLabels: vi.fn(),
			postComment: vi.fn(async () => 1),
		};

		await markIssueWorking(github as never, "mbrooks", "yolomatic", 56, "Picked up by Yolomatic. Working on it...");

		expect(github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, ["yolomatic-working"]);
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "Picked up by Yolomatic. Working on it...");
	});

	it("stops an active session immediately when a cancellation signal is sent", async () => {
		const sessions = {
			get: vi.fn(),
			cancelSession: vi.fn(),
		};
		const github = {
			postComment: vi.fn(async () => 1),
			removeLabel: vi.fn(),
			addLabels: vi.fn(),
		};
		const tasks = {
			cancel: vi.fn(() => true),
		};

		const result = await stopSessionByAdmin(sessions as never, github as never, tasks as never, "mbrooks", "yolomatic", 56);

		expect(result).toBe("stopping");
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "Stopping Yolomatic...");
		expect(sessions.get).not.toHaveBeenCalled();
	});

	it("cancels a working stored session when no active task exists", async () => {
		const sessions = {
			get: vi.fn(async () => makeSession()),
			cancelSession: vi.fn(),
		};
		const github = {
			postComment: vi.fn(async () => 1),
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
			"yolomatic",
			56,
			99,
		);

		expect(result).toBe("cancelled");
		expect(sessions.cancelSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 56);
		expect(github.removeLabel).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "yolomatic-working");
		expect(github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, ["yolomatic-cancelled"]);
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, "Task cancelled by admin. Yolomatic is idle.");
	});

	it("queues feedback for resume on boot", async () => {
		const sessions = {
			updateStatus: vi.fn(),
		};

		await queueResumeOnBoot(sessions as never, makeSession({ queuedComments: ["existing"] }), ["new one", "new two"]);

		expect(sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			56,
			"working",
			expect.objectContaining({
				resumeOnBoot: true,
				queuedComments: ["existing", "new one", "new two"],
			}),
			"implementation",
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
				"yolomatic",
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

		it("creates an implementation session without replacing a terminal refinement session", async () => {
			const existing = makeSession({
				kind: "refinement",
				status: "complete",
				summary: "Refined",
				workspacePath: "/tmp/refinement",
			});
			const sessions = {
				get: vi.fn(async (_owner, _repo, _issueNumber, kind) => kind === "refinement" ? existing : null),
				createSession: vi.fn(async () => makeSession({ kind: "implementation", status: "pending", workspacePath: "/tmp/implementation", branch: "yolomatic/issue-56" })),
				updateStatus: vi.fn(),
			};
			const workspaces = {
				createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/implementation", branch: "yolomatic/issue-56" })),
			};

			const result = await ensureSessionExists(
				sessions as never,
				workspaces as never,
				{} as never,
				"mbrooks",
				"yolomatic",
				56,
				"Title",
				"Body",
				["bug"],
				"main",
			);

			expect(result).toMatchObject({
				kind: "implementation",
				status: "pending",
				workspacePath: "/tmp/implementation",
				branch: "yolomatic/issue-56",
			});
			expect(sessions.createSession).toHaveBeenCalledWith(
				"mbrooks",
				"yolomatic",
				56,
				"Title",
				"Body",
				"/tmp/implementation",
				"implementation",
				["bug"],
			);
			expect(existing).toMatchObject({ kind: "refinement", status: "complete", summary: "Refined" });
			expect(sessions.updateStatus).not.toHaveBeenCalled();
		});

		it("creates a worktree and session when none exists", async () => {
			const sessions = {
				get: vi.fn(async () => null),
				createSession: vi.fn(async () => makeSession({ status: "pending" })),
			};
			const workspaces = {
				createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/ws", branch: "yolomatic/issue-56" })),
			};
			const github = {
				initializeEmptyRepo: vi.fn(),
			};

			await ensureSessionExists(
				sessions as never,
				workspaces as never,
				github as never,
				"mbrooks",
				"yolomatic",
				56,
				"Title",
				"Body",
				["yolomatic"],
				"main",
			);

			expect(workspaces.createOrGetWorktree).toHaveBeenCalledWith("mbrooks", "yolomatic", 56);
			expect(sessions.createSession).toHaveBeenCalledWith(
				"mbrooks",
				"yolomatic",
				56,
				"Title",
				"Body",
				"/tmp/ws",
				"implementation",
				["yolomatic"],
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
						throw new EmptyRepositoryError("/tmp/ws/mbrooks-yolomatic");
					}
					return { path: "/tmp/ws", branch: "yolomatic/issue-56" };
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
				"yolomatic",
				56,
				"Title",
				"Body",
				[],
				"main",
			);

			expect(github.initializeEmptyRepo).toHaveBeenCalledWith("mbrooks", "yolomatic", "main");
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
					"yolomatic",
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
				postComment: vi.fn(async () => 1),
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
				postComment: vi.fn(async () => 1),
			};

			const result = await handleDrainingMode(tasks as never, sessions as never, github as never, makeSession({ status: "working" }));

			expect(result).toBe(true);
			expect(sessions.updateStatus).toHaveBeenCalledWith(
				"mbrooks",
				"yolomatic",
				56,
				"pending",
				{ resumeOnBoot: true },
				"implementation",
			);
			expect(github.postComment).toHaveBeenCalledWith(
				"mbrooks",
				"yolomatic",
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
				postComment: vi.fn(async () => 1),
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
				"yolomatic",
				56,
				"working",
				expect.objectContaining({
					resumeOnBoot: true,
					queuedComments: ["existing", "new comment"],
				}),
				"implementation",
			);
			expect(github.postComment).toHaveBeenCalledWith(
				"mbrooks",
				"yolomatic",
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
				postComment: vi.fn(async () => 1),
			};
			const session = makeSession({ status: "pending" });

			await startIssueExecution(
				executor as never,
				github as never,
				"mbrooks",
				"yolomatic",
				56,
				session,
				"Picked up by Yolomatic. Working on it...",
			);

			expect(github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, ["yolomatic-working"]);
			expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "Picked up by Yolomatic. Working on it...");
			expect(executor.run).toHaveBeenCalledWith(session, undefined, undefined);
		});

		it("passes an optional comment body to the executor", async () => {
			const executor = {
				run: vi.fn(async () => {}),
			};
			const github = {
				removeLabel: vi.fn(),
				addLabels: vi.fn(),
				postComment: vi.fn(async () => 1),
			};
			const session = makeSession({ status: "pending" });

			await startIssueExecution(
				executor as never,
				github as never,
				"mbrooks",
				"yolomatic",
				56,
				session,
				"Feedback received. Resuming work.",
				"hello",
			);

			expect(executor.run).toHaveBeenCalledWith(session, "hello", undefined);
		});
	});

	describe("handleAdminStop", () => {
		it("posts an admin-only message when sender is not an admin", async () => {
			const github = {
				postComment: vi.fn(async () => 1),
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
				"yolomatic",
				56,
				56,
			);

			expect(result).toBe("not-admin");
			expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "Only admins can stop Yolomatic.");
			expect(tasks.cancel).not.toHaveBeenCalled();
		});

		it("passes through to stopSessionByAdmin when sender is an admin", async () => {
			const github = {
				postComment: vi.fn(async () => 1),
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
				"yolomatic",
				56,
				99,
			);

			expect(result).toBe("cancelled");
			expect(sessions.cancelSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 56);
			expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, "Task cancelled by admin. Yolomatic is idle.");
		});

		it("returns stopping when an active task is cancelled", async () => {
			const github = {
				postComment: vi.fn(async () => 1),
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
				"yolomatic",
				56,
				56,
			);

			expect(result).toBe("stopping");
			expect(tasks.cancel).toHaveBeenCalledWith("mbrooks/yolomatic#56");
			expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "Stopping Yolomatic...");
			expect(sessions.get).not.toHaveBeenCalled();
		});
	});

	describe("resolveIssueContext", () => {
		it("extracts owner/repo/issue/key and resolves the default branch via resolver", () => {
			const ctx = resolveIssueContext(
				{ repository: { name: "yolomatic", owner: { login: "mbrooks" } }, issue: { number: 42 } },
				() => "develop",
			);

			expect(ctx).toEqual({
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 42,
				key: "mbrooks/yolomatic#42",
				defaultBranch: "develop",
			});
		});

		it("falls back to the static default branch when no resolver is provided", () => {
			const ctx = resolveIssueContext(
				{ repository: { name: "yolomatic", owner: { login: "mbrooks" } }, issue: { number: 42 } },
				undefined,
				"release",
			);

			expect(ctx.defaultBranch).toBe("release");
			expect(ctx.key).toBe("mbrooks/yolomatic#42");
		});

		it("falls back to main when neither resolver nor default branch is provided", () => {
			const ctx = resolveIssueContext(
				{ repository: { name: "yolomatic", owner: { login: "mbrooks" } }, issue: { number: 42 } },
			);

			expect(ctx.defaultBranch).toBe("main");
		});
	});

	describe("guardEvent", () => {
		it("skips issue events the policy helper says to ignore", () => {
			const result = guardEvent(
				"issues",
				{
					action: "opened",
					issue: { assignee: null, assignees: [], labels: [{ name: "wontfix" }] },
					sender: { login: "human" },
				},
				"yolomatic-bot",
				false,
			);

			expect(result).toEqual({ skip: true, reason: "issue marked do-not-work" });
		});

		it("passes issue events that should not be ignored", () => {
			const result = guardEvent(
				"issues",
				{
					action: "opened",
					issue: { assignee: { login: "yolomatic-bot" }, assignees: [{ login: "yolomatic-bot" }], labels: [] },
					sender: { login: "human" },
				},
				"yolomatic-bot",
				false,
			);

			expect(result).toEqual({ skip: false });
		});

		it("skips comment events the policy helper says to ignore", () => {
			const result = guardEvent(
				"issue_comment",
				{
					action: "edited",
					comment: { body: "hi", user: { login: "human" } },
					issue: { labels: [], assignee: { login: "yolomatic-bot" }, assignees: [{ login: "yolomatic-bot" }] },
				},
				"yolomatic-bot",
			);

			expect(result).toEqual({ skip: true, reason: "action is edited" });
		});

		it("passes accepted comment events with mention/creator flags", () => {
			const result = guardEvent(
				"issue_comment",
				{
					action: "created",
					comment: { body: "@yolomatic-bot please help", user: { login: "human" } },
					issue: { labels: [], assignee: { login: "yolomatic-bot" }, assignees: [{ login: "yolomatic-bot" }] },
				},
				"yolomatic-bot",
			);

			expect(result).toEqual({ skip: false, isMentioned: true, isFeedbackCommand: false, isCreatedByYolomatic: false });
		});
	});

	describe("prepareIssueSession", () => {
		function makeDeps(overrides?: {
			sessions?: Record<string, ReturnType<typeof vi.fn>>;
			isDraining?: boolean;
		}) {
			const sessions = {
				get: vi.fn(async () => null),
				createSession: vi.fn(async () => makeSession({ status: "pending" })),
				updateStatus: vi.fn(),
				...overrides?.sessions,
			};
			const workspaces = {
				createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/ws", branch: "yolomatic/issue-56" })),
			};
			const github = {
				initializeEmptyRepo: vi.fn(),
				postComment: vi.fn(async () => 1),
				removeLabel: vi.fn(),
				addLabels: vi.fn(),
			};
			const tasks = {
				isDraining: vi.fn(() => overrides?.isDraining ?? false),
			};
			return { sessions, workspaces, github, tasks };
		}

		const ctx = {
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 56,
			title: "Title",
			body: "Body",
			labels: ["yolomatic"] as string[] | undefined,
			defaultBranch: "main",
		};

		it("ensures a session exists and returns it when not draining", async () => {
			const deps = makeDeps();
			const result = await prepareIssueSession(deps as never, ctx, { requirePending: true });

			expect(result).toEqual({ skip: false, session: expect.objectContaining({ status: "pending" }) });
			expect(deps.tasks.isDraining).toHaveBeenCalled();
		});

		it("skips with a status reason when requirePending is set and session is not pending", async () => {
			const deps = makeDeps({
				sessions: { get: vi.fn(async () => makeSession({ status: "working" })) },
			});
			const result = await prepareIssueSession(deps as never, ctx, { requirePending: true });

			expect(result).toEqual({ skip: true, kind: "status", status: "working" });
			expect(deps.tasks.isDraining).not.toHaveBeenCalled();
		});

		it("skips with a draining reason when draining mode is active", async () => {
			const deps = makeDeps({ isDraining: true });
			const result = await prepareIssueSession(deps as never, ctx, { requirePending: true });

			expect(result).toEqual({ skip: true, kind: "draining" });
			expect(deps.github.postComment).toHaveBeenCalledWith(
				"mbrooks",
				"yolomatic",
				56,
				"Deploy in progress. Task will resume after restart.",
			);
		});

		it("does not require pending status for comment-style flows", async () => {
			const deps = makeDeps({
				sessions: { get: vi.fn(async () => makeSession({ status: "working" })) },
			});
			const result = await prepareIssueSession(deps as never, ctx, { commentBodies: ["hi"] });

			expect(result).toEqual({ skip: false, session: expect.objectContaining({ status: "working" }) });
		});

		it("blocks comment-style implementation starts while refinement is working", async () => {
			const deps = makeDeps({
				sessions: { get: vi.fn(async () => makeSession({ kind: "refinement", status: "working" })) },
			});

			const result = await prepareIssueSession(deps as never, ctx, { commentBodies: ["hi"] });

			expect(result).toEqual({ skip: true, kind: "status", status: "working" });
			expect(deps.tasks.isDraining).not.toHaveBeenCalled();
		});

		it("queues comment bodies and posts a draining message when draining with comments", async () => {
			const deps = makeDeps({
				isDraining: true,
				sessions: {
					get: vi.fn(async () => makeSession({ status: "working", queuedComments: ["existing"] })),
					createSession: vi.fn(),
					updateStatus: vi.fn(),
				},
			});
			const result = await prepareIssueSession(deps as never, ctx, { commentBodies: ["new"] });

			expect(result).toEqual({ skip: true, kind: "draining" });
			expect(deps.sessions.updateStatus).toHaveBeenCalledWith(
				"mbrooks",
				"yolomatic",
				56,
				"working",
				expect.objectContaining({ resumeOnBoot: true, queuedComments: ["existing", "new"] }),
				"implementation",
			);
		});
	});

	describe("routePRTimelineComment", () => {
		function makeDeps(overrides?: {
			getPullRequest?: ReturnType<typeof vi.fn>;
			findSessionByPR?: ReturnType<typeof vi.fn>;
			prReview?: { execute: ReturnType<typeof vi.fn> };
			adminGithubUsername?: string;
		}) {
			const sessions = {
				findSessionByPR: overrides?.findSessionByPR ?? vi.fn(async () => null),
			};
			const tasks = {
				cancel: vi.fn(() => false),
			};
			const github = {
				getPullRequest:
					overrides?.getPullRequest ??
					vi.fn(async () => ({ head: { ref: "yolomatic/issue-56" }, state: "open", merged: false })),
				postComment: vi.fn(async () => 1),
				removeLabel: vi.fn(),
				addLabels: vi.fn(),
			};
			return {
				deps: {
					github: github as never,
					sessions: sessions as never,
					tasks: tasks as never,
					adminGithubUsername: overrides?.adminGithubUsername,
					prReview: overrides?.prReview,
				},
				github,
				sessions,
				tasks,
			};
		}

		const basePayload = {
			action: "created",
			issue: { number: 99, pull_request: { url: "https://api.github.com/repos/mbrooks/yolomatic/pulls/99" } },
			comment: { id: 1, body: "please update", user: { login: "human" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "human" },
		};

		it("returns false for non-PR comments so the caller continues", async () => {
			const { deps, github } = makeDeps();
			const routed = await routePRTimelineComment(
				deps,
				{ ...basePayload, issue: { number: 99 } },
				"mbrooks",
				"yolomatic",
				99,
			);

			expect(routed).toBe(false);
			expect(github.getPullRequest).not.toHaveBeenCalled();
		});

		it("logs and returns true when the PR cannot be fetched", async () => {
			const { deps, github } = makeDeps({ getPullRequest: vi.fn(async () => null) });
			const routed = await routePRTimelineComment(deps, basePayload, "mbrooks", "yolomatic", 99);

			expect(routed).toBe(true);
			expect(github.getPullRequest).toHaveBeenCalledWith("mbrooks", "yolomatic", 99);
		});

		it("logs and returns true when the PR branch is not associated with a session", async () => {
			const { deps, sessions } = makeDeps({
				getPullRequest: vi.fn(async () => ({ head: { ref: "feature/x" }, state: "open", merged: false })),
			});
			const routed = await routePRTimelineComment(deps, basePayload, "mbrooks", "yolomatic", 99);

			expect(routed).toBe(true);
			expect(sessions.findSessionByPR).toHaveBeenCalledWith("mbrooks", "yolomatic", 99);
		});

		it("routes an admin stop command to the mapped issue", async () => {
			const stop = vi.fn(() => true);
			const { deps, github, tasks } = makeDeps({
				adminGithubUsername: "admin",
				getPullRequest: vi.fn(async () => ({ head: { ref: "yolomatic/issue-56" }, state: "open", merged: false })),
			});
			tasks.cancel = stop;
			const routed = await routePRTimelineComment(
				deps,
				{ ...basePayload, comment: { id: 1, body: "/yolomatic stop", user: { login: "admin" } }, sender: { login: "admin" } },
				"mbrooks",
				"yolomatic",
				99,
			);

			expect(routed).toBe(true);
			expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, "Stopping Yolomatic...");
			expect(stop).toHaveBeenCalledWith("mbrooks/yolomatic#56");
		});

		it("forwards the comment to the PR review handler when mapped and not a stop command", async () => {
			const execute = vi.fn(async () => undefined);
			const { deps } = makeDeps({
				getPullRequest: vi.fn(async () => ({ head: { ref: "yolomatic/issue-56" }, state: "open", merged: false })),
				prReview: { execute },
			});
			const routed = await routePRTimelineComment(deps, basePayload, "mbrooks", "yolomatic", 99);

			expect(routed).toBe(true);
			expect(execute).toHaveBeenCalledWith(
				expect.objectContaining({
					action: "created",
					pull_request: expect.objectContaining({ number: 99, head: { ref: "yolomatic/issue-56" } }),
				}),
			);
		});

		it("maps via stored PR mapping when the branch is not a Yolomatic issue branch", async () => {
			const execute = vi.fn(async () => undefined);
			const { deps, sessions } = makeDeps({
				getPullRequest: vi.fn(async () => ({ head: { ref: "custom-branch" }, state: "open", merged: false })),
				findSessionByPR: vi.fn(async () => ({ issueNumber: 77 } as never)),
				prReview: { execute },
			});
			const routed = await routePRTimelineComment(deps, basePayload, "mbrooks", "yolomatic", 99);

			expect(routed).toBe(true);
			expect(sessions.findSessionByPR).toHaveBeenCalledWith("mbrooks", "yolomatic", 99);
			expect(execute).toHaveBeenCalled();
		});

		it("returns true without forwarding when no prReview handler is configured", async () => {
			const { deps } = makeDeps({
				getPullRequest: vi.fn(async () => ({ head: { ref: "yolomatic/issue-56" }, state: "open", merged: false })),
			});
			const routed = await routePRTimelineComment(deps, basePayload, "mbrooks", "yolomatic", 99);

			expect(routed).toBe(true);
		});
	});
});
