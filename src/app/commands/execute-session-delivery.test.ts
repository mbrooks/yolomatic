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
	getPullRequest?: () => Promise<import("../../ports/github-service.js").PullRequestInfo | null>;
	getGitDiff?: () => Promise<string>;
	execute?: () => Promise<ExecutionResult>;
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
		createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/ws", branch: "yolomatic/issue-1", owner: "mbrooks", repo: "yolomatic", issueNumber: 1 })),
		updateDefaultBranchFromOrigin: vi.fn(async () => ({ branch: "main", before: null, after: "sha", updated: true })),
		syncWorktree: vi.fn(async () => undefined),
		removeWorktree: vi.fn(),
		commitAndPush: overrides?.commitAndPush ? vi.fn(overrides.commitAndPush) : vi.fn(async () => true),
		commitAndPushPath: vi.fn(async () => true),
		hasChanges: vi.fn(async () => false),
		getWorktreePath: vi.fn(() => "/tmp/ws"),
		getGitStatus: vi.fn(async () => " M src/main.ts"),
		getGitDiff: overrides?.getGitDiff ? vi.fn(overrides.getGitDiff) : vi.fn(async () => "diff --git a/src/main.ts"),
	};

	const executor = {
		execute: overrides?.execute ? vi.fn(overrides.execute) : vi.fn(async (): Promise<ExecutionResult> => ({
			status: "complete",
			summary: "Rebased and resolved conflicts.",
			rawResponse: "YOLO_STATUS: complete\nRebased and resolved conflicts.",
		})),
		executePRReview: vi.fn(),
	} as unknown as import("../../ports/execution-service.js").ExecutionService;

	const github: GitHubService = {
		getIssue: vi.fn(),
		listPullRequests: vi.fn(async () => []),
		getPullRequest: overrides?.getPullRequest
			? vi.fn(overrides.getPullRequest)
			: vi.fn(async () => ({
				head: { ref: "yolomatic/issue-1", sha: "sha" },
				base: { ref: "main" },
				state: "open",
				merged: false,
				mergeable: true,
				mergeableState: "clean",
				draft: true,
			})),
		updatePullRequestBranch: vi.fn(async () => undefined),
		createPullRequest: overrides?.createPullRequest ? vi.fn(overrides.createPullRequest) : vi.fn(async () => null),
		markPullRequestReadyForReview: vi.fn(async () => undefined),
		createIssue: vi.fn(),
		initializeEmptyRepo: vi.fn(async () => undefined),
		postComment: vi.fn(async () => 1),
		postPRComment: vi.fn(async () => 1),
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
		updateIssueBody: vi.fn(async () => undefined),
		updateIssueTitle: vi.fn(async () => undefined),
		getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
		listAccessibleRepositories: vi.fn(async () => []),
		getRepository: vi.fn(async () => null),
		getCollaboratorPermissionLevel: vi.fn(async () => null),
		isCollaborator: vi.fn(async () => false),
		listIssueComments: vi.fn(async () => []),
	};

	const reporter = {
		handleDeliveryFailure: vi.fn(),
		postFailureComment: vi.fn(),
	} as unknown as ExecuteSessionReporter;

	return { sessions, workspaces, github, reporter, executor };
}

const state: SessionState = {
	owner: "mbrooks",
	repo: "yolomatic",
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
	rawResponse: "YOLO_STATUS: complete\nFixed the parser bug.",
};

