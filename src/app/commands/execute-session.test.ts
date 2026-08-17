import { describe, expect, it, vi } from "vitest";
import { ExecuteSession } from "./execute-session.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { ExecutionService } from "../../ports/execution-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { Clock } from "../../ports/clock.js";
import type { SessionState } from "../../session/store.js";
import { FatalSystemError } from "../../self-monitor/index.js";

function makeDeps(overrides?: {
	commitAndPush?: () => Promise<boolean>;
	createPullRequest?: () => Promise<{ number: number; html_url: string } | null>;
	fileSelfReport?: () => Promise<string>;
	executor?: ExecutionService;
	sessions?: Partial<SessionRepository>;
}) {
	const sessions: SessionRepository = {
		get: vi.fn(async () => state),
		getAll: vi.fn(async () => []),
		save: vi.fn(async (s) => s),
		delete: vi.fn(),
		archive: vi.fn(),
		createSession: vi.fn(),
		updateStatus: vi.fn(async (_o, _r, _i, status: string, updates?: Partial<SessionState>) => ({ ...state, status, ...updates } as SessionState)),
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
		...overrides?.sessions,
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
		getGitDiff: vi.fn(async () => "diff --git a/src/main.ts"),
	};

	const executor: ExecutionService = overrides?.executor ?? {
		execute: vi.fn(async () => ({ status: "complete" as const, summary: "Done.", rawResponse: "YOLO_STATUS: complete\nDone." })),
		executePRReview: vi.fn(async () => ({ status: "complete" as const, summary: "Done.", rawResponse: "YOLO_STATUS: complete\nDone." })),
	};

	const github: GitHubService = {
		getIssue: vi.fn(),
		listPullRequests: vi.fn(async () => []),
		getPullRequest: vi.fn(async () => ({
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
		listOpenPullRequests: vi.fn(async () => []),
		createIssue: vi.fn(),
		initializeEmptyRepo: vi.fn(async () => undefined),
		postComment: vi.fn(async () => 1),
		postPRComment: vi.fn(async () => 1),
		addLabels: vi.fn(),
		removeLabel: vi.fn(),
		fileSelfReport: overrides?.fileSelfReport ? vi.fn(overrides.fileSelfReport) : vi.fn(async () => "https://github.com/mbrooks/yolomatic/issues/999"),
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

	const tasks: TaskControlService = {
		cancel: vi.fn(() => false),
		isActive: vi.fn(() => false),
		steer: vi.fn(async () => false),
		register: vi.fn(() => Symbol("test-task")),
		unregister: vi.fn(),
		isDraining: vi.fn(() => false),
		setDraining: vi.fn(),
	};

	const clock: Clock = { now: () => new Date("2026-01-01T00:00:00Z"), uptime: () => 0 };

	return { sessions, workspaces, executor, github, tasks, clock };
}

const state: SessionState = {
	owner: "mbrooks",
	repo: "yolomatic",
	issueNumber: 1,
	title: "Test",
	body: "Body",
	status: "working",
	sessionPath: "/tmp/session.jsonl",
	workspacePath: "/tmp/ws/.worktrees/issue-1",
	lastActivity: new Date().toISOString(),
	seeded: true,
};

describe("ExecuteSession", () => {
	it("atomically rejects a duplicate execution and steers its feedback to the active task", async () => {
		const deps = makeDeps();
		(deps.tasks.register as ReturnType<typeof vi.fn>).mockReturnValue(null);
		(deps.tasks.steer as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state, "Please retry");

		expect(deps.tasks.steer).toHaveBeenCalledWith("mbrooks/yolomatic#1", "Please retry");
		expect(deps.workspaces.createOrGetWorktree).not.toHaveBeenCalled();
		expect(deps.executor.execute).not.toHaveBeenCalled();
		expect(deps.tasks.unregister).not.toHaveBeenCalled();
	});

	it("classifies PAT scope missing error correctly", async () => {
		const deps = makeDeps({
			commitAndPush: vi.fn(async () => {
				throw new Error(
					"Command failed: git push origin yolomatic/issue-1\n" +
					"To https://github.com/mbrooks/yolomatic.git\n" +
					" ! [remote rejected] yolomatic/issue-1 -> yolomatic/issue-1 (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
				);
			}),
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.fileSelfReport).toHaveBeenCalledWith(
			expect.stringContaining("Yolomatic self-report"),
			expect.stringContaining("github_pat_scope_missing"),
			expect.arrayContaining(["yolomatic-self-report", "bug"]),
		);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Yolomatic delivery failed"),
		);
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-working", "yolomatic-delivery-failed"]);
	});

	it("falls back to git_worktree_failure for other push errors", async () => {
		const deps = makeDeps({
			commitAndPush: vi.fn(async () => {
				throw new Error("fatal: Authentication failed");
			}),
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.fileSelfReport).toHaveBeenCalledWith(
			expect.stringContaining("Yolomatic self-report"),
			expect.stringContaining("git_worktree_failure"),
			expect.arrayContaining(["yolomatic-self-report", "bug"]),
		);
	});

	it("posts diagnostic comment and keeps yolomatic-working when commitAndPush returns false", async () => {
		const deps = makeDeps({
			commitAndPush: vi.fn(async () => false),
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Delivery diagnostics"),
		);
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "complete");
	});

	it("posts 'PR created' comment when a new PR is created", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => ({ number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" })),
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("PR created: https://github.com/mbrooks/yolomatic/pull/42"),
		);
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-pr-created"]);
	});

	it("posts 'PR already exists' comment when PR already exists", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => {
				throw new Error("A pull request already exists for yolomatic/issue-1");
			}),
		});
		(deps.github.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ number: 42, html_url: "https://github.com/mbrooks/yolomatic/pull/42" },
		]);

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("PR already exists: https://github.com/mbrooks/yolomatic/pull/42"),
		);
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-pr-created"]);
	});

	it("includes PAT scope hint in delivery failure comment", async () => {
		const deps = makeDeps({
			commitAndPush: vi.fn(async () => {
				throw new Error(
					"Command failed: git push origin yolomatic/issue-1\n" +
					"To https://github.com/mbrooks/yolomatic.git\n" +
					" ! [remote rejected] yolomatic/issue-1 -> yolomatic/issue-1 (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
				);
			}),
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("missing the `workflow` scope"),
		);
	});

	it("blocks execution with preflight error for bad workspace path", async () => {
		const deps = makeDeps();
		(deps.sessions.get as ReturnType<typeof vi.fn>).mockResolvedValue({
			...state,
			workspacePath: "/tmp/ws/.worktrees/issue-999",
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed", expect.any(Object));
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-failed"]);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Yolomatic stopped before execution"),
		);
		expect(deps.executor.execute).not.toHaveBeenCalled();
	});

	it("handles waiting-feedback status", async () => {
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => ({ status: "waiting-feedback" as const, summary: "Need more info.", rawResponse: "YOLO_STATUS: waiting-feedback\nNeed more info." })),
				executePRReview: vi.fn(),
			},
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "waiting-feedback");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-feedback-required"]);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Need clarification:"),
		);
	});

	it("handles cancelled status", async () => {
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => ({ status: "cancelled" as const, summary: "Stopped.", rawResponse: "YOLO_STATUS: cancelled\nStopped." })),
				executePRReview: vi.fn(),
			},
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "cancelled");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-cancelled"]);
	});

	it("handles working status continuation", async () => {
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => ({ status: "working" as const, summary: "Still going.", rawResponse: "YOLO_STATUS: working\nStill going." })),
				executePRReview: vi.fn(),
			},
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "working");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-working"]);
	});

	it("handles failed status from executor for rate-limit errors", async () => {
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => ({ status: "failed" as const, summary: '429 "you have reached your weekly usage limit..."', rawResponse: "" })),
				executePRReview: vi.fn(),
			},
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-failed"]);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("**Build failed**"),
		);
	});

	it("marks execution-environment blocker responses as failed instead of leaving them working", async () => {
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => ({
					status: "working" as const,
					summary:
						"The bash tool won't execute because the configured working directory (/workspaces/x) doesn't exist on this filesystem. Without a valid cwd, I can't run any bash commands.",
					rawResponse: "",
				})),
				executePRReview: vi.fn(),
			},
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-failed"]);
		expect(deps.github.postComment).not.toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Yolomatic is still working on this issue."),
		);
	});

	it("routes a corrected complete worker result through delivery", async () => {
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => ({
					status: "complete" as const,
					summary: "Fixed the parser bug.",
					rawResponse: "Done. Summary: fixed.\nStatus: complete",
				})),
				executePRReview: vi.fn(),
			},
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.workspaces.commitAndPush).toHaveBeenCalled();
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "complete");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.not.stringContaining("Yolomatic is still working"),
		);
	});

	it("does not deliver when the worker result is an exhausted status-correction failure", async () => {
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => ({
					status: "failed" as const,
					summary:
						"Worker protocol failure: the worker did not return a valid YOLO_STATUS marker after one correction prompt. No work was delivered.",
					rawResponse: "Done.",
				})),
				executePRReview: vi.fn(),
			},
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.workspaces.commitAndPush).not.toHaveBeenCalled();
		expect(deps.github.createPullRequest).not.toHaveBeenCalled();
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-failed"]);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("protocol failure"),
		);
	});

	it("marks seeded when session is not seeded and there is no comment", async () => {
		const deps = makeDeps();
		(deps.sessions.get as ReturnType<typeof vi.fn>).mockResolvedValue({ ...state, seeded: false });
		(deps.sessions.updateStatus as ReturnType<typeof vi.fn>).mockImplementation(async (_o, _r, _i, status: string) => ({ ...state, status, seeded: false } as SessionState));

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.markSeeded).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
	});

	it("does not mark seeded when resuming from comment", async () => {
		const deps = makeDeps();
		(deps.sessions.get as ReturnType<typeof vi.fn>).mockResolvedValue({ ...state, seeded: false });

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state, "human comment");

		expect(deps.sessions.markSeeded).not.toHaveBeenCalled();
	});

	it("suppresses transitions when session is paused post-execution", async () => {
		const deps = makeDeps();
		let callCount = 0;
		(deps.sessions.get as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			callCount++;
			if (callCount === 1) return state;
			return { ...state, status: "paused" };
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).not.toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "complete");
	});

	it("self-reports on fatal system error when enabled", async () => {
		const error = new FatalSystemError({
			toolHistory: [],
			fatalError: { category: "permission_denied", message: "EACCES", toolName: "bash" },
			systemEvidence: {
				whoami: "yolomatic",
				pwd: "/tmp",
				workspacePath: "/tmp/ws",
				lsWorkspace: "",
				gitStatus: "",
				gitDiff: "",
				gitBranch: "main",
				nodeVersion: "v24",
				timestamp: new Date().toISOString(),
			},
		});
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => {
					throw error;
				}),
				executePRReview: vi.fn(),
			},
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.fileSelfReport).toHaveBeenCalled();
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-failed"]);
	});

	it("posts failure comment on fatal system error when self-report is disabled", async () => {
		const error = new FatalSystemError({
			toolHistory: [],
			fatalError: { category: "permission_denied", message: "EACCES", toolName: "bash" },
			systemEvidence: {
				whoami: "yolomatic",
				pwd: "/tmp",
				workspacePath: "/tmp/ws",
				lsWorkspace: "",
				gitStatus: "",
				gitDiff: "",
				gitBranch: "main",
				nodeVersion: "v24",
				timestamp: new Date().toISOString(),
			},
		});
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => {
					throw error;
				}),
				executePRReview: vi.fn(),
			},
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: false,
		});

		await expect(execute.run(state)).rejects.toThrow(error);

		expect(deps.github.fileSelfReport).not.toHaveBeenCalled();
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-failed"]);
	});

	it("rethrows non-fatal execution errors", async () => {
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => {
					throw new Error("executor blew up");
				}),
				executePRReview: vi.fn(),
			},
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await expect(execute.run(state)).rejects.toThrow("executor blew up");
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed");
		expect(deps.tasks.unregister).toHaveBeenCalled();
	});

	it("triggers self-evolution on non-fatal error when enabled", async () => {
		const prev = process.env.YOLO_SELF_EVOLUTION_ENABLED;
		process.env.YOLO_SELF_EVOLUTION_ENABLED = "true";
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => {
					throw new Error("executor blew up");
				}),
				executePRReview: vi.fn(),
			},
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await expect(execute.run(state)).rejects.toThrow("executor blew up");
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed");
		expect(deps.tasks.unregister).toHaveBeenCalled();
		process.env.YOLO_SELF_EVOLUTION_ENABLED = prev;
	});

	it("returns cancelled when abort signal fires during execution", async () => {
		let cancelCallback: (() => void) | undefined;
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => {
					cancelCallback?.();
					throw new Error("aborted");
				}),
				executePRReview: vi.fn(),
			},
		});
		(deps.tasks.register as ReturnType<typeof vi.fn>).mockImplementation((key: string, cancel: () => void) => {
			cancelCallback = cancel;
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.cancelSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-cancelled"]);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Task cancelled by admin"),
		);
		expect(deps.tasks.unregister).toHaveBeenCalled();
	});

	it("validates PR session mapping when PR exists", async () => {
		const deps = makeDeps();
		(deps.sessions.get as ReturnType<typeof vi.fn>).mockResolvedValue({
			...state,
			prNumber: 42,
		});
		(deps.github.getPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
			head: { ref: "yolomatic/issue-2" },
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed", expect.any(Object));
		expect(deps.executor.execute).not.toHaveBeenCalled();
	});

	it("allows execution when PR does not exist", async () => {
		const deps = makeDeps();
		(deps.sessions.get as ReturnType<typeof vi.fn>).mockResolvedValue({
			...state,
			prNumber: 42,
		});
		(deps.github.getPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.executor.execute).toHaveBeenCalled();
	});

	it("fails the session without launching when syncWorktree raises a non-diverged error", async () => {
		const deps = makeDeps();
		(deps.workspaces.syncWorktree as ReturnType<typeof vi.fn>) = vi.fn(async () => {
			throw new Error("credential cleanup failed");
		}) as never;

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.executor.execute).not.toHaveBeenCalled();
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed", expect.objectContaining({ summary: expect.stringContaining("credential cleanup failed") }));
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-failed"]);
		expect(deps.github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, expect.stringContaining("Yolomatic stopped before execution"));
	});

	it("calls updatePullRequestBranch and retries when syncWorktree diverges for a PR session", async () => {
		const deps = makeDeps();
		(deps.sessions.get as ReturnType<typeof vi.fn>).mockResolvedValue({ ...state, prNumber: 42 });
		(deps.github.getPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
			head: { ref: "yolomatic/issue-1", sha: "sha" },
			base: { ref: "main" },
			state: "open",
			merged: false,
			mergeable: true,
			mergeableState: "clean",
			draft: true,
		});
		const { WorktreeBranchDivergedError } = await import("../../workspace/errors.js");
		let syncCalls = 0;
		(deps.workspaces.syncWorktree as ReturnType<typeof vi.fn>) = vi.fn(async () => {
			syncCalls += 1;
			if (syncCalls === 1) throw new WorktreeBranchDivergedError("yolomatic/issue-1", "origin/yolomatic/issue-1");
		}) as never;

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.updatePullRequestBranch).toHaveBeenCalledWith("mbrooks", "yolomatic", 42);
		expect(deps.workspaces.syncWorktree).toHaveBeenCalledTimes(2);
		expect(deps.executor.execute).toHaveBeenCalled();
	});

	it("fails the session when divergence has no associated PR", async () => {
		const deps = makeDeps();
		const { WorktreeBranchDivergedError } = await import("../../workspace/errors.js");
		(deps.workspaces.syncWorktree as ReturnType<typeof vi.fn>) = vi.fn(async () => {
			throw new WorktreeBranchDivergedError("yolomatic/issue-1", "origin/yolomatic/issue-1");
		}) as never;

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.updatePullRequestBranch).not.toHaveBeenCalled();
		expect(deps.executor.execute).not.toHaveBeenCalled();
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed", expect.objectContaining({ summary: expect.stringContaining("diverged") }));
	});

	it("fails the session when update-branch cannot resolve the divergence", async () => {
		const deps = makeDeps();
		(deps.sessions.get as ReturnType<typeof vi.fn>).mockResolvedValue({ ...state, prNumber: 42 });
		(deps.github.getPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
			head: { ref: "yolomatic/issue-1", sha: "sha" },
			base: { ref: "main" },
			state: "open",
			merged: false,
			mergeable: true,
			mergeableState: "clean",
			draft: true,
		});
		const { WorktreeBranchDivergedError } = await import("../../workspace/errors.js");
		(deps.workspaces.syncWorktree as ReturnType<typeof vi.fn>) = vi.fn(async () => {
			throw new WorktreeBranchDivergedError("yolomatic/issue-1", "origin/yolomatic/issue-1");
		}) as never;
		(deps.github.updatePullRequestBranch as ReturnType<typeof vi.fn>) = vi.fn(async () => {
			throw new Error("merge conflict");
		}) as never;

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.updatePullRequestBranch).toHaveBeenCalledWith("mbrooks", "yolomatic", 42);
		expect(deps.executor.execute).not.toHaveBeenCalled();
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed", expect.objectContaining({ summary: expect.stringContaining("merge conflict") }));
	});

	it("discovers a missing PR association on divergence, updates the branch, and launches the worker", async () => {
		const deps = makeDeps();
		(deps.sessions.get as ReturnType<typeof vi.fn>).mockResolvedValue({ ...state, prNumber: undefined });
		(deps.github.getPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
			head: { ref: "yolomatic/issue-1", sha: "sha" },
			base: { ref: "main" },
			state: "open",
			merged: false,
			mergeable: true,
			mergeableState: "clean",
			draft: true,
		});
		(deps.github.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ number: 605, html_url: "https://github.com/mbrooks/yolomatic/pull/605" },
		]);
		const { WorktreeBranchDivergedError } = await import("../../workspace/errors.js");
		let syncCalls = 0;
		(deps.workspaces.syncWorktree as ReturnType<typeof vi.fn>) = vi.fn(async () => {
			syncCalls += 1;
			if (syncCalls === 1) throw new WorktreeBranchDivergedError("yolomatic/issue-1", "origin/yolomatic/issue-1");
		}) as never;

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.listPullRequests).toHaveBeenCalledWith("mbrooks", "yolomatic", {
			head: "mbrooks:yolomatic/issue-1",
			base: "main",
			state: "open",
		});
		expect(deps.sessions.associatePR).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, 605, "https://github.com/mbrooks/yolomatic/pull/605");
		expect(deps.github.updatePullRequestBranch).toHaveBeenCalledWith("mbrooks", "yolomatic", 605);
		expect(deps.workspaces.syncWorktree).toHaveBeenCalledTimes(2);
		expect(deps.executor.execute).toHaveBeenCalled();
	});

	it("clears a stale preserved PR on divergence and discovers a valid replacement PR", async () => {
		const deps = makeDeps();
		(deps.sessions.get as ReturnType<typeof vi.fn>).mockResolvedValue({ ...state, prNumber: 42 });
		(deps.github.getPullRequest as ReturnType<typeof vi.fn>).mockImplementation(async (_o, _r, n) => {
			if (n === 42) {
				return { head: { ref: "yolomatic/issue-1", sha: "sha" }, base: { ref: "develop" }, state: "open", merged: false, draft: true };
			}
			return { head: { ref: "yolomatic/issue-1", sha: "sha" }, base: { ref: "main" }, state: "open", merged: false, draft: true };
		});
		(deps.github.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ number: 605, html_url: "https://github.com/mbrooks/yolomatic/pull/605" },
		]);
		const { WorktreeBranchDivergedError } = await import("../../workspace/errors.js");
		let syncCalls = 0;
		(deps.workspaces.syncWorktree as ReturnType<typeof vi.fn>) = vi.fn(async () => {
			syncCalls += 1;
			if (syncCalls === 1) throw new WorktreeBranchDivergedError("yolomatic/issue-1", "origin/yolomatic/issue-1");
		}) as never;

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		// Stale preserved PR #42 (wrong base) must be cleared before discovery.
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "working", { prNumber: undefined, prUrl: undefined });
		expect(deps.sessions.associatePR).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, 605, "https://github.com/mbrooks/yolomatic/pull/605");
		expect(deps.github.updatePullRequestBranch).toHaveBeenCalledWith("mbrooks", "yolomatic", 605);
		expect(deps.executor.execute).toHaveBeenCalled();
	});

	it("records task execution start and finish timestamps", async () => {
		const deps = makeDeps();
		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			"working",
			expect.objectContaining({
				taskStartedAt: expect.any(String),
				taskFinishedAt: undefined,
			}),
		);
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			"working",
			expect.objectContaining({
				taskFinishedAt: expect.any(String),
				totalExecutionTimeMs: expect.any(Number),
			}),
		);
	});

	it("bumps lastActivity on every model output event", async () => {
		let activityCallback: (() => void) | undefined;
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async (_state, _comment, _signal, _onSessionCreated, onActivity) => {
					activityCallback = onActivity;
					if (onActivity) {
						onActivity();
						onActivity();
					}
					return { status: "complete" as const, summary: "Done.", rawResponse: "YOLO_STATUS: complete\nDone." };
				}),
				executePRReview: vi.fn(),
			},
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(activityCallback).toBeDefined();
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			"working",
			expect.objectContaining({ lastActivity: expect.any(String) }),
		);
		const heartbeatCalls = (deps.sessions.updateStatus as ReturnType<typeof vi.fn>).mock.calls.filter(
			(call: unknown[]) => (call[4] as Partial<SessionState> | undefined)?.lastActivity !== undefined,
		);
		expect(heartbeatCalls.length).toBeGreaterThanOrEqual(2);
	});

	it("records a per-execution metric with runtime, status, and token usage", async () => {
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => ({
					status: "complete" as const,
					summary: "Done.",
					rawResponse: "YOLO_STATUS: complete\nDone.",
					usage: { available: true, input: 100, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 140, cost: 0.8 },
				})),
				executePRReview: vi.fn(),
			},
		});
		const metrics = { record: vi.fn() };
		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
			metrics,
		});

		await execute.run(state);

		expect(metrics.record).toHaveBeenCalledOnce();
		const metric = (metrics.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(metric).toMatchObject({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 1,
			kind: "implementation",
			status: "complete",
		});
		expect(metric.sessionKey).toBe("github-mbrooks-yolomatic-issue-1-implementation");
		expect(typeof metric.durationMs).toBe("number");
		expect(metric.durationMs).toBeGreaterThanOrEqual(0);
		expect(metric.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(metric.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(metric.tokenUsage.available).toBe(true);
		expect(metric.tokenUsage.totalTokens).toBe(140);
	});

	it("records a metric with unavailable token usage when the provider omits usage", async () => {
		const deps = makeDeps();
		const metrics = { record: vi.fn() };
		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
			metrics,
		});

		await execute.run(state);

		const metric = (metrics.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(metric.tokenUsage.available).toBe(false);
		expect(metric.tokenUsage.totalTokens).toBe(0);
	});

	it("records a failed metric when the executor throws", async () => {
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => {
					throw new Error("boom");
				}),
				executePRReview: vi.fn(),
			},
		});
		const metrics = { record: vi.fn() };
		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: false,
			metrics,
		});

		await expect(execute.run(state)).rejects.toThrow("boom");

		expect(metrics.record).toHaveBeenCalledOnce();
		const metric = (metrics.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(metric.status).toBe("failed");
		expect(metric.tokenUsage.available).toBe(false);
	});

	it("does not require a metrics recorder (no-op when omitted)", async () => {
		const deps = makeDeps();
		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await expect(execute.run(state)).resolves.toBeUndefined();
	});

	it("invokes the onSessionCreated callback exposed by the executor", async () => {
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async (s, _comment, _signal, onSessionCreated) => {
					if (typeof onSessionCreated === "function") {
						onSessionCreated({ steer: vi.fn(async () => true) } as never);
					}
					return {
						status: "complete" as const,
						summary: "Done.",
						rawResponse: "YOLO_STATUS: complete\nDone.",
					};
				}),
				executePRReview: vi.fn(),
			},
		});
		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "yolomatic-bot",
			selfReportEnabled: true,
		});

		await expect(execute.run(state)).resolves.toBeUndefined();
		expect((deps.executor.execute as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
	});
});
