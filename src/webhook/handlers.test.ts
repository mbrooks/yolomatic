import { describe, expect, it, vi } from "vitest";

import { GitHubIssueHandlers } from "./handlers.js";
import { normalizeWebhookEvent } from "../adapters/github/webhook-adapter.js";

declare module "./handlers.js" {
	interface GitHubIssueHandlers {
		handleIssueEvent(payload: unknown): Promise<void>;
		handleCommentEvent(payload: unknown): Promise<void>;
		handlePullRequestReviewCommentEvent(payload: unknown): Promise<void>;
		handlePullRequestReviewEvent(payload: unknown): Promise<void>;
	}
}

async function dispatchWebhook(
	handlers: GitHubIssueHandlers,
	event: string,
	payload: unknown,
): Promise<void> {
	const [normalized] = normalizeWebhookEvent(event, payload, "test-delivery");
	expect(normalized).toBeDefined();
	await handlers.handleGitHubEvent(normalized!);
}

GitHubIssueHandlers.prototype.handleIssueEvent = async function (payload: unknown): Promise<void> {
	await dispatchWebhook(this, "issues", payload);
};

GitHubIssueHandlers.prototype.handleCommentEvent = async function (payload: unknown): Promise<void> {
	await dispatchWebhook(this, "issue_comment", payload);
};

GitHubIssueHandlers.prototype.handlePullRequestReviewCommentEvent = async function (payload: unknown): Promise<void> {
	await dispatchWebhook(this, "pull_request_review_comment", payload);
};

GitHubIssueHandlers.prototype.handlePullRequestReviewEvent = async function (payload: unknown): Promise<void> {
	await dispatchWebhook(this, "pull_request_review", payload);
};

