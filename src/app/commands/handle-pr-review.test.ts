import { describe, expect, it, vi } from "vitest";

import { HandlePRReview } from "./handle-pr-review.js";
import type { SessionState } from "../../session/store.js";

describe("HandlePRReview", () => {
	function makeSession(overrides: Partial<SessionState> = {}): SessionState {
		return {
			issueNumber: 56,
			repo: "yeetomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "complete",
			sessionPath: "/tmp/sessions/github-mbrooks-yeetomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yeetomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
			prNumber: 99,
			prUrl: "https://github.com/mbrooks/yeetomatic/pull/99",
			...overrides,
		};
	}

	function createHandler() {
		const sessions = {
			get: vi.fn(),
			getAll: vi.fn(),
			save: vi.fn(),
			delete: vi.fn(),
			archive: vi.fn(),
			createSession: vi.fn(),
			updateStatus: vi.fn(async (_o: string, _r: string, _i: number, status: SessionState["status"], updates?: Partial<SessionState>) =>
				makeSession({ status, ...updates }),
			),
			markSeeded: vi.fn(),
			associatePR: vi.fn(async () => makeSession({ prNumber: 99, prUrl: "https://github.com/mbrooks/yeetomatic/pull/99" })),
			incrementIterationCount: vi.fn(async () => makeSession({ status: "working", iterationCount: 1 })),
			findSessionByPR: vi.fn(async () => null),
			cancelSession: vi.fn(async () => makeSession({ status: "cancelled" })),
			pauseSession: vi.fn(),
			unpauseSession: vi.fn(),
			restartSession: vi.fn(),
			markComplete: vi.fn(),
			markFailed: vi.fn(),
			markStale: vi.fn(),
		};
		const workspaces = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-yeetomatic/.worktrees/issue-56",
				branch: "yeetomatic/issue-56",
			})),
			removeWorktree: vi.fn(),
			commitAndPush: vi.fn(async () => true),
			commitAndPushPath: vi.fn(async () => true),
			hasChanges: vi.fn(),
			getWorktreePath: vi.fn(),
			getGitStatus: vi.fn(async () => ""),
			getGitDiff: vi.fn(async () => ""),
		};
		const executor = {
			execute: vi.fn(),
			executePRReview: vi.fn(async () => ({
				status: "complete" as const,
				summary: "Fixed the typo.",
				rawResponse: "YEETOMATIC_STATUS: complete\nFixed the typo.",
			})),
		};
		const github = {
			postComment: vi.fn(async () => 1),
			postPRComment: vi.fn(async () => 1),
			addLabels: vi.fn(),
			removeLabel: vi.fn(),
			getPullRequest: vi.fn(),
			createPullRequest: vi.fn(),
			listPullRequests: vi.fn(),
			getIssue: vi.fn(),
			createIssue: vi.fn(),
			fileSelfReport: vi.fn(),
			listReviewComments: vi.fn(async () => []),
		};
		const registerTask = vi.fn((..._args: unknown[]): symbol | null => Symbol("test-task"));
		const tasks = {
			cancel: vi.fn(() => false),
			isActive: vi.fn(() => false),
			steer: vi.fn(),
			register: registerTask,
			unregister: vi.fn(),
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		};

		const handler = new HandlePRReview({
			sessions: sessions as never,
			workspaces: workspaces as never,
			executor: executor as never,
			github: github as never,
			tasks: tasks as never,
			githubUsername: "yeetomatic-bot",
			selfReportEnabled: false,
		});

		return { handler, sessions, workspaces, executor, github, tasks };
	}

	it("ignores events from the bot itself", async () => {
		const { handler, sessions } = createHandler();
		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "yeetomatic-bot" },
			comment: { id: 1, body: "Fix this", user: { login: "yeetomatic-bot" } },
		});
		expect(sessions.get).not.toHaveBeenCalled();
	});

	it("steers review feedback instead of starting a second execution for an active session", async () => {
		const { handler, sessions, executor, github, tasks } = createHandler();
		sessions.get.mockResolvedValue(makeSession());
		tasks.register.mockReturnValue(null);
		tasks.steer.mockResolvedValue(true);

		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Fix this", user: { login: "user" } },
		});

		expect(tasks.steer).toHaveBeenCalledWith("mbrooks/yeetomatic#56", "Fix this");
		expect(executor.executePRReview).not.toHaveBeenCalled();
		expect(tasks.unregister).not.toHaveBeenCalled();
		expect(github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			99,
			"Review feedback was steered to the active Yeetomatic task.",
		);
	});

	it("reports busy when duplicate review feedback cannot be steered", async () => {
		const { handler, sessions, executor, github, tasks } = createHandler();
		sessions.get.mockResolvedValue(makeSession());
		tasks.register.mockReturnValue(null);
		tasks.steer.mockResolvedValue(false);

		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Fix this", user: { login: "user" } },
		});

		expect(executor.executePRReview).not.toHaveBeenCalled();
		expect(github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			99,
			"Yeetomatic is busy. Review feedback could not be steered.",
		);
	});

	it("ignores non-Yeetomatic branches", async () => {
		const { handler, sessions } = createHandler();
		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "feature/other" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Fix this", user: { login: "user" } },
		});
		expect(sessions.get).not.toHaveBeenCalled();
		expect(sessions.findSessionByPR).toHaveBeenCalledWith("mbrooks", "yeetomatic", 99);
	});

	it("processes non-issue branch PR feedback using the stored PR mapping", async () => {
		const { handler, sessions, workspaces, executor, github, tasks } = createHandler();
		const session = makeSession({
			workspacePath: "/tmp/workspaces/mbrooks-yeetomatic/.worktrees/custom-branch-123",
			branch: "yeetomatic/custom-branch-123",
			prNumber: 99,
			prUrl: "https://github.com/mbrooks/yeetomatic/pull/99",
		});
		sessions.findSessionByPR.mockResolvedValue(session as never);
		sessions.get.mockResolvedValue(session as never);

		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/custom-branch-123" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Please update the generated file", user: { login: "user" }, path: "src/foo.ts", line: 42 },
		});

		expect(sessions.findSessionByPR).toHaveBeenCalledWith("mbrooks", "yeetomatic", 99);
		expect(executor.executePRReview).toHaveBeenCalledTimes(1);
		expect(workspaces.createOrGetWorktree).not.toHaveBeenCalled();
		expect(workspaces.commitAndPushPath).toHaveBeenCalledWith(
			"/tmp/workspaces/mbrooks-yeetomatic/.worktrees/custom-branch-123",
			"yeetomatic/custom-branch-123",
			"Yeetomatic: Fix the typo",
		);
		expect(tasks.register).toHaveBeenCalledWith("mbrooks/yeetomatic#56", expect.any(Function), expect.any(Function));
		expect(tasks.unregister).toHaveBeenCalledWith("mbrooks/yeetomatic#56", expect.any(Symbol));
		expect(github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			99,
			expect.stringContaining("iteration complete"),
		);
	});

	it("ignores closed and merged PRs", async () => {
		const { handler, sessions } = createHandler();
		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "closed", merged: true },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Fix this", user: { login: "user" } },
		});
		expect(sessions.get).not.toHaveBeenCalled();
	});

	it("silently ignores a Yeetomatic-named PR when no session exists for the mapped issue", async () => {
		const { handler, sessions, executor, github } = createHandler();
		sessions.get.mockResolvedValue(null);

		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Fix this", user: { login: "user" } },
		});

		expect(executor.executePRReview).not.toHaveBeenCalled();
		expect(sessions.findSessionByPR).not.toHaveBeenCalled();
		expect(github.postPRComment).not.toHaveBeenCalled();
	});

	it("silently ignores a Yeetomatic-named PR associated with a different PR", async () => {
		const { handler, sessions, executor, github } = createHandler();
		sessions.get.mockResolvedValue(
			makeSession({
				prNumber: 100,
				prUrl: "https://github.com/mbrooks/yeetomatic/pull/100",
			}),
		);

		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Fix this", user: { login: "user" } },
		});

		expect(executor.executePRReview).not.toHaveBeenCalled();
		expect(sessions.updateStatus).not.toHaveBeenCalled();
		expect(github.postPRComment).not.toHaveBeenCalled();
	});

	it("processes actionable review comments and pushes changes", async () => {
		const { handler, sessions, workspaces, executor, github, tasks } = createHandler();
		sessions.get.mockResolvedValue(
			makeSession({
				prNumber: 99,
				prUrl: "https://github.com/mbrooks/yeetomatic/pull/99",
			}),
		);

		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Please fix the typo on line 42", user: { login: "user" }, path: "src/foo.ts", line: 42 },
		});

		expect(sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yeetomatic", 56, "working");
		expect(executor.executePRReview).toHaveBeenCalledTimes(1);
		expect(executor.executePRReview).toHaveBeenCalledWith(
			expect.objectContaining({ issueNumber: 56 }),
			{
				comments: [{ body: "Please fix the typo on line 42", user: "user", path: "src/foo.ts", line: 42 }],
				reviewBody: undefined,
			},
			expect.any(AbortSignal),
			expect.any(Function),
			expect.any(Function),
		);
		expect(workspaces.commitAndPushPath).toHaveBeenCalledWith(
			"/tmp/workspaces/mbrooks-yeetomatic/.worktrees/issue-56",
			"yeetomatic/issue-56",
			"Yeetomatic: Fix the typo",
		);
		expect(sessions.incrementIterationCount).toHaveBeenCalledWith("mbrooks", "yeetomatic", 56);
		expect(tasks.register).toHaveBeenCalledWith("mbrooks/yeetomatic#56", expect.any(Function), expect.any(Function));
		expect(tasks.unregister).toHaveBeenCalledWith("mbrooks/yeetomatic#56", expect.any(Symbol));
		expect(github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			99,
			expect.stringContaining("iteration complete"),
		);
	});

	it("uses the PR head captured before execution as a guarded push lease", async () => {
		const { handler, sessions, workspaces, github } = createHandler();
		const expectedRemoteHead = "a".repeat(40);
		sessions.get.mockResolvedValue(makeSession());
		github.getPullRequest.mockResolvedValue({
			head: { ref: "yeetomatic/issue-56", sha: expectedRemoteHead },
			state: "open",
			merged: false,
		});

		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Rebase this branch onto main", user: { login: "user" } },
		});

		expect(workspaces.commitAndPushPath).toHaveBeenCalledWith(
			"/tmp/workspaces/mbrooks-yeetomatic/.worktrees/issue-56",
			"yeetomatic/issue-56",
			"Yeetomatic: Fix the typo",
			undefined,
			expectedRemoteHead,
		);
	});

	it("marks the session failed and reports diagnostics when PR delivery rejects", async () => {
		const { handler, sessions, workspaces, github, tasks } = createHandler();
		const expectedRemoteHead = "b".repeat(40);
		sessions.get.mockResolvedValue(makeSession());
		github.getPullRequest.mockResolvedValue({
			head: { ref: "yeetomatic/issue-56", sha: expectedRemoteHead },
			state: "open",
			merged: false,
		});
		workspaces.commitAndPushPath.mockRejectedValue(
			new Error("git push rejected: non-fast-forward"),
		);

		await expect(
			handler.execute({
				action: "created",
				pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
				repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
				sender: { login: "user" },
				comment: { id: 1, body: "Resolve the branch conflicts", user: { login: "user" } },
			}),
		).resolves.toBeUndefined();

		expect(sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yeetomatic", 56, "failed");
		expect(sessions.updateStatus).not.toHaveBeenCalledWith("mbrooks", "yeetomatic", 56, "complete");
		expect(github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			99,
			expect.stringContaining("Yeetomatic delivery failed."),
		);
		expect(github.addLabels).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			56,
			["yeetomatic-working", "yeetomatic-delivery-failed"],
		);
		expect(tasks.unregister).toHaveBeenCalledWith("mbrooks/yeetomatic#56", expect.any(Symbol));
	});

	it("falls back to the issue branch when the session has no stored branch", async () => {
		const { handler, sessions, workspaces } = createHandler();
		sessions.get.mockResolvedValue(
			makeSession({
				branch: undefined,
				prNumber: 99,
				prUrl: "https://github.com/mbrooks/yeetomatic/pull/99",
			}),
		);

		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Please fix the typo on line 42", user: { login: "user" }, path: "src/foo.ts", line: 42 },
		});

		expect(workspaces.commitAndPushPath).toHaveBeenCalledWith(
			"/tmp/workspaces/mbrooks-yeetomatic/.worktrees/issue-56",
			"yeetomatic/issue-56",
			"Yeetomatic: Fix the typo",
		);
	});

	it("posts no-changes message when commitAndPushPath returns false", async () => {
		const { handler, sessions, workspaces, github } = createHandler();
		workspaces.commitAndPushPath.mockResolvedValue(false);
		sessions.get.mockResolvedValue(
			makeSession({
				prNumber: 99,
				prUrl: "https://github.com/mbrooks/yeetomatic/pull/99",
			}),
		);

		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Please fix the typo on line 42", user: { login: "user" }, path: "src/foo.ts", line: 42 },
		});

		expect(github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			99,
			expect.stringContaining("No changes were needed."),
		);
	});

	it("reports a cancelled review without pushing changes", async () => {
		const { handler, sessions, workspaces, executor, github } = createHandler();
		sessions.get.mockResolvedValue(makeSession());
		(executor.executePRReview as ReturnType<typeof vi.fn>).mockResolvedValue({
			status: "cancelled",
			summary: "Stopped by request.",
			rawResponse: "YEETOMATIC_STATUS: cancelled\nStopped by request.",
		});

		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Please stop", user: { login: "user" } },
		});

		expect(sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yeetomatic", 56, "cancelled");
		expect(workspaces.commitAndPushPath).not.toHaveBeenCalled();
		expect(github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			99,
			expect.stringContaining("Task cancelled by admin."),
		);
	});

	it("replies to discussion-only comments without executing", async () => {
		const { handler, sessions, executor, github } = createHandler();
		sessions.get.mockResolvedValue(makeSession());

		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "LGTM", user: { login: "user" } },
		});

		expect(executor.executePRReview).not.toHaveBeenCalled();
		expect(github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			99,
			expect.stringContaining("No code changes required"),
		);
	});

	it("does not claim an untracked PR from its branch name", async () => {
		const { handler, sessions, executor, github } = createHandler();
		sessions.get.mockResolvedValue(makeSession({ prNumber: undefined, prUrl: undefined }));

		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "LGTM", user: { login: "user" } },
		});

		expect(sessions.associatePR).not.toHaveBeenCalled();
		expect(executor.executePRReview).not.toHaveBeenCalled();
		expect(github.postPRComment).not.toHaveBeenCalled();
	});

	it("handles submitted review events", async () => {
		const { handler, sessions, executor } = createHandler();
		sessions.get.mockResolvedValue(makeSession());

		await handler.execute({
			action: "submitted",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			review: { id: 101, body: "Please add more tests.", state: "changes_requested", user: { login: "user" } },
		});

		expect(executor.executePRReview).toHaveBeenCalledWith(
			expect.objectContaining({ issueNumber: 56 }),
			{
				comments: [],
				reviewBody: "Please add more tests.",
			},
			expect.any(AbortSignal),
			expect.any(Function),
			expect.any(Function),
		);
	});

	it("queues review feedback during draining mode", async () => {
		const { handler, sessions, executor, github, tasks } = createHandler();
		tasks.isDraining.mockReturnValue(true);
		sessions.get.mockResolvedValue(makeSession({ queuedComments: ["older note"] }));

		await handler.execute({
			action: "submitted",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			review: { id: 101, body: "Please add more tests.", state: "changes_requested", user: { login: "user" } },
		});

		expect(executor.executePRReview).not.toHaveBeenCalled();
		expect(sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			56,
			"complete",
			expect.objectContaining({
				resumeOnBoot: true,
				queuedComments: ["older note", "Please add more tests."],
			}),
			"implementation",
		);
		expect(github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			99,
			"Deploy in progress. Review feedback will be processed after restart.",
		);
	});

	it("ignores non-supported review actions", async () => {
		const { handler, sessions } = createHandler();

		await handler.execute({
			action: "dismissed",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			review: { id: 101, body: null, state: "dismissed", user: { login: "user" } },
		});

		expect(sessions.get).not.toHaveBeenCalled();
	});

	it("posts 'Build failed' comment when execution throws a 429 rate-limit error", async () => {
		const { handler, sessions, executor, github } = createHandler();
		sessions.get.mockResolvedValue(makeSession());
		executor.executePRReview.mockRejectedValue(new Error('429 "you (aubiematt) have reached your weekly usage limit..."'));

		await expect(
			handler.execute({
				action: "created",
				pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
				repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
				sender: { login: "user" },
				comment: { id: 1, body: "Fix this", user: { login: "user" } },
			}),
		).rejects.toThrow('429 "you (aubiematt) have reached your weekly usage limit..."');

		expect(github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			99,
			expect.stringContaining("**Build failed**"),
		);
		expect(sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yeetomatic", 56, "failed");
	});

	it("posts 'Build failed' comment when executor returns failed status for rate-limit error", async () => {
		const { handler, sessions, executor, github } = createHandler();
		sessions.get.mockResolvedValue(makeSession());
		(executor.executePRReview as ReturnType<typeof vi.fn>).mockResolvedValue({
			status: "failed",
			summary: '429 "you (aubiematt) have reached your weekly usage limit..."',
			rawResponse: "",
		});

		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Fix this", user: { login: "user" } },
		});

		expect(github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			99,
			expect.stringContaining("**Build failed**"),
		);
		expect(sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yeetomatic", 56, "failed");
	});

	it("posts generic failure comment when executor returns failed status for non-rate-limit error", async () => {
		const { handler, sessions, executor, github } = createHandler();
		sessions.get.mockResolvedValue(makeSession());
		(executor.executePRReview as ReturnType<typeof vi.fn>).mockResolvedValue({
			status: "failed",
			summary: "Some random error",
			rawResponse: "",
		});

		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Fix this", user: { login: "user" } },
		});

		expect(github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			99,
			expect.stringContaining("Yeetomatic failed."),
		);
		expect(sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yeetomatic", 56, "failed");
	});

	it("marks execution-environment blocker review responses as failed", async () => {
		const { handler, sessions, executor, github } = createHandler();
		sessions.get.mockResolvedValue(makeSession());
		(executor.executePRReview as ReturnType<typeof vi.fn>).mockResolvedValue({
			status: "working",
			summary:
				"The bash tool won't execute because the configured working directory (/workspaces/x) doesn't exist on this filesystem. Without a valid cwd, I can't run any bash commands.",
			rawResponse: "",
		});

		await handler.execute({
			action: "created",
			pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Fix this", user: { login: "user" } },
		});

		expect(sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yeetomatic", 56, "failed");
		expect(github.postPRComment).not.toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			99,
			expect.stringContaining("still working on the review feedback"),
		);
	});

	it("posts failure comment when execution throws", async () => {
		const { handler, sessions, executor, github } = createHandler();
		sessions.get.mockResolvedValue(makeSession());
		executor.executePRReview.mockRejectedValue(new Error("Executor exploded"));

		await expect(
			handler.execute({
				action: "created",
				pull_request: { number: 99, head: { ref: "yeetomatic/issue-56" }, state: "open", merged: false },
				repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
				sender: { login: "user" },
				comment: { id: 1, body: "Fix this", user: { login: "user" } },
			}),
		).rejects.toThrow("Executor exploded");

		expect(github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			99,
			expect.stringContaining("Yeetomatic failed"),
		);
	});
});
