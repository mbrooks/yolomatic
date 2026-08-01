import { describe, expect, it, vi } from "vitest";

import { HandleIssueComment } from "./handle-issue-comment.js";

describe("HandleIssueComment", () => {
	function createHandler() {
		const sessions = {
			get: vi.fn(async () => ({
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 42,
				title: "Issue",
				body: "Body",
				status: "pending",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: "/tmp/ws/issue-42",
				lastActivity: new Date().toISOString(),
				seeded: true,
				labels: [],
			})),
			getAll: vi.fn(),
			save: vi.fn(),
			delete: vi.fn(),
			archive: vi.fn(),
			createSession: vi.fn(async () => ({
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 42,
				title: "Issue",
				body: "Body",
				status: "pending",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: "/tmp/ws/issue-42",
				lastActivity: new Date().toISOString(),
				seeded: false,
				labels: [],
			})),
			updateStatus: vi.fn(async () => ({
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 42,
				title: "Issue",
				body: "Body",
				status: "working",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: "/tmp/ws/issue-42",
				lastActivity: new Date().toISOString(),
				seeded: true,
				labels: [],
			})),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
			findSessionByPR: vi.fn(async () => null),
			cancelSession: vi.fn(),
			pauseSession: vi.fn(),
			unpauseSession: vi.fn(),
			restartSession: vi.fn(),
			markComplete: vi.fn(),
			markFailed: vi.fn(),
			markStale: vi.fn(),
		};
		const workspaces = {
			createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/ws/issue-42", branch: "yeetomatic/issue-42" })),
			removeWorktree: vi.fn(async () => {}),
			commitAndPush: vi.fn(async () => true),
			commitAndPushPath: vi.fn(async () => true),
			hasChanges: vi.fn(async () => false),
			getWorktreePath: vi.fn(() => "/tmp/ws/issue-42"),
			getGitStatus: vi.fn(async () => ""),
			getGitDiff: vi.fn(async () => ""),
		};
		const tasks = {
			cancel: vi.fn(() => false),
			isActive: vi.fn(() => false),
			steer: vi.fn(),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		};
		const github = {
			postComment: vi.fn(async () => {}),
			postPRComment: vi.fn(async () => {}),
			addLabels: vi.fn(async () => {}),
			removeLabel: vi.fn(async () => {}),
			getPullRequest: vi.fn(async () => ({
				head: { ref: "yeetomatic/custom-branch-123" },
				state: "open",
				merged: false,
			})),
			createPullRequest: vi.fn(),
			listPullRequests: vi.fn(),
			getIssue: vi.fn(),
			createIssue: vi.fn(),
			initializeEmptyRepo: vi.fn(),
			fileSelfReport: vi.fn(),
			listReviewComments: vi.fn(async () => []),
			listLabels: vi.fn(),
			getIssueTemplates: vi.fn(),
			listRecentCommits: vi.fn(),
			listRelatedIssues: vi.fn(),
			listOpenIssues: vi.fn(),
			listPendingInvitations: vi.fn(),
			acceptInvitation: vi.fn(),
			updateIssueAssignees: vi.fn(),
		getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
		listAccessibleRepositories: vi.fn(async () => []),
		};
		const prReview = {
			execute: vi.fn(async () => undefined),
		};

		const handler = new HandleIssueComment({
			sessions: sessions as never,
			workspaces: workspaces as never,
			tasks: tasks as never,
			github: github as never,
			defaultBranch: "main",
			githubUsername: "yeetomatic-bot",
			adminGithubUsername: "admin",
			executor: {
				sessions: sessions as never,
				workspaces: workspaces as never,
				github: github as never,
				tasks: tasks as never,
				clock: { now: () => new Date() } as never,
				defaultBranch: "main",
				githubUsername: "yeetomatic-bot",
				selfReportEnabled: false,
				executor: { execute: vi.fn(async () => ({ status: "complete" as const, summary: "Done.", rawResponse: "YEETOMATIC_STATUS: complete\nDone." })), executePRReview: vi.fn() } as never,
			},
			prReview: prReview as never,
		});

		return { handler, sessions, github, prReview, tasks };
	}

	it("routes non-issue branch PR comments through the stored PR mapping", async () => {
		const { handler, sessions, github, prReview } = createHandler();
		sessions.findSessionByPR.mockResolvedValue({
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
		} as never);

		await handler.execute({
			action: "created",
			issue: { number: 99, pull_request: { url: "https://api.github.com/repos/mbrooks/tars/pulls/99" } },
			comment: { id: 1, body: "Please regenerate this", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.getPullRequest).toHaveBeenCalledWith("mbrooks", "tars", 99);
		expect(sessions.findSessionByPR).toHaveBeenCalledWith("mbrooks", "tars", 99);
		expect(prReview.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				pull_request: expect.objectContaining({
					number: 99,
					head: { ref: "yeetomatic/custom-branch-123" },
				}),
			}),
		);
		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("ignores unmapped non-issue PR comments without posting a misleading error", async () => {
		const { handler, sessions, github, prReview } = createHandler();

		await handler.execute({
			action: "created",
			issue: { number: 99, pull_request: { url: "https://api.github.com/repos/mbrooks/tars/pulls/99" } },
			comment: { id: 1, body: "Please regenerate this", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessions.findSessionByPR).toHaveBeenCalledWith("mbrooks", "tars", 99);
		expect(prReview.execute).not.toHaveBeenCalled();
		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("posts a busy message when an active session cannot be steered", async () => {
		const { handler, github, tasks } = createHandler();
		tasks.isActive.mockReturnValue(true);
		tasks.steer.mockResolvedValue(false);

		await handler.execute({
			action: "created",
			issue: {
				number: 42,
				title: "Issue",
				body: "Body",
				labels: [{ name: "yeetomatic" }],
				assignee: { login: "yeetomatic-bot" },
			},
			comment: { id: 1, body: "Please update", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "tars", 42, "Yeetomatic is busy. Comment could not be steered.");
	});

	it("queues feedback during draining mode", async () => {
		const { handler, github, sessions, tasks } = createHandler();
		tasks.isDraining.mockReturnValue(true);

		await handler.execute({
			action: "created",
			issue: {
				number: 42,
				title: "Issue",
				body: "Body",
				labels: [{ name: "yeetomatic" }],
				assignee: { login: "yeetomatic-bot" },
			},
			comment: { id: 1, body: "Please update", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessions.updateStatus).toHaveBeenCalled();
		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			42,
			"Deploy in progress. Feedback will be processed after restart.",
		);
	});

	it("ignores non-created comment actions", async () => {
		const { handler, github } = createHandler();
		await handler.execute({
			action: "edited",
			issue: { number: 42 },
			comment: { id: 1, body: "hi", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("ignores comments from the bot itself", async () => {
		const { handler, github } = createHandler();
		await handler.execute({
			action: "created",
			issue: { number: 42, labels: [{ name: "yeetomatic" }], assignee: { login: "yeetomatic-bot" } },
			comment: { id: 1, body: "hi", user: { login: "yeetomatic-bot" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "yeetomatic-bot" },
		});

		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("ignores comments from bot accounts", async () => {
		const { handler, github } = createHandler();
		await handler.execute({
			action: "created",
			issue: { number: 42, labels: [{ name: "yeetomatic" }], assignee: { login: "yeetomatic-bot" } },
			comment: { id: 1, body: "hi", user: { login: "other-bot", type: "Bot" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-bot" },
		});

		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("handles admin stop from a non-admin sender", async () => {
		const { handler, github } = createHandler();
		await handler.execute({
			action: "created",
			issue: { number: 42, labels: [{ name: "yeetomatic" }], assignee: { login: "yeetomatic-bot" } },
			comment: { id: 1, body: "/yeetomatic stop", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "tars", 42, "Only admins can stop Yeetomatic.");
	});

	it("handles admin stop from an admin with an active task", async () => {
		const { handler, github, tasks } = createHandler();
		tasks.cancel.mockReturnValue(true);
		await handler.execute({
			action: "created",
			issue: { number: 42, labels: [{ name: "yeetomatic" }], assignee: { login: "yeetomatic-bot" } },
			comment: { id: 1, body: "/yeetomatic stop", user: { login: "admin" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "admin" },
		});

		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "tars", 42, "Stopping Yeetomatic...");
	});

	it("ignores comments that do not pass the policy gate", async () => {
		const { handler, github } = createHandler();
		await handler.execute({
			action: "created",
			issue: { number: 42, labels: [], assignee: null, assignees: [], user: { login: "someone" } },
			comment: { id: 1, body: "hello world", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("ignores comments on closed issues before preparing a session", async () => {
		const { handler, github, sessions } = createHandler();
		await handler.execute({
			action: "created",
			issue: {
				number: 42,
				state: "closed",
				labels: [{ name: "yeetomatic" }],
				assignee: { login: "yeetomatic-bot" },
				assignees: [{ login: "yeetomatic-bot" }],
				user: { login: "yeetomatic-bot" },
			},
			comment: { id: 1, body: "@yeetomatic-bot please continue", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessions.get).not.toHaveBeenCalled();
		expect(github.addLabels).not.toHaveBeenCalled();
		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("auto-labels mentions and steers active executions", async () => {
		const { handler, github, tasks } = createHandler();
		tasks.isActive.mockReturnValue(true);
		tasks.steer.mockResolvedValue(true);
		await handler.execute({
			action: "created",
			issue: { number: 42, labels: [], assignee: { login: "yeetomatic-bot" }, assignees: [{ login: "yeetomatic-bot" }] },
			comment: { id: 1, body: "@yeetomatic-bot please help", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 42, ["yeetomatic"]);
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "tars", 42, "Steering comment received.");
	});

	it("ignores comments on issues created by Yeetomatic when Yeetomatic is not assigned", async () => {
		const { handler, github, sessions } = createHandler();
		await handler.execute({
			action: "created",
			issue: {
				number: 42,
				labels: [{ name: "yeetomatic" }],
				assignee: { login: "other-user" },
				assignees: [{ login: "other-user" }],
				user: { login: "yeetomatic-bot" },
			},
			comment: { id: 1, body: "@yeetomatic-bot following up", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessions.get).not.toHaveBeenCalled();
		expect(github.addLabels).not.toHaveBeenCalled();
		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("posts a paused message when the session is paused", async () => {
		const { handler, github, sessions } = createHandler();
		sessions.get.mockResolvedValue({ status: "paused", owner: "mbrooks", repo: "tars", issueNumber: 42, workspacePath: "/tmp/ws/issue-42" } as never);
		await handler.execute({
			action: "created",
			issue: { number: 42, labels: [{ name: "yeetomatic" }], assignee: { login: "yeetomatic-bot" } },
			comment: { id: 1, body: "please update", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			42,
			"Yeetomatic is paused on this issue. It will resume when unpaused.",
		);
	});

	it("starts execution for an accepted comment on a pending session", async () => {
		const { handler, github } = createHandler();
		await handler.execute({
			action: "created",
			issue: { number: 42, labels: [{ name: "yeetomatic" }], assignee: { login: "yeetomatic-bot" } },
			comment: { id: 1, body: "please update", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			42,
			"Feedback received. Resuming work.",
		);
	});

	it("returns early when a PR comment cannot fetch the PR", async () => {
		const { handler, github, prReview } = createHandler();
		github.getPullRequest.mockResolvedValue(null as never);
		await handler.execute({
			action: "created",
			issue: { number: 99, pull_request: { url: "https://api.github.com/repos/mbrooks/tars/pulls/99" } },
			comment: { id: 1, body: "please update", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(prReview.execute).not.toHaveBeenCalled();
	});

	it("routes a PR timeline stop command to the mapped issue", async () => {
		const { handler, github, tasks } = createHandler();
		github.getPullRequest.mockResolvedValue({ head: { ref: "yeetomatic/issue-42" }, state: "open", merged: false } as never);
		tasks.cancel.mockReturnValue(true);
		await handler.execute({
			action: "created",
			issue: { number: 99, pull_request: { url: "https://api.github.com/repos/mbrooks/tars/pulls/99" } },
			comment: { id: 1, body: "/yeetomatic stop", user: { login: "admin" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "admin" },
		});

		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "tars", 99, "Stopping Yeetomatic...");
	});
});