describe("ExecuteSessionDelivery", () => {
	it("posts diagnostic comment when commitAndPush returns false", async () => {
		const deps = makeDeps({ commitAndPush: vi.fn(async () => false) });
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("No code changes were necessary."),
		);
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "complete");
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
				return { number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" };
			}),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.github.createPullRequest).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			"Yolomatic: Test title",
			expect.stringContaining("Fixes #1"),
			"yolomatic/issue-1",
			"main",
			true,
		);
		expect(deps.sessions.associatePR).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, 42, "https://github.com/mbrooks/yolomatic/pull/42");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("PR created: https://github.com/mbrooks/yolomatic/pull/42"),
		);
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-pr-created"]);
	});

	it("handles existing PR when createPullRequest throws 'already exists'", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => {
				throw new Error("A pull request already exists for yolomatic/issue-1");
			}),
		});
		(deps.github.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" },
		]);
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.sessions.associatePR).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, 42, "https://github.com/mbrooks/yolomatic/pull/42");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("PR already exists: https://github.com/mbrooks/yolomatic/pull/42"),
		);
	});

	it("returns no-changes when createPullRequest throws 'No commits between'", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => {
				throw new Error("No commits between main and yolomatic/issue-1");
			}),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
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
				return { number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" };
			}),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
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
				return { number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" };
			}),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
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
				return { number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" };
			}),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
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
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.reporter.handleDeliveryFailure).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			state,
			expect.any(Error),
		);
		expect(deps.sessions.updateStatus).not.toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "complete");
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
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.reporter.handleDeliveryFailure).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
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
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("No code changes were necessary."),
		);
	});

	it("reports delivery failure when PR already exists but listPullRequests returns empty", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => {
				throw new Error("A pull request already exists for yolomatic/issue-1");
			}),
		});
		(deps.github.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.reporter.handleDeliveryFailure).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
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
				return { number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" };
			}),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.github.createPullRequest).toHaveBeenCalled();
	});

	it("marks a clean draft PR ready and posts 'Ready for review' without worker iteration", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => ({ number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" })),
			getPullRequest: vi.fn(async () => ({
				head: { ref: "yolomatic/issue-1", sha: "sha" },
				state: "open",
				merged: false,
				mergeable: true,
				mergeableState: "clean",
				draft: true,
			})),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
			mergeabilityPollDelayMs: 0,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.github.markPullRequestReadyForReview).toHaveBeenCalledWith("mbrooks", "yolomatic", 42);
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-pr-created"]);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Ready for review."),
		);
		expect(deps.executor.execute).not.toHaveBeenCalled();
	});

	it("polls a null mergeable response before deciding the PR is clean", async () => {
		const calls: (boolean | null)[] = [null, null, true];
		let i = 0;
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => ({ number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" })),
			getPullRequest: vi.fn(async () => ({
				head: { ref: "yolomatic/issue-1", sha: "sha" },
				state: "open",
				merged: false,
				mergeable: calls[Math.min(i++, calls.length - 1)],
				mergeableState: "clean",
				draft: true,
			})),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
			mergeabilityPollDelayMs: 0,
			mergeabilityPollMaxAttempts: 10,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.github.getPullRequest).toHaveBeenCalledTimes(3);
		expect(deps.github.markPullRequestReadyForReview).toHaveBeenCalledWith("mbrooks", "yolomatic", 42);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Ready for review."),
		);
	});

	it("launches a rework iteration, re-pushes, and re-checks when mergeable is false", async () => {
		const calls: (boolean | null)[] = [false, true];
		let i = 0;
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => ({ number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" })),
			getPullRequest: vi.fn(async () => ({
				head: { ref: "yolomatic/issue-1", sha: "sha" },
				state: "open",
				merged: false,
				mergeable: calls[Math.min(i++, calls.length - 1)],
				mergeableState: calls[Math.min(i - 1, calls.length - 1)] === false ? "dirty" : "clean",
				draft: true,
			})),
			execute: vi.fn(async (): Promise<ExecutionResult> => ({
				status: "complete",
				summary: "Rebased onto main.",
				rawResponse: "YOLO_STATUS: complete\nRebased onto main.",
			})),
		});
		(deps.workspaces.commitAndPushPath as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
			mergeabilityPollDelayMs: 0,
			maxConflictAttempts: 2,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.executor.execute).toHaveBeenCalledWith(state, expect.stringContaining("git rebase origin/main"));
		expect(deps.workspaces.commitAndPushPath).toHaveBeenCalled();
		expect(deps.github.markPullRequestReadyForReview).toHaveBeenCalledWith("mbrooks", "yolomatic", 42);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Ready for review."),
		);
	});

	it("fails delivery and leaves the PR a draft after two conflicting attempts", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => ({ number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" })),
			getPullRequest: vi.fn(async () => ({
				head: { ref: "yolomatic/issue-1", sha: "sha" },
				state: "open",
				merged: false,
				mergeable: false,
				mergeableState: "dirty",
				draft: true,
			})),
			execute: vi.fn(async (): Promise<ExecutionResult> => ({
				status: "complete",
				summary: "Tried to rebase.",
				rawResponse: "YOLO_STATUS: complete\nTried to rebase.",
			})),
		});
		(deps.workspaces.getGitStatus as ReturnType<typeof vi.fn>).mockResolvedValue("UU src/conflicted.ts");
		(deps.workspaces.commitAndPushPath as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const realReporter = new ExecuteSessionReporter({
			github: deps.github,
			workspaces: deps.workspaces,
			sessions: deps.sessions,
			selfReportEnabled: false,
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: "main",
			reporter: realReporter,
			mergeabilityPollDelayMs: 0,
			maxConflictAttempts: 2,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.executor.execute).toHaveBeenCalledTimes(2);
		expect(deps.github.markPullRequestReadyForReview).not.toHaveBeenCalled();
		expect(deps.github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			42,
			expect.stringContaining("maintainer must resolve"),
		);
		expect(deps.github.postComment).not.toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Ready for review."),
		);
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-working", "yolomatic-delivery-failed"]);
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed");
		expect(deps.sessions.updateStatus).not.toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "complete");
	});

	it("fails delivery when mergeable stays null past the polling window", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => ({ number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" })),
			getPullRequest: vi.fn(async () => ({
				head: { ref: "yolomatic/issue-1", sha: "sha" },
				state: "open",
				merged: false,
				mergeable: null,
				mergeableState: "unknown",
				draft: true,
			})),
		});
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
			mergeabilityPollDelayMs: 0,
			mergeabilityPollMaxAttempts: 3,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.github.markPullRequestReadyForReview).not.toHaveBeenCalled();
		expect(deps.github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			42,
			expect.stringContaining("could not compute mergeability"),
		);
		expect(deps.reporter.handleDeliveryFailure).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			state,
			expect.any(Error),
		);
		expect(deps.github.postComment).not.toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Ready for review."),
		);
		expect(deps.executor.execute).not.toHaveBeenCalled();
	});

	it("fails delivery when the worker rework attempt does not produce a pushable branch", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => ({ number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" })),
			getPullRequest: vi.fn(async () => ({
				head: { ref: "yolomatic/issue-1", sha: "sha" },
				state: "open",
				merged: false,
				mergeable: false,
				mergeableState: "dirty",
				draft: true,
			})),
			execute: vi.fn(async (): Promise<ExecutionResult> => ({
				status: "failed",
				summary: "Could not rebase.",
				rawResponse: "YOLO_STATUS: failed\nCould not rebase.",
			})),
		});
		(deps.workspaces.getGitStatus as ReturnType<typeof vi.fn>).mockResolvedValue("");
		(deps.workspaces.commitAndPushPath as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
			mergeabilityPollDelayMs: 0,
			maxConflictAttempts: 2,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.executor.execute).toHaveBeenCalledTimes(1);
		expect(deps.workspaces.commitAndPushPath).not.toHaveBeenCalled();
		expect(deps.github.markPullRequestReadyForReview).not.toHaveBeenCalled();
		expect(deps.github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			42,
			expect.stringContaining("did not produce a pushable branch"),
		);
		expect(deps.reporter.handleDeliveryFailure).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			state,
			expect.any(Error),
		);
		expect(deps.github.postComment).not.toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Ready for review."),
		);
	});

	it("reuses an existing PR after an ambiguous createPullRequest error without duplicating it", async () => {
		const createCalls: unknown[] = [];
		const deps = makeDeps({
			createPullRequest: vi.fn(async (...args) => {
				createCalls.push(args);
				throw new Error("Not Found - https://docs.github.com/rest");
			}),
		});
		(deps.github.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" },
		]);

		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(createCalls).toHaveLength(1);
		expect(deps.sessions.associatePR).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, 42, "https://github.com/mbrooks/yolomatic/pull/42");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("PR already exists: https://github.com/mbrooks/yolomatic/pull/42"),
		);
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-pr-created"]);
	});

	it("does not reuse an ambiguous multiple-PR match and fails delivery instead", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => {
				throw new Error("Not Found - https://docs.github.com/rest");
			}),
		});
		(deps.github.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" },
			{ number: 43, html_url: "https://github.com/mbrooks/yolomatic/pull/43" },
		]);

		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
		});

		await delivery.deliverCompletion(state, result);

		expect(deps.sessions.associatePR).not.toHaveBeenCalled();
		expect(deps.reporter.handleDeliveryFailure).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			state,
			expect.any(Error),
		);
	});

	it("preserves the PR association when the ready-for-review transition fails after creation", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => ({ number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" })),
			getPullRequest: vi.fn(async () => ({
				head: { ref: "yolomatic/issue-1", sha: "sha" },
				base: { ref: "main" },
				state: "open",
				merged: false,
				mergeable: true,
				mergeableState: "clean",
				draft: true,
			})),
		});
		(deps.github.markPullRequestReadyForReview as ReturnType<typeof vi.fn>) = vi.fn(async () => {
			throw new Error("Not Found - https://docs.github.com/rest");
		}) as never;

		const delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: "main",
			reporter: deps.reporter,
			mergeabilityPollDelayMs: 0,
		});

		await delivery.deliverCompletion(state, result);

		// The PR association must survive the ready-for-review failure so a
		// restart can recover it instead of losing it.
		expect(deps.sessions.associatePR).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, 42, "https://github.com/mbrooks/yolomatic/pull/42");
		expect(deps.reporter.handleDeliveryFailure).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			state,
			expect.any(Error),
		);
	});
});
