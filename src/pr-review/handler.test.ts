import { describe, expect, it, vi } from "vitest";

import { PRReviewHandler } from "./handler.js";

describe("PRReviewHandler", () => {
	function createHandler(options: Partial<{ maxIterations: number }> = {}) {
		const octokit = {
			issues: {
				createComment: vi.fn(async () => ({})),
			},
			pulls: {
				listReviewComments: vi.fn(async () => ({ data: [] })),
			},
		};
		const sessionManager = {
			getSession: vi.fn(),
			associatePR: vi.fn(),
			updateStatus: vi.fn(async (_o: string, _r: string, _i: number, status: string) => ({
				issueNumber: 56,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: status as "working" | "waiting-feedback" | "complete" | "failed" | "pending",
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
				lastActivity: new Date().toISOString(),
				seeded: true,
				prNumber: 99,
				prUrl: "https://github.com/mbrooks/tars/pull/99",
			})),
			incrementIterationCount: vi.fn(async () => ({
				issueNumber: 56,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
				lastActivity: new Date().toISOString(),
				seeded: true,
				iterationCount: 1,
			})),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
				branch: "tars/issue-56",
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 56,
			})),
			commitAndPush: vi.fn(),
		};
		const executor = {
			execute: vi.fn(async () => ({
				status: "complete" as const,
				summary: "Fixed the typo.",
				rawResponse: "TARS_STATUS: complete\nFixed the typo.",
			})),
		};

		const handler = new PRReviewHandler({
			 sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			maxIterations: options.maxIterations ?? 3,
			octokit: octokit as never,
		});

		return { handler, octokit, sessionManager, workspaceManager, executor };
	}

	it("ignores events from the bot itself", async () => {
		const { handler, sessionManager } = createHandler();
		await handler.handlePullRequestReviewCommentEvent({
			action: "created",
			pull_request: { number: 99, head: { ref: "tars/issue-56" }, state: "open", merged: false },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "tars-bot" },
			comment: { id: 1, body: "Fix this", user: { login: "tars-bot" } },
		});
		expect(sessionManager.getSession).not.toHaveBeenCalled();
	});

	it("ignores non-TARS branches", async () => {
		const { handler, sessionManager } = createHandler();
		await handler.handlePullRequestReviewCommentEvent({
			action: "created",
			pull_request: { number: 99, head: { ref: "feature/other" }, state: "open", merged: false },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Fix this", user: { login: "user" } },
		});
		expect(sessionManager.getSession).not.toHaveBeenCalled();
	});

	it("ignores closed/merged PRs", async () => {
		const { handler, sessionManager } = createHandler();
		await handler.handlePullRequestReviewCommentEvent({
			action: "created",
			pull_request: { number: 99, head: { ref: "tars/issue-56" }, state: "closed", merged: true },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Fix this", user: { login: "user" } },
		});
		expect(sessionManager.getSession).not.toHaveBeenCalled();
	});

	it("ignores when no session exists for the mapped issue", async () => {
		const { handler, sessionManager, executor } = createHandler();
		sessionManager.getSession.mockResolvedValue(null);
		await handler.handlePullRequestReviewCommentEvent({
			action: "created",
			pull_request: { number: 99, head: { ref: "tars/issue-56" }, state: "open", merged: false },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Fix this", user: { login: "user" } },
		});
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("processes actionable review comments and pushes changes", async () => {
		const { handler, sessionManager, workspaceManager, executor, octokit } = createHandler();
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "tars",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "complete",
			sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
			prNumber: 99,
			prUrl: "https://github.com/mbrooks/tars/pull/99",
		});

		await handler.handlePullRequestReviewCommentEvent({
			action: "created",
			pull_request: { number: 99, head: { ref: "tars/issue-56" }, state: "open", merged: false },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Please fix the typo on line 42", user: { login: "user" }, path: "src/foo.ts", line: 42 },
		});

		expect(sessionManager.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 56, "working");
		expect(executor.execute).toHaveBeenCalledTimes(1);
		const executeCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(executeCall[2]).toEqual({
			comments: [{ body: "Please fix the typo on line 42", user: "user", path: "src/foo.ts", line: 42 }],
			reviewBody: undefined,
		});
		expect(workspaceManager.commitAndPush).toHaveBeenCalledWith("mbrooks", "tars", 56, "TARS: Fixed the typo.");
		expect(sessionManager.incrementIterationCount).toHaveBeenCalledWith("mbrooks", "tars", 56);
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({
				issue_number: 99,
				body: expect.stringContaining("iteration complete"),
			}),
		);
	});

	it("replies to discussion-only comments without executing", async () => {
		const { handler, sessionManager, executor, octokit } = createHandler();
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "tars",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "complete",
			sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		});

		await handler.handlePullRequestReviewCommentEvent({
			action: "created",
			pull_request: { number: 99, head: { ref: "tars/issue-56" }, state: "open", merged: false },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "LGTM", user: { login: "user" } },
		});

		expect(executor.execute).not.toHaveBeenCalled();
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({
				issue_number: 99,
				body: expect.stringContaining("No code changes required"),
			}),
		);
	});

	it("enforces max iteration limit", async () => {
		const { handler, sessionManager, executor, octokit } = createHandler({ maxIterations: 2 });
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "tars",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "complete",
			sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
			iterationCount: 2,
		});

		await handler.handlePullRequestReviewCommentEvent({
			action: "created",
			pull_request: { number: 99, head: { ref: "tars/issue-56" }, state: "open", merged: false },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Please fix this", user: { login: "user" } },
		});

		expect(executor.execute).not.toHaveBeenCalled();
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({
				issue_number: 99,
				body: expect.stringContaining("Maximum iteration limit"),
			}),
		);
	});

	it("associates PR if not already tracked", async () => {
		const { handler, sessionManager } = createHandler();
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "tars",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "complete",
			sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
			// no prNumber/prUrl
		});

		await handler.handlePullRequestReviewCommentEvent({
			action: "created",
			pull_request: { number: 99, head: { ref: "tars/issue-56" }, state: "open", merged: false },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "LGTM", user: { login: "user" } },
		});

		expect(sessionManager.associatePR).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			56,
			99,
			"https://github.com/mbrooks/tars/pull/99",
		);
	});

	it("handles pull_request_review submitted events", async () => {
		const { handler, sessionManager, executor } = createHandler();
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "tars",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "complete",
			sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		});

		await handler.handlePullRequestReviewEvent({
			action: "submitted",
			pull_request: { number: 99, head: { ref: "tars/issue-56" }, state: "open", merged: false },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			review: { id: 101, body: "Please add more tests.", state: "changes_requested", user: { login: "user" } },
		});

		expect(executor.execute).toHaveBeenCalledTimes(1);
		const executeCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(executeCall[2]).toEqual({
			comments: [],
			reviewBody: "Please add more tests.",
		});
	});

	it("ignores non-submitted/non-edited review actions", async () => {
		const { handler, sessionManager } = createHandler();
		sessionManager.getSession.mockResolvedValue(null);

		await handler.handlePullRequestReviewEvent({
			action: "dismissed",
			pull_request: { number: 99, head: { ref: "tars/issue-56" }, state: "open", merged: false },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			review: { id: 101, body: null, state: "dismissed", user: { login: "user" } },
		});

		expect(sessionManager.getSession).not.toHaveBeenCalled();
	});

	it("posts failure comment when execution throws", async () => {
		const { handler, sessionManager, executor, octokit } = createHandler();
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "tars",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "complete",
			sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		});
		executor.execute.mockRejectedValue(new Error("Executor exploded"));

		await expect(
			handler.handlePullRequestReviewCommentEvent({
				action: "created",
				pull_request: { number: 99, head: { ref: "tars/issue-56" }, state: "open", merged: false },
				repository: { name: "tars", owner: { login: "mbrooks" } },
				sender: { login: "user" },
				comment: { id: 1, body: "Fix this", user: { login: "user" } },
			}),
		).rejects.toThrow("Executor exploded");

		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.stringContaining("TARS failed"),
			}),
		);
	});
});
