import { describe, expect, it, vi } from "vitest";

import { IssueCommentService } from "./comment-service.js";

describe("IssueCommentService pull request timeline comments", () => {
	function createService() {
		const workflow = {
			findSessionByPR: vi.fn(async () => null),
			getSession: vi.fn(),
			createSession: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(),
		};
		const executionService = {
			executeIssue: vi.fn(),
		};
		const github = {
			getPullRequest: vi.fn(async () => ({
				head: { ref: "tars/cron-job-123" },
				state: "open",
				merged: false,
			})),
			createComment: vi.fn(async () => ({})),
			addLabels: vi.fn(async () => ({})),
			removeLabel: vi.fn(async () => undefined),
		};
		const prReviewHandler = {
			handlePullRequestReviewCommentEvent: vi.fn(async () => undefined),
		};
		const adminCommands = {
			handleStopCommand: vi.fn(async () => undefined),
		};

		const service = new IssueCommentService({
			workflow: workflow as never,
			workspaceManager: workspaceManager as never,
			executionService: executionService as never,
			github: github as never,
			prReviewHandler: prReviewHandler as never,
			adminCommands: adminCommands as never,
			githubUsername: "tars-bot",
		});

		return { service, workflow, github, prReviewHandler, adminCommands };
	}

	it("routes cron PR comments through the stored PR mapping", async () => {
		const { service, workflow, github, prReviewHandler } = createService();
		workflow.findSessionByPR.mockResolvedValue({
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

		await service.handleCommentEvent({
			action: "created",
			issue: { number: 99, pull_request: { url: "https://api.github.com/repos/mbrooks/tars/pulls/99" } },
			comment: { id: 1, body: "Please regenerate this", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(workflow.findSessionByPR).toHaveBeenCalledWith("mbrooks", "tars", 99);
		expect(prReviewHandler.handlePullRequestReviewCommentEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				pull_request: expect.objectContaining({
					number: 99,
					head: { ref: "tars/cron-job-123" },
				}),
			}),
		);
		expect(github.createComment).not.toHaveBeenCalled();
	});

	it("ignores non-issue PR comments when no TARS session is associated", async () => {
		const { service, workflow, github, prReviewHandler, adminCommands } = createService();

		await service.handleCommentEvent({
			action: "created",
			issue: { number: 99, pull_request: { url: "https://api.github.com/repos/mbrooks/tars/pulls/99" } },
			comment: { id: 1, body: "/tars stop", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(workflow.findSessionByPR).toHaveBeenCalledWith("mbrooks", "tars", 99);
		expect(adminCommands.handleStopCommand).not.toHaveBeenCalled();
		expect(prReviewHandler.handlePullRequestReviewCommentEvent).not.toHaveBeenCalled();
		expect(github.createComment).not.toHaveBeenCalled();
	});
});
