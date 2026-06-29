import { describe, expect, it, vi } from "vitest";
import { createStartIssueSession, StartIssueSession } from "./start-issue-session.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { ExecutionService } from "../../ports/execution-service.js";
import type { Clock } from "../../ports/clock.js";
import type { SessionState } from "../../session/store.js";

function makeMockRepo(state: SessionState | null = null): SessionRepository {
	let currentState = state;
	return {
		get: vi.fn(async () => currentState),
		getAll: vi.fn(async () => (currentState ? [currentState] : [])),
		save: vi.fn(async (s) => {
			currentState = s;
			return s;
		}),
		delete: vi.fn(),
		archive: vi.fn(),
		createSession: vi.fn(async (_o, _r, _n, title, body, workspacePath, labels) => {
			currentState = {
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 1,
				title,
				body,
				status: "pending",
				sessionPath: "/tmp/session.jsonl",
				workspacePath,
				lastActivity: new Date().toISOString(),
				seeded: false,
				labels: labels ?? [],
			} as SessionState;
			return currentState;
		}),
		updateStatus: vi.fn(async (_o, _r, _n, status, updates) => {
			if (currentState) {
				currentState = { ...currentState, status, ...updates } as SessionState;
			}
			return currentState!;
		}),
		markSeeded: vi.fn(),
		associatePR: vi.fn(),
		incrementIterationCount: vi.fn(),
		findSessionByPR: vi.fn(),
		cancelSession: vi.fn(async () => {
			if (currentState) currentState = { ...currentState, status: "cancelled" } as SessionState;
			return currentState!;
		}),
		pauseSession: vi.fn(),
		unpauseSession: vi.fn(),
		restartSession: vi.fn(),
		markComplete: vi.fn(),
		markFailed: vi.fn(),
		markStale: vi.fn(),
	} as unknown as SessionRepository;
}

function makeState(status: SessionState["status"]): SessionState {
	return {
		owner: "mbrooks",
		repo: "tars",
		issueNumber: 1,
		title: "Test",
		body: "Body",
		status,
		sessionPath: "/tmp/session.jsonl",
		workspacePath: "/tmp/ws",
		lastActivity: new Date().toISOString(),
		seeded: false,
	};
}

function makeCommand(
	state: SessionState | null,
	overrides?: Partial<{
		tasks: TaskControlService;
		github: GitHubService;
		executor: ExecutionService;
	}>,
) {
	const repo = makeMockRepo(state);
	const workspaces: WorkspaceService = {
		createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/ws/issue-1", branch: "tars/issue-1" })),
		removeWorktree: vi.fn(),
		commitAndPush: vi.fn(),
		commitAndPushPath: vi.fn(),
		hasChanges: vi.fn(async () => false),
		getWorktreePath: vi.fn(() => "/tmp/ws/issue-1"),
		getGitStatus: vi.fn(async () => ""),
		getGitDiff: vi.fn(async () => ""),
	};
	const github: GitHubService = overrides?.github ?? {
		postComment: vi.fn(),
		postPRComment: vi.fn(),
		addLabels: vi.fn(),
		removeLabel: vi.fn(),
		getPullRequest: vi.fn(async () => null),
		createPullRequest: vi.fn(async () => null),
		listPullRequests: vi.fn(async () => []),
		getIssue: vi.fn(async () => null),
		createIssue: vi.fn(async () => ({ number: 1, html_url: "" })),
		initializeEmptyRepo: vi.fn(),
		fileSelfReport: vi.fn(async () => ""),
		listReviewComments: vi.fn(async () => []),
		listLabels: vi.fn(async () => []),
		getIssueTemplates: vi.fn(async () => []),
		listRecentCommits: vi.fn(async () => []),
		listRelatedIssues: vi.fn(async () => []),
		listOpenIssues: vi.fn(async () => []),
		listPendingInvitations: vi.fn(async () => []),
		acceptInvitation: vi.fn(),
		updateIssueAssignees: vi.fn(),
		closeIssue: vi.fn(),
		getAuthenticatedUser: vi.fn(async () => ({ login: "tars-bot" })),
		listAccessibleRepositories: vi.fn(async () => []),
		getRepository: vi.fn(async () => null),
	};
	const tasks: TaskControlService = overrides?.tasks ?? {
		cancel: vi.fn(() => false),
		isActive: vi.fn(() => false),
		steer: vi.fn(async () => false),
		register: vi.fn(),
		unregister: vi.fn(),
		isDraining: vi.fn(() => false),
		setDraining: vi.fn(),
	};
	const executor: ExecutionService = overrides?.executor ?? {
		execute: vi.fn(async () => ({ status: "complete" as const, summary: "done", rawResponse: "" })),
		executePRReview: vi.fn(),
	};
	const clock: Clock = { now: () => new Date("2026-01-01T00:00:00Z"), uptime: () => 0 };
	const command = new StartIssueSession(
		repo,
		workspaces,
		github,
		tasks,
		executor,
		clock,
		"main",
		"tars-bot",
		true,
	);
	return { command, repo, workspaces, github, tasks, executor };
}

