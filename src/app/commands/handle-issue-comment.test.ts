import { describe, expect, it, vi } from "vitest";

import { HandleIssueComment } from "./handle-issue-comment.js";

describe("HandleIssueComment", () => {
	function createHandler() {
		const sessions = {
			get: vi.fn(async () => null),
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
			createOrGetWorktree: vi.fn(),
			removeWorktree: vi.fn(),
			commitAndPush: vi.fn(),
			commitAndPushPath: vi.fn(),
			hasChanges: vi.fn(),
			getWorktreePath: vi.fn(),
			getGitStatus: vi.fn(),
			getGitDiff: vi.fn(),
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
				head: { ref: "tars/cron-job-123" },
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
			githubUsername: "tars-bot",
			executor: {
				sessions: sessions as never,
				workspaces: workspaces as never,
				github: github as never,
				tasks: tasks as never,
				clock: { now: () => new Date() } as never,
				defaultBranch: "main",
				githubUsername: "tars-bot",
				selfReportEnabled: false,
				executor: { execute: vi.fn(), executePRReview: vi.fn() } as never,
			},
			prReview: prReview as never,
		});

		return { handler, sessions, github, prReview, tasks };
	}

	it("routes cron PR comments through the stored PR mapping", async () => {
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
			sessionType: "github_issue",
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
					head: { ref: "tars/cron-job-123" },
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
});