describe("GitHubIssueHandlers PR review delegation", () => {
	function createDeps() {
		const getSession = vi.fn(async () => ({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "complete" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
			prNumber: 99,
			prUrl: "https://github.com/mbrooks/yolomatic/pull/99",
		}));
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
				createComment: vi.fn(async () => ({ data: { id: 1 } })),
			},
			pulls: {
				get: vi.fn(async () => ({
					data: {
						head: { ref: "yolomatic/issue-56" },
						base: { ref: "main" },
						state: "open",
						merged: false,
						mergeable: true,
						mergeable_state: "clean",
						draft: false,
					},
				})),
				create: vi.fn(async () => ({ data: { html_url: "https://github.com/mbrooks/yolomatic/pull/99", number: 99 } })),
				list: vi.fn(async () => ({ data: [] as any[] })),
				listReviewComments: vi.fn(async () => ({ data: [] })),
			},
		};
		const sessionManager = {
			createSession: vi.fn(async () => ({
				issueNumber: 56,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "complete" as never,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			get: getSession,
			getSession,
			updateStatus: vi.fn(async () => ({
				issueNumber: 56,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "working" as never,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			findSessionByPR: vi.fn(async () => null),
			incrementIterationCount: vi.fn(),
			cancelSession: vi.fn(async () => ({
				issueNumber: 56,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "cancelled" as never,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			resumeSession: vi.fn(),
			sessionsDir: "/tmp/sessions",
			store: {} as never,
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
				branch: "yolomatic/issue-56",
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 56,
			})),
			syncWorktree: vi.fn(async () => undefined),
			commitAndPush: vi.fn(async () => true),
			commitAndPushPath: vi.fn(async () => true),
			removeWorktree: vi.fn(),
			getGitStatus: vi.fn(async () => ""),
			getGitDiff: vi.fn(async () => ""),
		};
		const executor = {
			execute: vi.fn(async () => ({
				status: "complete" as never,
				summary: "Fixed.",
				rawResponse: "YOLO_STATUS: complete\nFixed.",
			})),
			executePRReview: vi.fn(async () => ({
				status: "complete" as never,
				summary: "Fixed.",
				rawResponse: "YOLO_STATUS: complete\nFixed.",
			})),
		};
		return { octokit, sessionManager, workspaceManager, executor };
	}

	it("delegates review comment events to the active PR review command", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handlePullRequestReviewCommentEvent({
			action: "created",
			pull_request: { number: 99, head: { ref: "yolomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Fix this", user: { login: "user" } },
		});

		expect(sessionManager.getSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "implementation");
	});

	it("delegates review submission events to the active PR review command", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handlePullRequestReviewEvent({
			action: "submitted",
			pull_request: { number: 99, head: { ref: "yolomatic/issue-56" }, state: "open", merged: false },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			review: { id: 101, body: "LGTM", state: "approved", user: { login: "user" } },
		});

		expect(sessionManager.getSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "implementation");
	});

	it("throws when runExecution is called without a session", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		sessionManager.getSession.mockResolvedValue(null as never);
		sessionManager.createSession.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "pending" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: false,
		} as never);
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await expect(
			handlers.handleIssueEvent({
				action: "opened",
				issue: { number: 56, title: "Test", body: "Body", assignees: [{ login: "yolomatic-bot" }] },
				repository: { name: "yolomatic", owner: { login: "mbrooks" } },
				sender: { login: "user" },
			}),
		).rejects.toThrow("No session for mbrooks/yolomatic#56");
	});

	it("labels working when execution returns working status", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		executor.execute.mockResolvedValue({
			status: "working" as never,
			summary: "Still working.",
			rawResponse: "YOLO_STATUS: working\nStill working.",
		});
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "complete" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
			prNumber: 99,
			prUrl: "https://github.com/mbrooks/yolomatic/pull/99",
		});
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [{ name: "yolomatic-pr-created" }], assignees: [{ login: "yolomatic-bot" }] },
			comment: { body: "@yolomatic-bot Update", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessionManager.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "working");
		expect(octokit.issues.addLabels).toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["yolomatic-working"] }),
		);
	});

	it("ignores issue events when session status is not pending", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		sessionManager.createSession.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "complete" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		});
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleIssueEvent({
			action: "opened",
			issue: { number: 56, title: "Test", body: "Body", assignees: [{ login: "yolomatic-bot" }] },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("auto-starts accepted issue events", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const pendingSession = {
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "pending" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};
		(sessionManager.getSession as any).mockResolvedValueOnce(null).mockResolvedValue(pendingSession);
		sessionManager.createSession.mockResolvedValue(pendingSession);
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleIssueEvent({
			action: "opened",
			issue: { number: 56, title: "Test", body: "Body", assignees: [{ login: "yolomatic-bot" }] },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(executor.execute).toHaveBeenCalled();
	});

	it("ignores comments on issues created by Yolomatic when Yolomatic is not assigned", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "pending" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		} as never);
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [], assignees: [], user: { login: "yolomatic-bot" } },
			comment: { body: "Just a comment", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessionManager.getSession).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("processes human comments even when webhook sender is the bot account", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "pending" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		} as never);
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [{ name: "yolomatic-working" }], assignees: [{ login: "yolomatic-bot" }] },
			comment: { body: "@yolomatic-bot Please resume work", user: { login: "mbrooks", type: "User" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "yolomatic-bot" },
		});

		expect(sessionManager.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "working");
		expect(executor.execute).toHaveBeenCalledWith(
			expect.objectContaining({ issueNumber: 56 }),
			"@yolomatic-bot Please resume work",
			expect.any(AbortSignal),
			expect.any(Function),
			expect.any(Function),
			expect.any(Array),
		);
	});

	it("routes PR timeline comments through the PR head branch session", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: {
				number: 99,
				labels: [],
				assignees: [],
				user: { login: "yolomatic-bot" },
				pull_request: { url: "https://api.github.com/repos/mbrooks/yolomatic/pulls/99" },
			},
			comment: { id: 123, body: "Can you rebase this?", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(octokit.pulls.get).toHaveBeenCalledWith({
			owner: "mbrooks",
			repo: "yolomatic",
			pull_number: 99,
		});
		expect(sessionManager.getSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "implementation");
		expect(workspaceManager.createOrGetWorktree).not.toHaveBeenCalledWith("mbrooks", "yolomatic", 99);
		expect(workspaceManager.commitAndPushPath).toHaveBeenCalledWith(
			"/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			"yolomatic/issue-56",
			"Yolomatic: Fixed",
		);
		expect(octokit.pulls.create).not.toHaveBeenCalled();
	});

	it("silently ignores PR timeline comments without a stored PR session", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		sessionManager.getSession.mockResolvedValue(null as never);
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: {
				number: 99,
				labels: [],
				assignees: [],
				user: { login: "yolomatic-bot" },
				pull_request: { url: "https://api.github.com/repos/mbrooks/yolomatic/pulls/99" },
			},
			comment: { id: 123, body: "Can you rebase this?", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessionManager.getSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "implementation");
		expect(sessionManager.createSession).not.toHaveBeenCalled();
		expect(workspaceManager.createOrGetWorktree).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
		expect(octokit.issues.createComment).not.toHaveBeenCalled();
	});

	it("blocks issue execution when stored PR head maps to a different issue branch", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		octokit.pulls.get.mockResolvedValue({
			data: {
				head: { ref: "yolomatic/issue-57" },
				base: { ref: "main" },
				state: "open",
				merged: false,
				mergeable: true,
				mergeable_state: "clean",
				draft: false,
			},
		});
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "pending" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
			prNumber: 99,
			prUrl: "https://github.com/mbrooks/yolomatic/pull/99",
		} as never);
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [{ name: "yolomatic-working" }], assignees: [{ login: "yolomatic-bot" }] },
			comment: { body: "@yolomatic-bot Continue", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(executor.execute).not.toHaveBeenCalled();
		expect(sessionManager.updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			56,
			"failed",
			expect.objectContaining({
				summary: expect.stringContaining("maps to 'yolomatic/issue-57'"),
			}),
		);
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({
				issue_number: 56,
				body: expect.stringContaining("stopped before execution"),
			}),
		);
	});

	it("ignores unassigned issue comments without a Yolomatic mention", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [], assignees: [] },
			comment: { body: "Just a comment", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessionManager.getSession).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("ignores unassigned issue comments with @yolomatic mention", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		sessionManager.getSession.mockResolvedValueOnce(null as never).mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "pending" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: false,
		} as never);
		sessionManager.createSession.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "pending" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: false,
		} as never);
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [], assignees: [] },
			comment: { body: "Hey @yolomatic, help me", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessionManager.getSession).not.toHaveBeenCalled();
		expect(sessionManager.createSession).not.toHaveBeenCalled();
		expect(octokit.issues.addLabels).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("ignores assigned issue comments without a Yolomatic label or mention", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [], assignees: [{ login: "yolomatic-bot" }] },
			comment: { body: "Just a comment", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessionManager.getSession).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("does not add labels for an @yolomatic mention when Yolomatic is not assigned", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "pending" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		} as never);
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [], assignees: [] },
			comment: { body: "Hey @yolomatic can you help?", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessionManager.getSession).not.toHaveBeenCalled();
		expect(sessionManager.updateStatus).not.toHaveBeenCalled();
		expect(octokit.issues.addLabels).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("ignores configured-username mentions when Yolomatic is not assigned", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "pending" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		} as never);
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [], assignees: [] },
			comment: { body: "Hey @yolomatic-bot can you help?", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessionManager.getSession).not.toHaveBeenCalled();
		expect(sessionManager.updateStatus).not.toHaveBeenCalled();
		expect(octokit.issues.addLabels).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("reuses existing PR when createPR reports a pull request already exists", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		executor.execute.mockResolvedValue({
			status: "complete" as never,
			summary: "Fixed.",
			rawResponse: "YOLO_STATUS: complete\nFixed.",
		});
		const existingPrUrl = "https://github.com/mbrooks/yolomatic/pull/42";
		const existingPrNumber = 42;
		octokit.pulls.create.mockRejectedValue(
			new Error('Validation Failed: {"resource":"PullRequest","code":"custom","message":"A pull request already exists for mbrooks:yolomatic/issue-6."}'),
		);
		octokit.pulls.list.mockResolvedValue({
			data: [{ number: existingPrNumber, html_url: existingPrUrl }],
		});
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "working" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		} as never);

		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [{ name: "yolomatic-working" }], assignees: [{ login: "yolomatic-bot" }] },
			comment: { body: "@yolomatic-bot Update", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(octokit.pulls.list).toHaveBeenCalledWith(
			expect.objectContaining({ owner: "mbrooks", repo: "yolomatic", head: "mbrooks:yolomatic/issue-56", base: "main", state: "open" }),
		);
		expect(sessionManager.associatePR).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, existingPrNumber, existingPrUrl);
		expect(sessionManager.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "complete");
		expect(octokit.issues.addLabels).toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["yolomatic-pr-created"] }),
		);
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({ body: expect.stringContaining(existingPrUrl) }),
		);
	});

	it("treats 'No commits between' as no changes needed", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		executor.execute.mockResolvedValue({
			status: "complete" as never,
			summary: "Fixed.",
			rawResponse: "YOLO_STATUS: complete\nFixed.",
		});
		octokit.pulls.create.mockRejectedValue(
			new Error('Validation Failed: {"resource":"PullRequest","code":"custom","message":"No commits between main and yolomatic/issue-56."}'),
		);
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "working" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		} as never);

		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [{ name: "yolomatic-working" }], assignees: [{ login: "yolomatic-bot" }] },
			comment: { body: "@yolomatic-bot Update", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessionManager.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "complete");
		expect(octokit.issues.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["yolomatic-pr-created"] }),
		);
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({ body: expect.stringContaining("No code changes were necessary.") }),
		);
	});

	it("ignores /yolomatic stop from non-admin", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
			adminGithubUsername: "admin",
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [{ name: "yolomatic-working" }], assignees: [{ login: "yolomatic-bot" }] },
			comment: { body: "/yolomatic stop", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(executor.execute).not.toHaveBeenCalled();
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({ body: "Only admins can stop Yolomatic." }),
		);
	});

	it("cancels in-flight execution on /yolomatic stop from admin", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const taskController = {
			cancel: vi.fn(() => true),
			isActive: vi.fn(() => true),
			register: vi.fn(),
			unregister: vi.fn(),
		};
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
			adminGithubUsername: "admin",
			taskController: taskController as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [{ name: "yolomatic-working" }], assignees: [{ login: "yolomatic-bot" }] },
			comment: { body: "/yolomatic stop", user: { login: "admin" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "admin" },
		});

		expect(taskController.cancel).toHaveBeenCalledWith("mbrooks/yolomatic#56");
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({ body: "Stopping Yolomatic..." }),
		);
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("marks session cancelled on /yolomatic stop when not in-flight", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const taskController = {
			cancel: vi.fn(() => false),
			isActive: vi.fn(() => false),
			register: vi.fn(),
			unregister: vi.fn(),
		};
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "working" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		} as never);

		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
			adminGithubUsername: "admin",
			taskController: taskController as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [{ name: "yolomatic-working" }], assignees: [{ login: "yolomatic-bot" }] },
			comment: { body: "/yolomatic stop", user: { login: "admin" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "admin" },
		});

		expect(sessionManager.cancelSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 56);
		expect(octokit.issues.removeLabel).toHaveBeenCalledWith(
			expect.objectContaining({ owner: "mbrooks", repo: "yolomatic", issue_number: 56, name: "yolomatic-working" }),
		);
		expect(octokit.issues.addLabels).toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["yolomatic-cancelled"] }),
		);
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({ body: "Task cancelled by admin. Yolomatic is idle." }),
		);
	});

	it("steers comments when Yolomatic is actively executing", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const taskController = {
			cancel: vi.fn(() => false),
			isActive: vi.fn(() => true),
			register: vi.fn(),
			unregister: vi.fn(),
			steer: vi.fn(() => Promise.resolve(true)),
		};
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "working" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		} as never);

		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
			taskController: taskController as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [{ name: "yolomatic-working" }], assignees: [{ login: "yolomatic-bot" }] },
			comment: { body: "@yolomatic-bot Do this instead", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(taskController.isActive).toHaveBeenCalledWith("mbrooks/yolomatic#56");
		expect(taskController.steer).toHaveBeenCalledWith("mbrooks/yolomatic#56", "@yolomatic-bot Do this instead");
		expect(executor.execute).not.toHaveBeenCalled();
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({ body: "Steering comment received." }),
		);
	});

	it("steers description updates when Yolomatic is actively executing", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const taskController = {
			cancel: vi.fn(() => false),
			isActive: vi.fn(() => true),
			register: vi.fn(),
			unregister: vi.fn(),
			steer: vi.fn(() => Promise.resolve(true)),
		};
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Old body",
			status: "working" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		} as never);

		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
			taskController: taskController as never,
		});

		await handlers.handleIssueEvent({
			action: "edited",
			issue: { number: 56, title: "New title", body: "New body", labels: [{ name: "yolomatic-working" }], assignees: [{ login: "yolomatic-bot" }] },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(taskController.isActive).toHaveBeenCalledWith("mbrooks/yolomatic#56");
		expect(taskController.steer).toHaveBeenCalledWith("mbrooks/yolomatic#56", "New body");
		expect(sessionManager.updateStatus).not.toHaveBeenCalled();
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({ body: "Issue description updated. Steering to Yolomatic." }),
		);
	});

	it("updates session body on edited issue when not active", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const taskController = {
			cancel: vi.fn(() => false),
			isActive: vi.fn(() => false),
			register: vi.fn(),
			unregister: vi.fn(),
			steer: vi.fn(() => Promise.resolve(false)),
		};
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Old body",
			status: "waiting-feedback" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		} as never);

		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
			taskController: taskController as never,
		});

		await handlers.handleIssueEvent({
			action: "edited",
			issue: { number: 56, title: "New title", body: "New body", labels: [{ name: "yolomatic-working" }], assignees: [{ login: "yolomatic-bot" }] },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(taskController.isActive).toHaveBeenCalledWith("mbrooks/yolomatic#56");
		expect(taskController.steer).not.toHaveBeenCalled();
		expect(sessionManager.updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			56,
			"waiting-feedback",
			expect.objectContaining({ body: "New body", title: "New title" }),
		);
	});

	it("ignores comment on paused session", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 57,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "paused" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-57.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-57",
			lastActivity: new Date().toISOString(),
			seeded: true,
		} as never);

		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 57, labels: [{ name: "yolomatic-working" }], assignees: [{ login: "yolomatic-bot" }] },
			comment: { body: "@yolomatic-bot Can you also add tests?", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(executor.execute).not.toHaveBeenCalled();
		expect(sessionManager.updateStatus).not.toHaveBeenCalled();
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({
				body: "Yolomatic is paused on this issue. It will resume when unpaused.",
			}),
		);
	});

	it("ignores edited issue when no session exists", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		sessionManager.getSession.mockResolvedValue(null as never);

		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleIssueEvent({
			action: "edited",
			issue: { number: 56, title: "New title", body: "New body", labels: [{ name: "yolomatic-working" }], assignees: [{ login: "yolomatic-bot" }] },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(executor.execute).not.toHaveBeenCalled();
		expect(sessionManager.updateStatus).not.toHaveBeenCalled();
		expect(octokit.issues.createComment).not.toHaveBeenCalled();
	});

	it("clears in-flight after resumeInterruptedSession completes", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		expect(handlers.isInFlight("mbrooks", "yolomatic", 56)).toBe(false);
		await handlers.resumeInterruptedSession("mbrooks", "yolomatic", 56);
		expect(handlers.isInFlight("mbrooks", "yolomatic", 56)).toBe(false);
	});

	it("considers repos managed when no repositoryStore is provided", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await expect(
			handlers.handleIssueEvent({
				action: "opened",
				issue: { number: 1, title: "T", body: "B", assignees: [{ login: "yolomatic-bot" }] },
				repository: { name: "yolomatic", owner: { login: "mbrooks" } },
				sender: { login: "user" },
			}),
		).resolves.toBeUndefined();
	});

	it("considers only registered repos managed when repositoryStore is provided", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const repositoryStore = {
			getSync: vi.fn((owner: string, repo: string) => (owner === "mbrooks" && repo === "yolomatic" ? { owner, repo } : null)),
		};
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
			repositoryStore: repositoryStore as never,
		});

		await expect(
			handlers.handleIssueEvent({
				action: "opened",
				issue: { number: 1, title: "T", body: "B", assignees: [{ login: "yolomatic-bot" }] },
				repository: { name: "yolomatic", owner: { login: "mbrooks" } },
				sender: { login: "user" },
			}),
		).resolves.toBeUndefined();
		expect(repositoryStore.getSync).toHaveBeenCalledWith("mbrooks", "yolomatic");
	});
});