describe("StartIssueSession", () => {
	it("builds the command from a shared factory", () => {
		const repo = makeMockRepo(null);
		const workspaces = {
			createOrGetWorktree: vi.fn(),
			removeWorktree: vi.fn(),
			commitAndPush: vi.fn(),
			commitAndPushPath: vi.fn(),
			hasChanges: vi.fn(),
			getWorktreePath: vi.fn(),
			getGitStatus: vi.fn(),
			getGitDiff: vi.fn(),
		} as unknown as WorkspaceService;
		const github = { updateIssueAssignees: vi.fn() } as unknown as GitHubService;
		const tasks = { isActive: vi.fn(() => false) } as unknown as TaskControlService;
		const executor = { execute: vi.fn() } as unknown as ExecutionService;
		const clock: Clock = { now: () => new Date("2026-01-01T00:00:00Z"), uptime: () => 0 };

		const command = createStartIssueSession({
			sessions: repo,
			workspaces,
			github,
			tasks,
			executor,
			clock,
			defaultBranch: "main",
			githubUsername: "tars-bot",
			selfReportEnabled: true,
		});

		expect(command).toBeInstanceOf(StartIssueSession);
	});

	it("assigns issue, creates session, and starts execution", async () => {
		const { command, github, executor } = makeCommand(null);
		const result = await command.execute("mbrooks", "tars", 1, "Test", "Body", ["bug"]);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.started).toBe(true);
			expect(result.data.status).toBe("working");
		}
		expect(github.updateIssueAssignees).toHaveBeenCalledWith("mbrooks", "tars", 1, ["tars-bot"]);
		expect(executor.execute).toHaveBeenCalled();
	});

	it("returns conflict when session is already active", async () => {
		const { command, tasks } = makeCommand(null);
		(tasks.isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);
		const result = await command.execute("mbrooks", "tars", 1, "Test", "Body", []);

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("conflict");
			expect(result.message).toBe("Session is already being executed");
		}
	});

	it("returns started false when session already exists and is not pending", async () => {
		const { command } = makeCommand(makeState("working"));
		const result = await command.execute("mbrooks", "tars", 1, "Test", "Body", []);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.started).toBe(false);
			expect(result.data.status).toBe("working");
		}
	});

	it("handles errors during execution", async () => {
		const { command, executor } = makeCommand(null);
		(executor.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Execution failed"));
		const result = await command.execute("mbrooks", "tars", 1, "Test", "Body", []);

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("internal");
			expect(result.message).toBe("Execution failed");
		}
	});

	it("handles errors from ensureSessionExists", async () => {
		const { command, workspaces } = makeCommand(null);
		(workspaces.createOrGetWorktree as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Workspace error"));
		const result = await command.execute("mbrooks", "tars", 1, "Test", "Body", []);

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("internal");
			expect(result.message).toBe("Workspace error");
		}
	});

	it("supports resolving the default branch per repo", async () => {
		const { repo, workspaces, github, tasks, executor } = makeCommand(null);
		const command = new StartIssueSession(
			repo,
			workspaces,
			github,
			tasks,
			executor,
			{ now: () => new Date("2026-01-01T00:00:00Z"), uptime: () => 0 },
			(owner, repoName) => (owner === "mbrooks" && repoName === "tars" ? "master" : "main"),
			"tars-bot",
			true,
		);

		const result = await command.execute("mbrooks", "tars", 1, "Test", "Body", []);

		expect(result.success).toBe(true);
		expect(executor.execute).toHaveBeenCalled();
	});
});
