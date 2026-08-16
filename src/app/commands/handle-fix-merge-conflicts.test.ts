import { describe, expect, it, vi } from "vitest";

import { HandleFixMergeConflicts, type FixMergeConflictsPayload } from "./handle-fix-merge-conflicts.js";
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

const basePayload: FixMergeConflictsPayload = {
	action: "created",
	owner: "mbrooks",
	repo: "yolomatic",
	prNumber: 99,
	pr: { head: { ref: "yolomatic/issue-56" }, state: "open", merged: false },
	senderLogin: "admin",
	comment: { id: 1, body: "/yolomatic fix-merge-conflicts", user: { login: "admin", type: "User" } },
	mappedIssueNumber: 56,
};

function createHandler(overrides?: {
	adminGithubUsername?: string;
	getPullRequest?: () => Promise<PullRequestInfo | null>;
	getGitStatus?: () => Promise<string>;
	execute?: () => Promise<import("../../executor/index.js").ExecutionResult>;
	isCollaborator?: () => Promise<boolean>;
}) {
	const session = makeSession();
	const sessions = {
		get: vi.fn(async (): Promise<SessionState | null> => session),
		getAll: vi.fn(async () => []),
		save: vi.fn(async (s: SessionState) => s),
		delete: vi.fn(),
		archive: vi.fn(),
		createSession: vi.fn(),
		updateStatus: vi.fn(async (_o: string, _r: string, _i: number, status: SessionState["status"]) => ({ ...session, status }) as SessionState),
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
		getGitStatus: overrides?.getGitStatus ? vi.fn(overrides.getGitStatus) : vi.fn(async () => ""),
		getGitDiff: vi.fn(async () => ""),
	};

	const executor = {
		execute: overrides?.execute ? vi.fn(overrides.execute) : vi.fn(async () => ({ status: "complete" as const, summary: "Rebased.", rawResponse: "YOLO_STATUS: complete\nRebased." })),
		executePRReview: vi.fn(),
	};

	const github = {
		postComment: vi.fn(async () => 1),
		postPRComment: vi.fn(async () => 1),
		addLabels: vi.fn(),
		removeLabel: vi.fn(),
		getPullRequest: overrides?.getPullRequest ? vi.fn(overrides.getPullRequest) : vi.fn(async () => ({
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
		isCollaborator: overrides?.isCollaborator ? vi.fn(overrides.isCollaborator) : vi.fn(async () => true),
		listIssueComments: vi.fn(async () => []),
		listPullRequests: vi.fn(),
	};

	const tasks = {
		cancel: vi.fn(() => false),
		isActive: vi.fn(() => false),
		steer: vi.fn(async () => true),
		register: vi.fn((): TaskRegistration | null => Symbol("task")),
		unregister: vi.fn(),
		isDraining: vi.fn(() => false),
		setDraining: vi.fn(),
	};

	const handler = new HandleFixMergeConflicts({
		sessions: sessions as never,
		workspaces: workspaces as never,
		executor: executor as never,
		github: github as never,
		tasks: tasks as never,
		githubUsername: "yolomatic-bot",
		adminGithubUsername: overrides?.adminGithubUsername ?? "admin",
		mergeabilityPollDelayMs: 0,
		mergeabilityPollMaxAttempts: 3,
		maxConflictAttempts: 2,
	});

	return { handler, sessions, workspaces, executor, github, tasks };
}

describe("HandleFixMergeConflicts", () => {
	it("ignores actions other than created", async () => {
		const { handler, github, executor } = createHandler();
		await handler.execute({ ...basePayload, action: "edited" });
		expect(github.postPRComment).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("ignores comments from the Yolomatic account without posting", async () => {
		const { handler, github, executor } = createHandler();
		await handler.execute({
			...basePayload,
			senderLogin: "yolomatic-bot",
			comment: { id: 2, body: "/yolomatic fix-merge-conflicts", user: { login: "yolomatic-bot", type: "Bot" } },
		});
		expect(github.postPRComment).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("ignores bot senders without posting", async () => {
		const { handler, github, executor } = createHandler();
		await handler.execute({
			...basePayload,
			senderLogin: "dependabot",
			comment: { id: 2, body: "/yolomatic fix-merge-conflicts", user: { login: "dependabot", type: "Bot" } },
		});
		expect(github.postPRComment).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("rejects unauthorized senders with a short PR comment and no worker run", async () => {
		const { handler, github, executor } = createHandler({
			adminGithubUsername: "admin",
			isCollaborator: async () => false,
		});
		await handler.execute({ ...basePayload, senderLogin: "rando" });
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("Only repository collaborators"));
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("authorizes the configured admin username even without a collaborator lookup", async () => {
		const { handler, github, executor } = createHandler({
			adminGithubUsername: "admin",
			isCollaborator: async () => false,
			getPullRequest: async () => ({
				head: { ref: "yolomatic/issue-56", sha: "sha" },
				state: "open",
				merged: false,
				mergeable: true,
				mergeableState: "clean",
				draft: false,
			}),
		});
		await handler.execute({ ...basePayload, senderLogin: "admin" });
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("No conflicts"));
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("posts a short comment and does not run for a closed PR", async () => {
		const { handler, github, executor } = createHandler({
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56", sha: "sha" }, state: "closed", merged: false, mergeable: true, mergeableState: "clean", draft: false }),
		});
		await handler.execute(basePayload);
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("closed"));
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("posts a short comment and does not run for a merged PR", async () => {
		const { handler, github, executor } = createHandler({
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56", sha: "sha" }, state: "closed", merged: true, mergeable: true, mergeableState: "clean", draft: false }),
		});
		await handler.execute(basePayload);
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("merged"));
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("posts a short comment when no session is mapped to the PR", async () => {
		const { handler, github, executor, sessions } = createHandler();
		sessions.get.mockResolvedValue(null);
		await handler.execute({ ...basePayload, mappedIssueNumber: 56 });
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("not associated with a Yolomatic session"));
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("posts a short comment when the PR/branch/session mapping invariant fails", async () => {
		const { handler, github, executor, sessions } = createHandler();
		sessions.get.mockResolvedValue(makeSession({ issueNumber: 56, prNumber: 77 }));
		await handler.execute(basePayload);
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("already associated"));
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("posts a busy comment and does not run when the session is already active", async () => {
		const { handler, github, executor, tasks } = createHandler();
		tasks.isActive.mockReturnValue(true);
		await handler.execute(basePayload);
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("busy"));
		expect(executor.execute).not.toHaveBeenCalled();
		expect(tasks.register).not.toHaveBeenCalled();
	});

	it("posts a no-op comment and does not run when the PR is already mergeable", async () => {
		const { handler, github, executor } = createHandler({
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56", sha: "sha" }, state: "open", merged: false, mergeable: true, mergeableState: "clean", draft: false }),
		});
		await handler.execute(basePayload);
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("No conflicts"));
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("rebases, pushes, and reports success when the PR conflicts with the base branch", async () => {
		const sequence = [
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
		expect(executor.execute).toHaveBeenCalledWith(expect.any(Object), expect.stringContaining("git rebase origin/main"));
		expect(workspaces.commitAndPushPath).toHaveBeenCalled();
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("mergeable"));
		expect(tasks.unregister).toHaveBeenCalled();
	});

	it("reports a failure comment after exhausting rework attempts", async () => {
		const { handler, github, executor, workspaces } = createHandler({
			getPullRequest: async () => ({
				head: { ref: "yolomatic/issue-56", sha: "sha" },
				state: "open",
				merged: false,
				mergeable: false as boolean | null,
				mergeableState: "dirty",
				draft: false,
			}),
			getGitStatus: async () => "UU src/conflicted.ts",
		});
		await handler.execute(basePayload);
		expect(executor.execute).toHaveBeenCalledTimes(2);
		expect(workspaces.commitAndPushPath).toHaveBeenCalledTimes(2);
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("could not resolve"));
	});

	it("reports a failure comment when GitHub cannot compute mergeability", async () => {
		const { handler, github, executor } = createHandler({
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56", sha: "sha" }, state: "open", merged: false, mergeable: null as boolean | null, mergeableState: "unknown", draft: false }),
		});
		await handler.execute(basePayload);
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("mergeability"));
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("marks the PR ready for review when the rework produces a clean draft", async () => {
		const sequence = [
			{ mergeable: false as boolean | null, mergeableState: "dirty" },
			{ mergeable: false as boolean | null, mergeableState: "dirty" },
			{ mergeable: true as boolean | null, mergeableState: "clean" },
		];
		let i = 0;
		const { handler, github } = createHandler({
			getPullRequest: async () => ({
				head: { ref: "yolomatic/issue-56", sha: "sha" },
				state: "open",
				merged: false,
				mergeable: sequence[Math.min(i, sequence.length - 1)].mergeable,
				mergeableState: sequence[Math.min(i++, sequence.length - 1)].mergeableState,
				draft: true,
			}),
		});
		await handler.execute(basePayload);
		expect(github.markPullRequestReadyForReview).toHaveBeenCalledWith("mbrooks", "yolomatic", 99);
	});

	it("posts a draining comment and does not run when the controller is draining", async () => {
		const { handler, github, executor, tasks } = createHandler({
			getPullRequest: async () => ({ head: { ref: "yolomatic/issue-56", sha: "sha" }, state: "open", merged: false, mergeable: false, mergeableState: "dirty", draft: false }),
		});
		tasks.isDraining.mockReturnValue(true);
		await handler.execute(basePayload);
		expect(github.postPRComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, expect.stringContaining("Deploy in progress"));
		expect(executor.execute).not.toHaveBeenCalled();
		expect(tasks.register).not.toHaveBeenCalled();
	});

	it("registers abort and steer callbacks that are safe to invoke as no-ops", async () => {
		const { handler, tasks } = createHandler();
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