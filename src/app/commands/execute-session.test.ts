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
		...overrides?.sessions,
	} as unknown as SessionRepository;

	const workspaces: WorkspaceService = {
		createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/ws", branch: "tars/issue-1", owner: "mbrooks", repo: "tars", issueNumber: 1 })),
		removeWorktree: vi.fn(),
		commitAndPush: overrides?.commitAndPush ? vi.fn(overrides.commitAndPush) : vi.fn(async () => true),
		hasChanges: vi.fn(async () => false),
		getWorktreePath: vi.fn(() => "/tmp/ws"),
		getGitStatus: vi.fn(async () => " M src/main.ts"),
		getGitDiff: vi.fn(async () => "diff --git a/src/main.ts"),
	};

	const executor: ExecutionService = overrides?.executor ?? {
		execute: vi.fn(async () => ({ status: "complete" as const, summary: "Done.", rawResponse: "TARS_STATUS: complete\nDone." })),
		executePRReview: vi.fn(async () => ({ status: "complete" as const, summary: "Done.", rawResponse: "TARS_STATUS: complete\nDone." })),
	};

	const github: GitHubService = {
		getIssue: vi.fn(),
		listPullRequests: vi.fn(async () => []),
		getPullRequest: vi.fn(),
		createPullRequest: overrides?.createPullRequest ? vi.fn(overrides.createPullRequest) : vi.fn(async () => null),
		createIssue: vi.fn(),
		postComment: vi.fn(),
		postPRComment: vi.fn(),
		addLabels: vi.fn(),
		removeLabel: vi.fn(),
		fileSelfReport: overrides?.fileSelfReport ? vi.fn(overrides.fileSelfReport) : vi.fn(async () => "https://github.com/mbrooks/tars/issues/999"),
		listReviewComments: vi.fn(async () => []),
		listLabels: vi.fn(async () => []),
		getIssueTemplates: vi.fn(async () => []),
		listRecentCommits: vi.fn(async () => []),
		listRelatedIssues: vi.fn(async () => []),
		listOpenIssues: vi.fn(async () => []),
		listPendingInvitations: vi.fn(async () => []),
		acceptInvitation: vi.fn(async () => undefined),
	};

	const tasks: TaskControlService = {
		cancel: vi.fn(() => false),
		isActive: vi.fn(() => false),
		steer: vi.fn(async () => false),
		register: vi.fn(),
		unregister: vi.fn(),
		isDraining: vi.fn(() => false),
		setDraining: vi.fn(),
	};

	const clock: Clock = { now: () => new Date("2026-01-01T00:00:00Z"), uptime: () => 0 };

	return { sessions, workspaces, executor, github, tasks, clock };
}

