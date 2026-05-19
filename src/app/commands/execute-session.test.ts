import { describe, expect, it, vi } from "vitest";
import { ExecuteSession } from "./execute-session.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { ExecutionService } from "../../ports/execution-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { Clock } from "../../ports/clock.js";
import type { SessionState } from "../../session/store.js";

function makeDeps(overrides?: {
	commitAndPush?: () => Promise<boolean>;
	fileSelfReport?: () => Promise<string>;
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
	} as unknown as SessionRepository;

	const workspaces: WorkspaceService = {
		createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/ws", branch: "tars/issue-1", owner: "mbrooks", repo: "tars", issueNumber: 1 })),
		removeWorktree: vi.fn(),
		commitAndPush: overrides?.commitAndPush ? vi.fn(overrides.commitAndPush) : vi.fn(async () => true),
		hasChanges: vi.fn(async () => false),
		getWorktreePath: vi.fn(() => "/tmp/ws"),
	};

	const executor: ExecutionService = {
		execute: vi.fn(async () => ({ status: "complete" as const, summary: "Done.", rawResponse: "TARS_STATUS: complete\nDone." })),
		executePRReview: vi.fn(async () => ({ status: "complete" as const, summary: "Done.", rawResponse: "TARS_STATUS: complete\nDone." })),
	};

	const github: GitHubService = {
		getIssue: vi.fn(),
		listPullRequests: vi.fn(async () => []),
		getPullRequest: vi.fn(),
		createPullRequest: vi.fn(),
		postComment: vi.fn(),
		postPRComment: vi.fn(),
		addLabels: vi.fn(),
		removeLabel: vi.fn(),
		fileSelfReport: overrides?.fileSelfReport ? vi.fn(overrides.fileSelfReport) : vi.fn(async () => "https://github.com/mbrooks/tars/issues/999"),
		listReviewComments: vi.fn(async () => []),
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
			expect.stringContaining("could not deliver"),
		);
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
});
