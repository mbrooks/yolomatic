import { describe, expect, it, vi } from "vitest";
import { ExecuteSessionDelivery } from "./execute-session-delivery.js";
import type { ExecutionResult } from "../../executor/index.js";
import type { SessionState } from "../../session/store.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import { ExecuteSessionReporter } from "./execute-session-reporter.js";

function makeDeps(overrides?: {
	commitAndPush?: () => Promise<boolean>;
	createPullRequest?: (owner: string, repo: string, title: string, body: string) => Promise<{ number: number; html_url: string } | null>;
	getGitDiff?: () => Promise<string>;
}) {
	const sessions: SessionRepository = {
		get: vi.fn(async () => state),
		getAll: vi.fn(async () => []),
		save: vi.fn(async (s) => s as SessionState),
		delete: vi.fn(),
		archive: vi.fn(),
		createSession: vi.fn(),
		updateStatus: vi.fn(async (_o, _r, _i, status: string) => ({ ...state, status } as SessionState)),
		markSeeded: vi.fn(),
		associatePR: vi.fn(),
		incrementIterationCount: vi.fn(),
		findSessionByPR: vi.fn(),
		cancelSession: vi.fn(),
		pauseSession: vi.fn(),
		unpauseSession: vi.fn(),
		restartSession: vi.fn(),
		markComplete: vi.fn(),
		markFailed: vi.fn(),
		markStale: vi.fn(),
	} as unknown as SessionRepository;

	const workspaces: WorkspaceService = {
		createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/ws", branch: "yeetomatic/issue-1", owner: "mbrooks", repo: "yeetomatic", issueNumber: 1 })),
		syncWorktree: vi.fn(async () => undefined),
		removeWorktree: vi.fn(),
		commitAndPush: overrides?.commitAndPush ? vi.fn(overrides.commitAndPush) : vi.fn(async () => true),
		commitAndPushPath: vi.fn(async () => true),
		hasChanges: vi.fn(async () => false),
		getWorktreePath: vi.fn(() => "/tmp/ws"),
		getGitStatus: vi.fn(async () => " M src/main.ts"),
		getGitDiff: overrides?.getGitDiff ? vi.fn(overrides.getGitDiff) : vi.fn(async () => "diff --git a/src/main.ts"),
	};

	const github: GitHubService = {
		getIssue: vi.fn(),
		listPullRequests: vi.fn(async () => []),
		getPullRequest: vi.fn(),
		updatePullRequestBranch: vi.fn(async () => undefined),
		createPullRequest: overrides?.createPullRequest ? vi.fn(overrides.createPullRequest) : vi.fn(async () => null),
		createIssue: vi.fn(),
		initializeEmptyRepo: vi.fn(async () => undefined),
		postComment: vi.fn(),
		postPRComment: vi.fn(),
		addLabels: vi.fn(),
		removeLabel: vi.fn(),
		fileSelfReport: vi.fn(),
		listReviewComments: vi.fn(async () => []),
		listLabels: vi.fn(async () => []),
		getIssueTemplates: vi.fn(async () => []),
		listRecentCommits: vi.fn(async () => []),
		listRelatedIssues: vi.fn(async () => []),
		listOpenIssues: vi.fn(async () => []),
		listPendingInvitations: vi.fn(async () => []),
		acceptInvitation: vi.fn(async () => undefined),
		updateIssueAssignees: vi.fn(async () => undefined),
		closeIssue: vi.fn(async () => undefined),
		getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
		listAccessibleRepositories: vi.fn(async () => []),
		getRepository: vi.fn(async () => null),
	};

	const reporter = {
		handleDeliveryFailure: vi.fn(),
		postFailureComment: vi.fn(),
	} as unknown as ExecuteSessionReporter;

	return { sessions, workspaces, github, reporter };
}

const state: SessionState = {
	owner: "mbrooks",
	repo: "yeetomatic",
	issueNumber: 1,
	title: "Test title",
	body: "Test body description",
	status: "working",
	sessionPath: "/tmp/session.jsonl",
	workspacePath: "/tmp/ws/.worktrees/issue-1",
	lastActivity: new Date().toISOString(),
	seeded: true,
};

const result: ExecutionResult = {
	status: "complete",
	summary: "Fixed the parser bug.",
	rawResponse: "YEETOMATIC_STATUS: complete\nFixed the parser bug.",
};

