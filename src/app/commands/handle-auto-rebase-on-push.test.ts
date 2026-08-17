import { describe, expect, it, vi } from "vitest";

import { HandleAutoRebaseOnPush, type AutoRebasePushPayload } from "./handle-auto-rebase-on-push.js";
import type { SessionState } from "../../session/store.js";
import type { GitHubService, PullRequestInfo } from "../../ports/github-service.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { ExecutionService } from "../../ports/execution-service.js";
import type { TaskControlService, TaskRegistration } from "../../ports/task-control-service.js";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
	return {
		issueNumber: 56,
		repo: "yolomatic",
		owner: "mbrooks",
		title: "Title",
		body: "Body",
		status: "complete",
		sessionPath: "/tmp/sessions/issue-56.jsonl",
		workspacePath: "/tmp/workspaces/.worktrees/issue-56",
		lastActivity: new Date().toISOString(),
		seeded: true,
		branch: "yolomatic/issue-56",
		prNumber: 99,
		prUrl: "https://github.com/mbrooks/yolomatic/pull/99",
		...overrides,
	};
}

const basePayload: AutoRebasePushPayload = {
	source: "webhook",
	owner: "mbrooks",
	repo: "yolomatic",
	ref: "refs/heads/main",
	before: "oldsha",
	after: "newsha",
};

interface CreateHandlerOverrides {
	sessions?: SessionState[];
	getPullRequest?: (owner: string, repo: string, prNumber: number) => Promise<PullRequestInfo | null>;
	listOpenPullRequests?: (owner: string, repo: string) => Promise<number[]>;
	getGitStatus?: () => Promise<string>;
	execute?: () => Promise<import("../../executor/index.js").ExecutionResult>;
	isDraining?: () => boolean;
	register?: () => TaskRegistration | null;
	isActive?: (key: string) => boolean;
}

function createHandler(overrides: CreateHandlerOverrides = {}) {
	const sessionsList = overrides.sessions ?? [makeSession()];
	const sessions = {
		get: vi.fn(async (_o: string, _r: string, issueNumber: number) =>
			sessionsList.find((s) => s.issueNumber === issueNumber) ?? null,
		),
		getAll: vi.fn(async () => sessionsList),
		save: vi.fn(async (s: SessionState) => s),
		delete: vi.fn(),
		archive: vi.fn(),
		createSession: vi.fn(),
		updateStatus: vi.fn(async (_o: string, _r: string, _i: number, status: SessionState["status"]) => ({ ...makeSession(), status }) as SessionState),
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
		createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/ws", branch: "yolomatic/issue-56" })),
		updateDefaultBranchFromOrigin: vi.fn(async () => ({ branch: "main", before: null, after: "sha", updated: true })),
		syncWorktree: vi.fn(),
		removeWorktree: vi.fn(),
		createRefinementWorktree: vi.fn(),
		removeRefinementWorktree: vi.fn(),
		commitAndPush: vi.fn(async () => true),
		commitAndPushPath: vi.fn(async () => true),
		hasChanges: vi.fn(async () => false),
		getWorktreePath: vi.fn(() => "/tmp/ws"),
		getGitStatus: overrides.getGitStatus ? vi.fn(overrides.getGitStatus) : vi.fn(async () => ""),
		getGitDiff: vi.fn(async () => ""),
	};

	const executor = {
		execute: overrides.execute ? vi.fn(overrides.execute) : vi.fn(async () => ({ status: "complete" as const, summary: "Rebased.", rawResponse: "YOLO_STATUS: complete\nRebased." })),
		executePRReview: vi.fn(),
	};

	const github = {
		postComment: vi.fn(async () => 1),
		postPRComment: vi.fn(async () => 1),
		addLabels: vi.fn(),
		removeLabel: vi.fn(),
		getPullRequest: overrides.getPullRequest
			? vi.fn(overrides.getPullRequest)
			: vi.fn(async (_o: string, _r: string, _pr: number): Promise<PullRequestInfo | null> => ({
					head: { ref: "yolomatic/issue-56", sha: "sha" },
					base: { ref: "main" },
					state: "open",
					merged: false,
					mergeable: true as boolean | null,
					mergeableState: "clean",
					draft: false,
				})),
		updatePullRequestBranch: vi.fn(),
		createPullRequest: vi.fn(),
		markPullRequestReadyForReview: vi.fn(),
		listOpenPullRequests: overrides.listOpenPullRequests
			? vi.fn(overrides.listOpenPullRequests)
			: vi.fn(async () =>
					sessionsList
						.map((s) => s.prNumber)
						.filter((n): n is number => n !== undefined),
			 ),
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
		updateIssueTitle: vi.fn(),
		getIssue: vi.fn(),
		getAuthenticatedUser: vi.fn(),
		listAccessibleRepositories: vi.fn(),
		getRepository: vi.fn(),
		getCollaboratorPermissionLevel: vi.fn(async () => null),
		isCollaborator: vi.fn(async () => true),
		listIssueComments: vi.fn(async () => []),
		listPullRequests: vi.fn(),
	};

	const tasks = {
		cancel: vi.fn(() => false),
		isActive: overrides.isActive ? vi.fn(overrides.isActive) : vi.fn(() => false),
		steer: vi.fn(async () => true),
		register: overrides.register ? vi.fn(overrides.register) : vi.fn((): TaskRegistration | null => Symbol("task") as TaskRegistration),
		unregister: vi.fn(),
		isDraining: overrides.isDraining ? vi.fn(overrides.isDraining) : vi.fn(() => false),
		setDraining: vi.fn(),
	};

	const handler = new HandleAutoRebaseOnPush({
		sessions: sessions as never,
		workspaces: workspaces as never,
		executor: executor as never,
		github: github as never,
		tasks: tasks as never,
		githubUsername: "yolomatic-bot",
		defaultBranch: "main",
		mergeabilityPollDelayMs: 0,
		mergeabilityPollMaxAttempts: 3,
		maxConflictAttempts: 2,
	});

	return { handler, sessions, workspaces, executor, github, tasks };
}

