import { describe, expect, it, vi } from "vitest";

import { GitHubIssueHandlers } from "./handlers.js";

describe("GitHubIssueHandlers PR review delegation", () => {
	function createDeps() {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
				createComment: vi.fn(async () => ({})),
			},
			pulls: {
				create: vi.fn(async () => ({ data: { html_url: "https://github.com/mbrooks/tars/pull/99", number: 99 } })),
				listReviewComments: vi.fn(async () => ({ data: [] })),
			},
		};
		const sessionManager = {
			createSession: vi.fn(async () => ({
				issueNumber: 56,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "complete" as never,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			getSession: vi.fn(async () => ({
				issueNumber: 56,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "complete" as never,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			updateStatus: vi.fn(async () => ({
				issueNumber: 56,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "working" as never,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			resumeSession: vi.fn(),
			sessionsDir: "/tmp/sessions",
			store: {} as never,
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
			removeWorktree: vi.fn(),
		};
		const executor = {
			execute: vi.fn(async () => ({
				status: "complete" as never,
				summary: "Fixed.",
				rawResponse: "TARS_STATUS: complete\nFixed.",
			})),
		};
		return { octokit, sessionManager, workspaceManager, executor };
	}

	it("delegates handlePullRequestReviewCommentEvent to PRReviewHandler", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			maxIterations: 3,
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handlePullRequestReviewCommentEvent({
			action: "created",
			pull_request: { number: 99, head: { ref: "tars/issue-56" }, state: "open", merged: false },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			comment: { id: 1, body: "Fix this", user: { login: "user" } },
		});

		expect(sessionManager.getSession).toHaveBeenCalledWith("mbrooks", "tars", 56);
	});

	it("delegates handlePullRequestReviewEvent to PRReviewHandler", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			maxIterations: 3,
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handlePullRequestReviewEvent({
			action: "submitted",
			pull_request: { number: 99, head: { ref: "tars/issue-56" }, state: "open", merged: false },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
			review: { id: 101, body: "LGTM", state: "approved", user: { login: "user" } },
		});

		expect(sessionManager.getSession).toHaveBeenCalledWith("mbrooks", "tars", 56);
	});

	it("throws when runExecution is called without a session", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		sessionManager.getSession.mockResolvedValue(null as never);
		sessionManager.createSession.mockResolvedValue({
			issueNumber: 56,
			repo: "tars",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "pending" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: false,
		} as never);
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			maxIterations: 3,
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await expect(
			handlers.handleIssueEvent({
				action: "opened",
				issue: { number: 56, title: "Test", body: "Body", assignees: [{ login: "tars-bot" }] },
				repository: { name: "tars", owner: { login: "mbrooks" } },
				sender: { login: "user" },
			}),
		).rejects.toThrow("No session for mbrooks/tars#56");
	});

	it("labels working when execution returns working status", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		executor.execute.mockResolvedValue({
			status: "working" as never,
			summary: "Still working.",
			rawResponse: "TARS_STATUS: working\nStill working.",
		});
		sessionManager.getSession.mockResolvedValue({
			issueNumber: 56,
			repo: "tars",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "complete" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		});
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			maxIterations: 3,
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [{ name: "tars-pr-created" }], assignees: [{ login: "tars-bot" }] },
			comment: { body: "Update", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessionManager.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 56, "working");
		expect(octokit.issues.addLabels).toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["tars-working"] }),
		);
	});

	it("ignores issue events when session status is not pending", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		sessionManager.createSession.mockResolvedValue({
			issueNumber: 56,
			repo: "tars",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "complete" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
		});
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			maxIterations: 3,
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleIssueEvent({
			action: "opened",
			issue: { number: 56, title: "Test", body: "Body", assignees: [{ login: "tars-bot" }] },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("does not auto-start when autoStart is disabled", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		sessionManager.createSession.mockResolvedValue({
			issueNumber: 56,
			repo: "tars",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "pending" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: false,
		});
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: false,
			defaultBranch: "main",
			maxIterations: 3,
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleIssueEvent({
			action: "opened",
			issue: { number: 56, title: "Test", body: "Body", assignees: [{ login: "tars-bot" }] },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("ignores unassigned issue comments without a TARS mention", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			maxIterations: 3,
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [], assignees: [] },
			comment: { body: "Just a comment", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessionManager.getSession).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("processes unassigned issue comments with @tars mention", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		sessionManager.getSession.mockResolvedValueOnce(null as never).mockResolvedValue({
			issueNumber: 56,
			repo: "tars",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "pending" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: false,
		} as never);
		sessionManager.createSession.mockResolvedValue({
			issueNumber: 56,
			repo: "tars",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "pending" as never,
			sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: false,
		} as never);
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			maxIterations: 3,
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [], assignees: [] },
			comment: { body: "Hey @tars, help me", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessionManager.createSession).toHaveBeenCalled();
		expect(octokit.issues.addLabels).toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["tars"] }),
		);
		expect(sessionManager.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 56, "working");
		expect(executor.execute).toHaveBeenCalled();
	});

	it("ignores assigned issue comments without a TARS label or mention", async () => {
		const { octokit, sessionManager, workspaceManager, executor } = createDeps();
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			maxIterations: 3,
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 56, labels: [], assignees: [{ login: "tars-bot" }] },
			comment: { body: "Just a comment", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessionManager.getSession).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});
});
