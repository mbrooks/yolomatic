import { describe, expect, it, vi } from "vitest";

import { HandleIssueComment, selectPriorContextComments, composeSteerMessage } from "./handle-issue-comment.js";
import { TaskController } from "../../task-controller.js";

describe("HandleIssueComment", () => {
	function createHandler() {
		const sessions = {
			get: vi.fn(async () => ({
				owner: "mbrooks",
				repo: "yolomatic",
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
				repo: "yolomatic",
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
				repo: "yolomatic",
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
			createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/ws/issue-42", branch: "yolomatic/issue-42" })),
			syncWorktree: vi.fn(async () => undefined),
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
			postComment: vi.fn(async () => 1),
			postPRComment: vi.fn(async () => 1),
			addLabels: vi.fn(async () => {}),
			removeLabel: vi.fn(async () => {}),
			getPullRequest: vi.fn(async () => ({
				head: { ref: "yolomatic/custom-branch-123" },
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
			closeIssue: vi.fn(),
			updateIssueBody: vi.fn(),
			listIssueComments: vi.fn(async () => []),
		getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
		listAccessibleRepositories: vi.fn(async () => []),
		};
		const prReview = {
			execute: vi.fn(async () => undefined),
		};
		const fixMergeConflicts = {
			execute: vi.fn(async () => undefined),
		};

		const executorExecute = vi.fn(async () => ({ status: "complete" as const, summary: "Done.", rawResponse: "YOLO_STATUS: complete\nDone." }));
		const executorExecutePRReview = vi.fn();
		const handlerDepsExecutor = {
			sessions: sessions as never,
			workspaces: workspaces as never,
			github: github as never,
			tasks: tasks as never,
			clock: { now: () => new Date() } as never,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: false,
			executor: { execute: executorExecute, executePRReview: executorExecutePRReview } as never,
		};
		const handler = new HandleIssueComment({
			sessions: sessions as never,
			workspaces: workspaces as never,
			tasks: tasks as never,
			github: github as never,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			adminGithubUsername: "admin",
			executor: handlerDepsExecutor,
			prReview: prReview as never,
			fixMergeConflicts: fixMergeConflicts as never,
		});

		return { handler, sessions, github, prReview, fixMergeConflicts, tasks, workspaces, executor: handlerDepsExecutor, executorExecute };
	}

	it("routes a refinement command with trailing text as a steering prompt", async () => {
		const refinement = { execute: vi.fn(async (_payload: unknown, _steering?: string) => undefined) };
		const { sessions, workspaces, tasks, github, executor } = createHandler();
		const handler = new HandleIssueComment({
			sessions: sessions as never,
			workspaces: workspaces as never,
			tasks: tasks as never,
			github: github as never,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			adminGithubUsername: "admin",
			executor,
			refinement: refinement as never,
		});

		await handler.execute({
			action: "created",
			issue: { number: 42, title: "Issue", body: "Body", labels: [{ name: "yolomatic" }], assignee: { login: "yolomatic-bot" } },
			comment: { id: 1, body: "/yolomatic issue-refinement Focus on rollback", user: { login: "admin" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "admin" },
		});

		expect(refinement.execute).toHaveBeenCalledTimes(1);
		const call = refinement.execute.mock.calls[0]!;
		expect(call[0]).toMatchObject({ action: "created", repository: { name: "yolomatic" } });
		expect(call[1]).toBe("Focus on rollback");
	});

	it("routes a no-argument refinement command with an empty steering prompt", async () => {
		const refinement = { execute: vi.fn(async (_payload: unknown, _steering?: string) => undefined) };
		const { sessions, workspaces, tasks, github, executor } = createHandler();
		const handler = new HandleIssueComment({
			sessions: sessions as never,
			workspaces: workspaces as never,
			tasks: tasks as never,
			github: github as never,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			adminGithubUsername: "admin",
			executor,
			refinement: refinement as never,
		});

		await handler.execute({
			action: "created",
			issue: { number: 42, title: "Issue", body: "Body", labels: [{ name: "yolomatic" }], assignee: { login: "yolomatic-bot" } },
			comment: { id: 2, body: "/yolomatic issue-refinement", user: { login: "admin" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "admin" },
		});

		expect(refinement.execute).toHaveBeenCalledTimes(1);
		expect(refinement.execute.mock.calls[0]![1]).toBe("");
	});

	it("does not route embedded refinement commands to the refinement handler", async () => {
		const refinement = { execute: vi.fn(async (_payload: unknown, _steering?: string) => undefined) };
		const { sessions, workspaces, tasks, github, executor } = createHandler();
		const handler = new HandleIssueComment({
			sessions: sessions as never,
			workspaces: workspaces as never,
			tasks: tasks as never,
			github: github as never,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			adminGithubUsername: "admin",
			executor,
			refinement: refinement as never,
		});

		await handler.execute({
			action: "created",
			issue: { number: 42, title: "Issue", body: "Body", labels: [{ name: "yolomatic" }], assignee: { login: "yolomatic-bot" } },
			comment: { id: 3, body: "Please run /yolomatic issue-refinement", user: { login: "admin" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "admin" },
		});

		expect(refinement.execute).not.toHaveBeenCalled();
	});

	it("routes non-issue branch PR comments through the stored PR mapping", async () => {
		const { handler, sessions, github, prReview } = createHandler();
		sessions.findSessionByPR.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "complete",
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
			prNumber: 99,
			prUrl: "https://github.com/mbrooks/yolomatic/pull/99",
		} as never);

		await handler.execute({
			action: "created",
			issue: { number: 99, pull_request: { url: "https://api.github.com/repos/mbrooks/yolomatic/pulls/99" } },
			comment: { id: 1, body: "Please regenerate this", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.getPullRequest).toHaveBeenCalledWith("mbrooks", "yolomatic", 99);
		expect(sessions.findSessionByPR).toHaveBeenCalledWith("mbrooks", "yolomatic", 99);
		expect(prReview.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				pull_request: expect.objectContaining({
					number: 99,
					head: { ref: "yolomatic/custom-branch-123" },
				}),
			}),
		);
		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("routes the /yolomatic fix-merge-conflicts command on a PR to the fixMergeConflicts handler", async () => {
		const { handler, sessions, github, prReview, fixMergeConflicts } = createHandler();
		sessions.findSessionByPR.mockResolvedValue({
			issueNumber: 56,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status: "complete",
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-56.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
			lastActivity: new Date().toISOString(),
			seeded: true,
			prNumber: 99,
			prUrl: "https://github.com/mbrooks/yolomatic/pull/99",
		} as never);

		await handler.execute({
			action: "created",
			issue: { number: 99, pull_request: { url: "https://api.github.com/repos/mbrooks/yolomatic/pulls/99" } },
			comment: { id: 9, body: "/yolomatic fix-merge-conflicts", user: { login: "admin" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "admin" },
		});

		expect(fixMergeConflicts.execute).toHaveBeenCalledWith(
			expect.objectContaining({ owner: "mbrooks", repo: "yolomatic", prNumber: 99, senderLogin: "admin", mappedIssueNumber: 56 }),
		);
		expect(prReview.execute).not.toHaveBeenCalled();
		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("ignores unmapped non-issue PR comments without posting a misleading error", async () => {
		const { handler, sessions, github, prReview } = createHandler();

		await handler.execute({
			action: "created",
			issue: { number: 99, pull_request: { url: "https://api.github.com/repos/mbrooks/yolomatic/pulls/99" } },
			comment: { id: 1, body: "Please regenerate this", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessions.findSessionByPR).toHaveBeenCalledWith("mbrooks", "yolomatic", 99);
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
				labels: [{ name: "yolomatic" }],
				assignee: { login: "yolomatic-bot" },
			},
			comment: { id: 1, body: "@yolomatic-bot Please update", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 42, "Yolomatic is busy. Comment could not be steered.");
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
				labels: [{ name: "yolomatic" }],
				assignee: { login: "yolomatic-bot" },
			},
			comment: { id: 1, body: "@yolomatic-bot Please update", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessions.updateStatus).toHaveBeenCalled();
		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
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
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("ignores comments from the bot itself", async () => {
		const { handler, github } = createHandler();
		await handler.execute({
			action: "created",
			issue: { number: 42, labels: [{ name: "yolomatic" }], assignee: { login: "yolomatic-bot" } },
			comment: { id: 1, body: "hi", user: { login: "yolomatic-bot" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "yolomatic-bot" },
		});

		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("ignores comments from bot accounts", async () => {
		const { handler, github } = createHandler();
		await handler.execute({
			action: "created",
			issue: { number: 42, labels: [{ name: "yolomatic" }], assignee: { login: "yolomatic-bot" } },
			comment: { id: 1, body: "hi", user: { login: "other-bot", type: "Bot" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "other-bot" },
		});

		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("handles admin stop from a non-admin sender", async () => {
		const { handler, github } = createHandler();
		await handler.execute({
			action: "created",
			issue: { number: 42, labels: [{ name: "yolomatic" }], assignee: { login: "yolomatic-bot" } },
			comment: { id: 1, body: "/yolomatic stop", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 42, "Only admins can stop Yolomatic.");
	});

	it("handles admin stop from an admin with an active task", async () => {
		const { handler, github, tasks } = createHandler();
		tasks.cancel.mockReturnValue(true);
		await handler.execute({
			action: "created",
			issue: { number: 42, labels: [{ name: "yolomatic" }], assignee: { login: "yolomatic-bot" } },
			comment: { id: 1, body: "/yolomatic stop", user: { login: "admin" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "admin" },
		});

		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 42, "Stopping Yolomatic...");
	});

	it("ignores comments that do not pass the policy gate", async () => {
		const { handler, github } = createHandler();
		await handler.execute({
			action: "created",
			issue: { number: 42, labels: [], assignee: null, assignees: [], user: { login: "someone" } },
			comment: { id: 1, body: "hello world", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
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
				labels: [{ name: "yolomatic" }],
				assignee: { login: "yolomatic-bot" },
				assignees: [{ login: "yolomatic-bot" }],
				user: { login: "yolomatic-bot" },
			},
			comment: { id: 1, body: "@yolomatic-bot please continue", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
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
			issue: { number: 42, labels: [], assignee: { login: "yolomatic-bot" }, assignees: [{ login: "yolomatic-bot" }] },
			comment: { id: 1, body: "@yolomatic-bot please help", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 42, ["yolomatic"]);
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 42, "Steering comment received.");
	});

	it("ignores comments on issues created by Yolomatic when Yolomatic is not assigned", async () => {
		const { handler, github, sessions } = createHandler();
		await handler.execute({
			action: "created",
			issue: {
				number: 42,
				labels: [{ name: "yolomatic" }],
				assignee: { login: "other-user" },
				assignees: [{ login: "other-user" }],
				user: { login: "yolomatic-bot" },
			},
			comment: { id: 1, body: "@yolomatic-bot following up", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(sessions.get).not.toHaveBeenCalled();
		expect(github.addLabels).not.toHaveBeenCalled();
		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("posts a paused message when the session is paused", async () => {
		const { handler, github, sessions } = createHandler();
		sessions.get.mockResolvedValue({ status: "paused", owner: "mbrooks", repo: "yolomatic", issueNumber: 42, workspacePath: "/tmp/ws/issue-42" } as never);
		await handler.execute({
			action: "created",
			issue: { number: 42, labels: [{ name: "yolomatic" }], assignee: { login: "yolomatic-bot" } },
			comment: { id: 1, body: "@yolomatic-bot please update", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			42,
			"Yolomatic is paused on this issue. It will resume when unpaused.",
		);
	});

	it("starts execution for an accepted comment on a pending session", async () => {
		const { handler, github } = createHandler();
		await handler.execute({
			action: "created",
			issue: { number: 42, labels: [{ name: "yolomatic" }], assignee: { login: "yolomatic-bot" } },
			comment: { id: 1, body: "@yolomatic-bot please update", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			42,
			"Feedback received. Resuming work.",
		);
	});

	it("returns early when a PR comment cannot fetch the PR", async () => {
		const { handler, github, prReview } = createHandler();
		github.getPullRequest.mockResolvedValue(null as never);
		await handler.execute({
			action: "created",
			issue: { number: 99, pull_request: { url: "https://api.github.com/repos/mbrooks/yolomatic/pulls/99" } },
			comment: { id: 1, body: "please update", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(prReview.execute).not.toHaveBeenCalled();
	});

	it("routes a PR timeline stop command to the mapped issue", async () => {
		const { handler, github, tasks } = createHandler();
		github.getPullRequest.mockResolvedValue({ head: { ref: "yolomatic/issue-42" }, state: "open", merged: false } as never);
		tasks.cancel.mockReturnValue(true);
		await handler.execute({
			action: "created",
			issue: { number: 99, pull_request: { url: "https://api.github.com/repos/mbrooks/yolomatic/pulls/99" } },
			comment: { id: 1, body: "/yolomatic stop", user: { login: "admin" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "admin" },
		});

		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, "Stopping Yolomatic...");
	});

describe("HandleIssueComment feedback gate behavior", () => {
	it("ignores a plain comment on an assigned, labeled issue (label is no longer sufficient)", async () => {
		const { handler, github, tasks, sessions } = createHandler();
		await handler.execute({
			action: "created",
			issue: {
				number: 42,
				title: "Issue",
				body: "Body",
				labels: [{ name: "yolomatic-working" }],
				assignee: { login: "yolomatic-bot" },
				assignees: [{ login: "yolomatic-bot" }],
			},
			comment: { id: 1, body: "just checking in, no trigger", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.postComment).not.toHaveBeenCalled();
		expect(tasks.steer).not.toHaveBeenCalled();
		expect(sessions.get).not.toHaveBeenCalled();
		expect(github.addLabels).not.toHaveBeenCalled();
	});

	it("accepts a /yolomatic feedback command on an assigned issue and starts execution", async () => {
		const { handler, github } = createHandler();
		await handler.execute({
			action: "created",
			issue: {
				number: 42,
				title: "Issue",
				body: "Body",
				labels: [],
				assignee: { login: "yolomatic-bot" },
				assignees: [{ login: "yolomatic-bot" }],
			},
			comment: { id: 1, body: "/yolomatic feedback please rerun the tests", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			42,
			"Feedback received. Resuming work.",
		);
	});

	it("does not auto-add the yolomatic label for a /yolomatic feedback command without a mention", async () => {
		const { handler, github } = createHandler();
		await handler.execute({
			action: "created",
			issue: {
				number: 42,
				title: "Issue",
				body: "Body",
				labels: [],
				assignee: { login: "yolomatic-bot" },
				assignees: [{ login: "yolomatic-bot" }],
			},
			comment: { id: 1, body: "/yolomatic feedback rerun", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.addLabels).not.toHaveBeenCalledWith("mbrooks", "yolomatic", 42, ["yolomatic"]);
	});

	it("ignores a /yolomatic feedback command when the issue is not assigned to Yolomatic", async () => {
		const { handler, github, tasks, sessions } = createHandler();
		await handler.execute({
			action: "created",
			issue: {
				number: 42,
				title: "Issue",
				body: "Body",
				labels: [{ name: "yolomatic" }],
				assignee: { login: "someone-else" },
				assignees: [{ login: "someone-else" }],
			},
			comment: { id: 1, body: "/yolomatic feedback please help", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.postComment).not.toHaveBeenCalled();
		expect(tasks.steer).not.toHaveBeenCalled();
		expect(sessions.get).not.toHaveBeenCalled();
	});
});

describe("HandleIssueComment prior-context inclusion", () => {
	it("fetches prior comments and passes them through to the executor on a new execution", async () => {
		const { handler, github, executorExecute } = createHandler();
		github.listIssueComments.mockResolvedValue([
			{ id: 10, body: "earlier discussion", author: "mbrooks", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", html_url: "u" },
			{ id: 20, body: "@yolomatic-bot please retry", author: "user", created_at: "2026-08-02T00:00:00Z", updated_at: "2026-08-02T00:00:00Z", html_url: "u" },
		] as never);

		await handler.execute({
			action: "created",
			issue: {
				number: 42,
				title: "Issue",
				body: "Body",
				labels: [],
				assignee: { login: "yolomatic-bot" },
				assignees: [{ login: "yolomatic-bot" }],
			},
			comment: { id: 20, body: "@yolomatic-bot please retry", user: { login: "user" }, created_at: "2026-08-02T00:00:00Z" },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.listIssueComments).toHaveBeenCalledWith("mbrooks", "yolomatic", 42);
		expect(executorExecute).toHaveBeenCalledTimes(1);
		const call = (executorExecute.mock.calls[0] as unknown[]);
		// execute(state, comment, abortSignal, onSessionCreated, onActivity, priorComments)
		const priorComments = call[5];
		expect(priorComments).toEqual([{ author: "mbrooks", body: "earlier discussion" }]);
	});

	it("includes prior context in the steer message for an active execution", async () => {
		const { handler, github, tasks } = createHandler();
		tasks.isActive.mockReturnValue(true);
		tasks.steer.mockResolvedValue(true);
		github.listIssueComments.mockResolvedValue([
			{ id: 10, body: "earlier discussion", author: "mbrooks", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", html_url: "u" },
		] as never);

		await handler.execute({
			action: "created",
			issue: {
				number: 42,
				title: "Issue",
				body: "Body",
				labels: [],
				assignee: { login: "yolomatic-bot" },
				assignees: [{ login: "yolomatic-bot" }],
			},
			comment: { id: 20, body: "@yolomatic-bot please retry", user: { login: "user" }, created_at: "2026-08-02T00:00:00Z" },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(tasks.steer).toHaveBeenCalledTimes(1);
		const steeredMessage = tasks.steer.mock.calls[0]![1] as string;
		expect(steeredMessage).toContain("Prior discussion");
		expect(steeredMessage).toContain("@mbrooks:");
		expect(steeredMessage).toContain("earlier discussion");
		expect(steeredMessage).toContain("please retry");
	});

	it("degrades gracefully when listIssueComments throws", async () => {
		const { handler, github, executorExecute } = createHandler();
		github.listIssueComments.mockRejectedValue(new Error("boom") as never);

		await handler.execute({
			action: "created",
			issue: {
				number: 42,
				title: "Issue",
				body: "Body",
				labels: [],
				assignee: { login: "yolomatic-bot" },
				assignees: [{ login: "yolomatic-bot" }],
			},
			comment: { id: 20, body: "@yolomatic-bot please retry", user: { login: "user" }, created_at: "2026-08-02T00:00:00Z" },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			42,
			"Feedback received. Resuming work.",
		);
		expect(executorExecute).toHaveBeenCalledTimes(1);
		const priorComments = (executorExecute.mock.calls[0] as unknown[])[5];
		expect(priorComments).toEqual([]);
	});

	it("degrades gracefully when listIssueComments returns an empty list", async () => {
		const { handler, github, executorExecute } = createHandler();
		github.listIssueComments.mockResolvedValue([] as never);

		await handler.execute({
			action: "created",
			issue: {
				number: 42,
				title: "Issue",
				body: "Body",
				labels: [],
				assignee: { login: "yolomatic-bot" },
				assignees: [{ login: "yolomatic-bot" }],
			},
			comment: { id: 20, body: "@yolomatic-bot please retry", user: { login: "user" }, created_at: "2026-08-02T00:00:00Z" },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(executorExecute).toHaveBeenCalledTimes(1);
		expect((executorExecute.mock.calls[0] as unknown[])[5]).toEqual([]);
	});
});

});

describe("HandleIssueComment prior-context gathering", () => {
	it("selects prior non-trigger, non-Yolomatic comments older than the trigger", () => {
		const comments = [
			{ id: 10, body: "older plain comment", author: "mbrooks", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", html_url: "u" },
			{ id: 20, body: "@yolomatic-bot older trigger", author: "tarsmbrooks", created_at: "2026-08-02T00:00:00Z", updated_at: "2026-08-02T00:00:00Z", html_url: "u" },
			{ id: 30, body: "yolomatic's own comment", author: "yolomatic-bot", created_at: "2026-08-03T00:00:00Z", updated_at: "2026-08-03T00:00:00Z", html_url: "u" },
			{ id: 40, body: "/yolomatic feedback older command trigger", author: "mbrooks", created_at: "2026-08-04T00:00:00Z", updated_at: "2026-08-04T00:00:00Z", html_url: "u" },
		];
		const selected = selectPriorContextComments(
			comments,
			{ id: 50, body: "@yolomatic-bot please retry", created_at: "2026-08-05T00:00:00Z" },
			"yolomatic-bot",
		);
		expect(selected).toEqual([{ author: "mbrooks", body: "older plain comment" }]);
	});

	it("falls back to id ordering when timestamps tie", () => {
		const comments = [
			{ id: 10, body: "same ts, older id", author: "mbrooks", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", html_url: "u" },
			{ id: 20, body: "same ts, newer id (the trigger)", author: "user", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", html_url: "u" },
		];
		const selected = selectPriorContextComments(
			comments,
			{ id: 20, body: "trigger", created_at: "2026-08-01T00:00:00Z" },
			"yolomatic-bot",
		);
		expect(selected).toEqual([{ author: "mbrooks", body: "same ts, older id" }]);
	});

	it("excludes comments with no ordering relation to the trigger", () => {
		const comments = [
			{ id: 10, body: "orphan comment", author: "mbrooks", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", html_url: "u" },
		];
		const selected = selectPriorContextComments(
			comments,
			{ body: "trigger with no id or timestamp" },
			"yolomatic-bot",
		);
		expect(selected).toEqual([]);
	});

	it("composeSteerMessage prepends prior discussion to the trigger body", () => {
		const message = composeSteerMessage("Please retry.", [
			{ author: "mbrooks", body: "Background note" },
		]);
		expect(message).toContain("Prior discussion");
		expect(message).toContain("@mbrooks:");
		expect(message).toContain("Background note");
		expect(message).toContain("Please retry.");
		expect(message.indexOf("Prior discussion")).toBeLessThan(message.indexOf("Please retry."));
	});

	it("composeSteerMessage returns the trigger body unchanged when there is no prior context", () => {
		expect(composeSteerMessage("Please retry.", [])).toBe("Please retry.");
	});
});

describe("HandleIssueComment cancel race", () => {
	it("steers a comment that arrives after Stop while the previous run winds down", async () => {
		// Drive the handler with a real TaskController so the post-cancel
		// wind-down window (cancel frees the key vs. the run's finally) is
		// exercised end-to-end rather than via a stub.
		const controller = new TaskController();
		const steered: string[] = [];
		const registration = controller.register("mbrooks/yolomatic#42", () => {}, async (msg) => {
			steered.push(msg);
		});
		expect(registration).not.toBeNull();

		const sessions = {
			get: vi.fn(async () => ({
				owner: "mbrooks",
				repo: "yolomatic",
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
			getAll: vi.fn(),
			save: vi.fn(),
			delete: vi.fn(),
			archive: vi.fn(),
			createSession: vi.fn(),
			updateStatus: vi.fn(),
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
			createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/ws/issue-42", branch: "yolomatic/issue-42" })),
			syncWorktree: vi.fn(async () => undefined),
			removeWorktree: vi.fn(async () => {}),
			commitAndPush: vi.fn(async () => true),
			commitAndPushPath: vi.fn(async () => true),
			hasChanges: vi.fn(async () => false),
			getWorktreePath: vi.fn(() => "/tmp/ws/issue-42"),
			getGitStatus: vi.fn(async () => ""),
			getGitDiff: vi.fn(async () => ""),
		};
		const github = {
			postComment: vi.fn(async () => 1),
			postPRComment: vi.fn(async () => 1),
			addLabels: vi.fn(async () => {}),
			removeLabel: vi.fn(async () => {}),
			getPullRequest: vi.fn(async () => ({
				head: { ref: "yolomatic/issue-42" },
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
			closeIssue: vi.fn(),
			updateIssueBody: vi.fn(),
			listIssueComments: vi.fn(async () => []),
			getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
			listAccessibleRepositories: vi.fn(async () => []),
		};
		const executorExecute = vi.fn(async () => ({ status: "complete" as const, summary: "Done.", rawResponse: "YOLO_STATUS: complete\nDone." }));
		const handlerDepsExecutor = {
			sessions: sessions as never,
			workspaces: workspaces as never,
			github: github as never,
			tasks: controller as never,
			clock: { now: () => new Date() } as never,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: false,
			executor: { execute: executorExecute, executePRReview: vi.fn() } as never,
		};
		const handler = new HandleIssueComment({
			sessions: sessions as never,
			workspaces: workspaces as never,
			tasks: controller as never,
			github: github as never,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			adminGithubUsername: "admin",
			executor: handlerDepsExecutor,
		});

		// Admin Stop fires the abort but must NOT free the key.
		expect(controller.cancel("mbrooks/yolomatic#42")).toBe(true);
		expect(controller.isActive("mbrooks/yolomatic#42")).toBe(true);

		// A feedback comment arrives in the wind-down window.
		await handler.execute({
			action: "created",
			issue: {
				number: 42,
				labels: [{ name: "yolomatic" }],
				assignee: { login: "yolomatic-bot" },
				assignees: [{ login: "yolomatic-bot" }],
			},
			comment: { id: 1, body: "@yolomatic-bot please update", user: { login: "user" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		// The comment is steered into the winding-down run, not started as a new
		// worker execution.
		expect(executorExecute).not.toHaveBeenCalled();
		expect(steered).toHaveLength(1);
		expect(steered[0]).toContain("please update");
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 42, "Steering comment received.");

		// Once the run's finally block unregisters, the key is released and a
		// later event can claim it again.
		controller.unregister("mbrooks/yolomatic#42", registration!);
		expect(controller.isActive("mbrooks/yolomatic#42")).toBe(false);
	});
});