describe("HandleAutoRebaseOnPush", () => {
	it("ignores pushes to a non-default branch without enumerating sessions", async () => {
		const { handler, sessions, github, executor } = createHandler();
		await handler.execute({ ...basePayload, ref: "refs/heads/feature" });
		expect(sessions.getAll).not.toHaveBeenCalled();
		expect(github.postPRComment).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("uses resolveDefaultBranch when provided to decide the default branch", async () => {
		const { sessions, github } = createHandler();
		const custom = new HandleAutoRebaseOnPush({
			sessions: sessions as never,
			workspaces: {} as never,
			executor: {} as never,
			github: github as never,
			tasks: { isActive: () => false, register: () => Symbol("t") as TaskRegistration, unregister: () => {}, isDraining: () => false } as never,
			githubUsername: "yolomatic-bot",
			resolveDefaultBranch: () => "develop",
			mergeabilityPollDelayMs: 0,
			mergeabilityPollMaxAttempts: 3,
			maxConflictAttempts: 2,
		});
		await custom.execute({ ...basePayload, ref: "refs/heads/develop" });
		expect(sessions.getAll).toHaveBeenCalled();
		expect(github.postPRComment).not.toHaveBeenCalled();
	});

	it("skips the whole batch while draining without commenting or running", async () => {
		const { handler, sessions, github, executor, tasks } = createHandler({
			isDraining: () => true,
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56" }, state: "open", merged: false, mergeable: false, mergeableState: "dirty", draft: false }),
		});
		await handler.execute(basePayload);
		expect(sessions.getAll).not.toHaveBeenCalled();
		expect(github.postPRComment).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
		expect(tasks.register).not.toHaveBeenCalled();
	});

	it("does not comment or run for a mergeable Yolomatic PR", async () => {
		const { handler, github, executor, tasks } = createHandler({
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56" }, state: "open", merged: false, mergeable: true, mergeableState: "clean", draft: false }),
		});
		await handler.execute(basePayload);
		expect(github.postPRComment).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
		expect(tasks.register).not.toHaveBeenCalled();
	});

	it("does not comment or run when mergeability is unknown", async () => {
		const { handler, github, executor } = createHandler({
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56" }, state: "open", merged: false, mergeable: null, mergeableState: "unknown", draft: false }),
		});
		await handler.execute(basePayload);
		expect(github.postPRComment).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("posts a start comment, rebases, and reports success for a conflicted PR", async () => {
		const sequence = [
			{ mergeable: false as boolean | null, mergeableState: "dirty" },
			{ mergeable: false as boolean | null, mergeableState: "dirty" },
			{ mergeable: false as boolean | null, mergeableState: "dirty" },
			{ mergeable: true as boolean | null, mergeableState: "clean" },
		];
		let i = 0;
		const { handler, github, executor, workspaces, tasks } = createHandler({
			getPullRequest: async () => ({
				head: { ref: "yolomatic/issue-56", sha: "sha" },
				state: "open",
				merged: false,
				mergeable: sequence[Math.min(i, sequence.length - 1)].mergeable,
				mergeableState: sequence[Math.min(i++, sequence.length - 1)].mergeableState,
				draft: false,
			}),
		});
		await handler.execute(basePayload);
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("Automatic conflict resolution"));
		expect(executor.execute).toHaveBeenCalledWith(expect.any(Object), expect.stringContaining("git rebase origin/main"));
		expect(workspaces.commitAndPushPath).toHaveBeenCalled();
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("now mergeable"));
		expect(tasks.unregister).toHaveBeenCalled();
	});

	it("posts a start comment before the worker iteration runs", async () => {
		const order: string[] = [];
		const { handler, github, executor } = createHandler({
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56" }, state: "open", merged: false, mergeable: false, mergeableState: "dirty", draft: false }),
			execute: async () => {
				order.push("execute");
				return { status: "complete" as const, summary: "Rebased.", rawResponse: "YOLO_STATUS: complete\nRebased." };
			},
		});
		github.postPRComment.mockImplementation(async () => {
			order.push("comment");
			return 1;
		});
		await handler.execute(basePayload);
		expect(order.indexOf("comment")).toBeLessThan(order.indexOf("execute"));
	});

	it("reports a failure comment after exhausting rework attempts", async () => {
		const { handler, github, executor, workspaces } = createHandler({
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56" }, state: "open", merged: false, mergeable: false, mergeableState: "dirty", draft: false }),
			getGitStatus: async () => "UU src/conflicted.ts",
		});
		await handler.execute(basePayload);
		expect(executor.execute).toHaveBeenCalledTimes(2);
		expect(workspaces.commitAndPushPath).toHaveBeenCalledTimes(2);
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("could not resolve"));
	});

	it("does not touch a PR whose session is already active", async () => {
		const { handler, github, executor, tasks } = createHandler({
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56" }, state: "open", merged: false, mergeable: false, mergeableState: "dirty", draft: false }),
			isActive: (key: string) => key === "mbrooks/yolomatic#56",
		});
		await handler.execute(basePayload);
		expect(github.postPRComment).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
		expect(tasks.register).not.toHaveBeenCalled();
	});

	it("does not touch a PR when the task key cannot be registered (race)", async () => {
		const { handler, github, executor, tasks } = createHandler({
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56" }, state: "open", merged: false, mergeable: false, mergeableState: "dirty", draft: false }),
			register: () => null,
		});
		await handler.execute(basePayload);
		expect(github.postPRComment).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
		expect(tasks.unregister).not.toHaveBeenCalled();
	});

	it("ignores a PR that is closed or merged", async () => {
		const { handler, github, executor } = createHandler({
			sessions: [makeSession({ prNumber: 99 })],
			listOpenPullRequests: async () => [], // PR #99 is merged/closed => not open
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56" }, state: "closed", merged: true, mergeable: false, mergeableState: "dirty", draft: false }),
		});
		await handler.execute(basePayload);
		expect(github.listOpenPullRequests).toHaveBeenCalledWith("mbrooks", "yolomatic");
		expect(github.getPullRequest).not.toHaveBeenCalled();
		expect(github.postPRComment).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("does not call getPullRequest or emit an ignored line for a merged PR", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const { handler, github, executor } = createHandler({
			sessions: [makeSession({ prNumber: 99 })],
			listOpenPullRequests: async () => [],
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56" }, state: "closed", merged: true, mergeable: false, mergeableState: "dirty", draft: false }),
		});
		await handler.execute(basePayload);
		expect(github.getPullRequest).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
		const output = write.mock.calls.map((c) => String(c[0])).join("");
		expect(output).not.toContain("is merged");
		expect(output).not.toContain("is closed");
		write.mockRestore();
	});

	it("does not call getPullRequest for a closed-but-not-merged PR", async () => {
		const { handler, github, executor } = createHandler({
			sessions: [makeSession({ prNumber: 99 })],
			listOpenPullRequests: async () => [],
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56" }, state: "closed", merged: false, mergeable: false, mergeableState: "dirty", draft: false }),
		});
		await handler.execute(basePayload);
		expect(github.getPullRequest).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
		expect(github.postPRComment).not.toHaveBeenCalled();
	});

	it("calls listOpenPullRequests once per push for the pushed repository", async () => {
		const { handler, github } = createHandler({
			sessions: [makeSession({ prNumber: 99 })],
			listOpenPullRequests: async () => [99],
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56" }, state: "open", merged: false, mergeable: true, mergeableState: "clean", draft: false }),
		});
		await handler.execute(basePayload);
		expect(github.listOpenPullRequests).toHaveBeenCalledTimes(1);
		expect(github.listOpenPullRequests).toHaveBeenCalledWith("mbrooks", "yolomatic");
	});

	it("processes only the open conflicting PR when mixing one merged and one open", async () => {
		const s1 = makeSession({ issueNumber: 56, prNumber: 99, branch: "yolomatic/issue-56" });
		const s2 = makeSession({ issueNumber: 57, prNumber: 100, branch: "yolomatic/issue-57" });
		const prByNumber: Record<number, PullRequestInfo> = {
			100: { head: { ref: "yolomatic/issue-57" }, state: "open", merged: false, mergeable: false, mergeableState: "dirty", draft: false },
		};
		const getPullRequest = vi.fn(async (_o: string, _r: string, pr: number) => prByNumber[pr] ?? null);
		const { handler, github, executor } = createHandler({
			sessions: [s1, s2],
			listOpenPullRequests: async () => [100], // #99 merged, #100 open
			getPullRequest,
			execute: async () => ({ status: "failed" as const, summary: "stuck", rawResponse: "YOLO_STATUS: failed\nstuck." }),
		});
		await handler.execute(basePayload);
		expect(github.getPullRequest).not.toHaveBeenCalledWith("mbrooks", "yolomatic", 99);
		expect(github.getPullRequest).toHaveBeenCalledWith("mbrooks", "yolomatic", 100);
		expect(github.postPRComment).not.toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.anything());
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 100, expect.stringContaining("Automatic conflict resolution"));
		expect(executor.execute).toHaveBeenCalled();
	});

	it("ignores a PR whose head branch does not match the session invariant", async () => {
		const { handler, github, executor } = createHandler({
			sessions: [makeSession({ issueNumber: 56, prNumber: 99, branch: "yolomatic/issue-56" })],
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-57" }, state: "open", merged: false, mergeable: false, mergeableState: "dirty", draft: false }),
		});
		await handler.execute(basePayload);
		expect(github.postPRComment).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("ignores sessions without a stored PR number", async () => {
		const { handler, github, executor, sessions } = createHandler({
			sessions: [makeSession({ prNumber: undefined, branch: "yolomatic/issue-56" })],
		});
		await handler.execute(basePayload);
		expect(sessions.getAll).toHaveBeenCalled();
		expect(github.getPullRequest).not.toHaveBeenCalled();
		expect(github.postPRComment).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("enumerates a session that has no stored branch field but has a prNumber (production sessions do not persist branch)", async () => {
		// Regression: real sessions are created via createSession/associatePR,
		// which never populate `branch`. Candidate enumeration must not depend on
		// session.branch; the branch invariant is enforced per-PR against the
		// live PR head ref by validatePRSessionMapping.
		const { handler, github, executor } = createHandler({
			sessions: [makeSession({ prNumber: 99, branch: undefined })],
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56" }, state: "open", merged: false, mergeable: false, mergeableState: "dirty", draft: false }),
		});
		await handler.execute(basePayload);
		expect(github.getPullRequest).toHaveBeenCalledWith("mbrooks", "yolomatic", 99);
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("Automatic conflict resolution"));
		expect(executor.execute).toHaveBeenCalled();
	});


	it("only enumerates sessions for the pushed repository", async () => {
		const other = makeSession({ owner: "other", repo: "repo", issueNumber: 7, prNumber: 3, branch: "yolomatic/issue-7" });
		const target = makeSession({ issueNumber: 56, prNumber: 99, branch: "yolomatic/issue-56" });
		const { handler, github } = createHandler({
			sessions: [other, target],
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56" }, state: "open", merged: false, mergeable: true, mergeableState: "clean", draft: false }),
		});
		await handler.execute(basePayload);
		expect(github.getPullRequest).toHaveBeenCalledWith("mbrooks", "yolomatic", 99);
		expect(github.getPullRequest).not.toHaveBeenCalledWith("other", "repo", 3);
	});

	it("processes multiple conflicted PRs in the same push", async () => {
		const s1 = makeSession({ issueNumber: 56, prNumber: 99, branch: "yolomatic/issue-56" });
		const s2 = makeSession({ issueNumber: 57, prNumber: 100, branch: "yolomatic/issue-57" });
		const prByNumber: Record<number, PullRequestInfo> = {
			99: { head: { ref: "yolomatic/issue-56" }, state: "open", merged: false, mergeable: false, mergeableState: "dirty", draft: false },
			100: { head: { ref: "yolomatic/issue-57" }, state: "open", merged: false, mergeable: false, mergeableState: "dirty", draft: false },
		};
		const { handler, github, executor } = createHandler({
			sessions: [s1, s2],
			getPullRequest: async (_o, _r, pr) => prByNumber[pr] ?? null,
			execute: async () => {
				// Force both PRs to stay conflicted so each exhausts attempts.
				return { status: "failed" as const, summary: "stuck", rawResponse: "YOLO_STATUS: failed\nstuck." };
			},
		});
		await handler.execute(basePayload);
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("Automatic conflict resolution"));
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 100, expect.stringContaining("Automatic conflict resolution"));
		expect(executor.execute).toHaveBeenCalled();
	});

	it("continues processing remaining PRs when one candidate throws", async () => {
		const s1 = makeSession({ issueNumber: 56, prNumber: 99, branch: "yolomatic/issue-56" });
		const s2 = makeSession({ issueNumber: 57, prNumber: 100, branch: "yolomatic/issue-57" });
		let calls = 0;
		const { handler, github, executor } = createHandler({
			sessions: [s1, s2],
			getPullRequest: async (_o, _r, pr) => {
				calls += 1;
				if (pr === 99) throw new Error("boom");
				return { head: { ref: "yolomatic/issue-57" }, state: "open", merged: false, mergeable: true, mergeableState: "clean", draft: false };
			},
		});
		await handler.execute(basePayload);
		// The first candidate threw during getPullRequest; the second is still visited.
		expect(calls).toBeGreaterThanOrEqual(2);
		expect(executor.execute).not.toHaveBeenCalled();
		// No start comment for the throwing candidate.
		expect(github.postPRComment).not.toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.anything());
	});

	it("registers abort and steer callbacks that are safe to invoke as no-ops", async () => {
		const { handler, tasks } = createHandler({
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56" }, state: "open", merged: false, mergeable: false, mergeableState: "dirty", draft: false }),
		});
		let abort: (() => void) | undefined;
		let steer: ((msg: string) => Promise<void>) | undefined;
		(tasks.register as ReturnType<typeof vi.fn>).mockImplementation(
			(_key: unknown, a: () => void, s?: (m: string) => Promise<void>) => {
				abort = a;
				steer = s;
				return Symbol("task") as TaskRegistration;
			},
		);
		await handler.execute(basePayload);
		expect(abort).toBeTypeOf("function");
		expect(steer).toBeTypeOf("function");
		expect(() => abort!()).not.toThrow();
		await expect(steer!("hi")).resolves.toBeUndefined();
		expect(tasks.unregister).toHaveBeenCalled();
	});
});