const state: SessionState = {
	owner: "mbrooks",
	repo: "tars",
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
	it("classifies PAT scope missing error correctly", async () => {
		const deps = makeDeps({
			commitAndPush: vi.fn(async () => {
				throw new Error(
					"Command failed: git push origin tars/issue-1\n" +
					"To https://github.com/mbrooks/tars.git\n" +
					" ! [remote rejected] tars/issue-1 -> tars/issue-1 (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.fileSelfReport).toHaveBeenCalledWith(
			expect.stringContaining("TARS self-report"),
			expect.stringContaining("github_pat_scope_missing"),
			expect.arrayContaining(["tars-self-report", "bug"]),
		);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("TARS delivery failed"),
		);
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 1, ["tars-working", "tars-delivery-failed"]);
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.fileSelfReport).toHaveBeenCalledWith(
			expect.stringContaining("TARS self-report"),
			expect.stringContaining("git_worktree_failure"),
			expect.arrayContaining(["tars-self-report", "bug"]),
		);
	});

	it("posts diagnostic comment and keeps tars-working when commitAndPush returns false", async () => {
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("Delivery diagnostics"),
		);
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "complete");
	});

	it("posts 'PR created' comment when a new PR is created", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => ({ number: 42, html_url: "https://github.com/mbrooks/tars/pull/42" })),
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("PR created: https://github.com/mbrooks/tars/pull/42"),
		);
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 1, ["tars-pr-created"]);
	});

	it("posts 'PR already exists' comment when PR already exists", async () => {
		const deps = makeDeps({
			createPullRequest: vi.fn(async () => {
				throw new Error("A pull request already exists for tars/issue-1");
			}),
		});
		(deps.github.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ number: 42, html_url: "https://github.com/mbrooks/tars/pull/42" },
		]);

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("PR already exists: https://github.com/mbrooks/tars/pull/42"),
		);
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 1, ["tars-pr-created"]);
	});

	it("includes PAT scope hint in delivery failure comment", async () => {
		const deps = makeDeps({
			commitAndPush: vi.fn(async () => {
				throw new Error(
					"Command failed: git push origin tars/issue-1\n" +
					"To https://github.com/mbrooks/tars.git\n" +
					" ! [remote rejected] tars/issue-1 -> tars/issue-1 (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "failed", expect.any(Object));
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 1, ["tars-failed"]);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("TARS stopped before execution"),
		);
		expect(deps.executor.execute).not.toHaveBeenCalled();
	});

	it("handles waiting-feedback status", async () => {
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => ({ status: "waiting-feedback" as const, summary: "Need more info.", rawResponse: "TARS_STATUS: waiting-feedback\nNeed more info." })),
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "waiting-feedback");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 1, ["tars-feedback-required"]);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("Need clarification:"),
		);
	});

	it("handles cancelled status", async () => {
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => ({ status: "cancelled" as const, summary: "Stopped.", rawResponse: "TARS_STATUS: cancelled\nStopped." })),
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "cancelled");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 1, ["tars-cancelled"]);
	});

	it("handles working status continuation", async () => {
		const deps = makeDeps({
			executor: {
				execute: vi.fn(async () => ({ status: "working" as const, summary: "Still going.", rawResponse: "TARS_STATUS: working\nStill going." })),
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "working");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 1, ["tars-working"]);
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "failed");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 1, ["tars-failed"]);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("**Build failed**"),
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.markSeeded).toHaveBeenCalledWith("mbrooks", "tars", 1);
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
			githubUsername: "tars-bot",
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).not.toHaveBeenCalledWith("mbrooks", "tars", 1, "complete");
	});

	it("self-reports on fatal system error when enabled", async () => {
		const error = new FatalSystemError({
			toolHistory: [],
			fatalError: { category: "permission_denied", message: "EACCES", toolName: "bash" },
			systemEvidence: {
				whoami: "tars",
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.github.fileSelfReport).toHaveBeenCalled();
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "failed");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 1, ["tars-failed"]);
	});

	it("posts failure comment on fatal system error when self-report is disabled", async () => {
		const error = new FatalSystemError({
			toolHistory: [],
			fatalError: { category: "permission_denied", message: "EACCES", toolName: "bash" },
			systemEvidence: {
				whoami: "tars",
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
			githubUsername: "tars-bot",
			selfReportEnabled: false,
		});

		await expect(execute.run(state)).rejects.toThrow(error);

		expect(deps.github.fileSelfReport).not.toHaveBeenCalled();
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "failed");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 1, ["tars-failed"]);
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await expect(execute.run(state)).rejects.toThrow("executor blew up");
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "failed");
		expect(deps.tasks.unregister).toHaveBeenCalled();
	});

	it("triggers self-evolution on non-fatal error when enabled", async () => {
		const prev = process.env.TARS_SELF_EVOLUTION_ENABLED;
		process.env.TARS_SELF_EVOLUTION_ENABLED = "true";
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await expect(execute.run(state)).rejects.toThrow("executor blew up");
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "failed");
		expect(deps.tasks.unregister).toHaveBeenCalled();
		process.env.TARS_SELF_EVOLUTION_ENABLED = prev;
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.cancelSession).toHaveBeenCalledWith("mbrooks", "tars", 1);
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 1, ["tars-cancelled"]);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
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
			head: { ref: "tars/issue-2" },
		});

		const execute = new ExecuteSession({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			executor: deps.executor,
			github: deps.github,
			tasks: deps.tasks,
			clock: deps.clock,
			defaultBranch: "main",
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "failed", expect.any(Object));
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
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		await execute.run(state);

		expect(deps.executor.execute).toHaveBeenCalled();
	});
});