describe("ExecuteSessionDelivery", () => {
	it("posts diagnostic comment when commitAndPush returns false", async () => {
		const deps = makeDeps({ commitAndPush: vi.fn(async () => false) });
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			1,
			expect.stringContaining("No code changes were necessary."),
		);
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "complete");
	});

	it("creates a PR with a thorough description including issue context and diff", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async (o, r, title, body) => {
				expect(body).toContain("Fixes #1");
				expect(body).toContain("## Summary");
				expect(body).toContain("Fixed the parser bug.");
				expect(body).toContain("## Issue Context");
				expect(body).toContain("Test title");
				expect(body).toContain("Test body description");
				expect(body).toContain("## Changes");
				expect(body).toContain("diff --git a/src/main.ts");
				return { number: 42, html_url: "https://github.com/mbrooks/yeetomatic/pull/42" };
			}),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.github.createPullRequest).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			"Yeetomatic: Test title",
			expect.stringContaining("Fixes #1"),
			"yeetomatic/issue-1",
			"main",
		);
		expect(deps.sessions.associatePR).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, 42, "https://github.com/mbrooks/yeetomatic/pull/42");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			1,
			expect.stringContaining("PR created: https://github.com/mbrooks/yeetomatic/pull/42"),
		);
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, ["yeetomatic-pr-created"]);
	});

	it("handles existing PR when createPullRequest throws 'already exists'", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => {
				throw new Error("A pull request already exists for yeetomatic/issue-1");
			}),
		});
		(deps.github.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ number: 42, html_url: "https://github.com/mbrooks/yeetomatic/pull/42" },
		]);
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.sessions.associatePR).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, 42, "https://github.com/mbrooks/yeetomatic/pull/42");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			1,
			expect.stringContaining("PR already exists: https://github.com/mbrooks/yeetomatic/pull/42"),
		);
	});

	it("returns no-changes when createPullRequest throws 'No commits between'", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => {
				throw new Error("No commits between main and yeetomatic/issue-1");
			}),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			1,
			expect.stringContaining("No code changes were necessary."),
		);
	});

	it("truncates long issue body and diff in PR description", async () => {
		const longBody = "a".repeat(3000);
		const longDiff = "d".repeat(6000);
		const deps = makeDeps({
			getGitDiff: vi.fn(async () => longDiff),
			createPullRequest: vi.fn(async (o, r, title, body) => {
				expect(body).toContain("...");
				expect(body).not.toContain("a".repeat(2100));
				expect(body).not.toContain("d".repeat(5100));
				return { number: 42, html_url: "https://github.com/mbrooks/yeetomatic/pull/42" };
			}),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion({ ...state, body: longBody }, result);

		expect(deps.github.createPullRequest).toHaveBeenCalled();
	});

	it("handles missing issue body gracefully", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async (o, r, title, body) => {
				expect(body).toContain("## Issue Context");
				expect(body).toContain("Test title");
				return { number: 42, html_url: "https://github.com/mbrooks/yeetomatic/pull/42" };
			}),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion({ ...state, body: "" }, result);

		expect(deps.github.createPullRequest).toHaveBeenCalled();
	});

	it("handles missing summary gracefully", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async (o, r, title, body) => {
				expect(body).toContain("Fixes #1");
				expect(body).toContain("## Issue Context");
				expect(body).not.toContain("## Summary");
				return { number: 42, html_url: "https://github.com/mbrooks/yeetomatic/pull/42" };
			}),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, { ...result, summary: "" });

		expect(deps.github.createPullRequest).toHaveBeenCalled();
	});

	it("reports delivery failure via reporter on unexpected errors", async () => {
		const deps = makeDeps({
			commitAndPush: vi.fn(async () => {
				throw new Error("git push failed");
			}),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.reporter.handleDeliveryFailure).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			1,
			state,
			expect.any(Error),
		);
		expect(deps.sessions.updateStatus).not.toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "complete");
	});

	it("handles unrecognized createPullRequest errors", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => {
				throw new Error("Network error");
			}),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.reporter.handleDeliveryFailure).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			1,
			state,
			expect.any(Error),
		);
	});

	it("returns no-changes when createPullRequest returns null", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => null),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			1,
			expect.stringContaining("No code changes were necessary."),
		);
	});

	it("reports delivery failure when PR already exists but listPullRequests returns empty", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => {
				throw new Error("A pull request already exists for yeetomatic/issue-1");
			}),
		});
		(deps.github.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.reporter.handleDeliveryFailure).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			1,
			state,
			expect.any(Error),
		);
	});

	it("handles missing git diff gracefully", async () => {
		const deps = makeDeps({
			getGitDiff: vi.fn(async () => ""),
			createPullRequest: vi.fn(async (o, r, title, body) => {
				expect(body).not.toContain("## Changes");
				return { number: 42, html_url: "https://github.com/mbrooks/yeetomatic/pull/42" };
			}),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.github.createPullRequest).toHaveBeenCalled();
	});
});
