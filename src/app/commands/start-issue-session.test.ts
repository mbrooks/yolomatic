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
				repo: "yeetomatic",
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
		repo: "yeetomatic",
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
		adminLink: {
			adminBaseUrl?: string;
			resolveAdminBaseUrl?: () => string | undefined;
			issueAdminLinkInCommentsEnabled?: boolean;
			resolveIssueAdminLinkInCommentsEnabled?: () => boolean | undefined;
		};
	}>,
) {
	const repo = makeMockRepo(state);
	const workspaces: WorkspaceService = {
		createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/ws/issue-1", branch: "yeetomatic/issue-1" })),
			updateDefaultBranchFromOrigin: vi.fn(async () => ({ branch: "main", before: null, after: "sha", updated: true })),
			syncWorktree: vi.fn(async () => undefined),
		removeWorktree: vi.fn(),
		commitAndPush: vi.fn(),
		commitAndPushPath: vi.fn(),
		hasChanges: vi.fn(async () => false),
		getWorktreePath: vi.fn(() => "/tmp/ws/issue-1"),
		getGitStatus: vi.fn(async () => ""),
		getGitDiff: vi.fn(async () => ""),
	};
	const github: GitHubService = overrides?.github ?? {
		postComment: vi.fn(async () => 1),
		postPRComment: vi.fn(async () => 1),
		addLabels: vi.fn(),
		removeLabel: vi.fn(),
		getPullRequest: vi.fn(async () => null),
		updatePullRequestBranch: vi.fn(async () => undefined),
		createPullRequest: vi.fn(async () => null),
		markPullRequestReadyForReview: vi.fn(async () => undefined),
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
		updateIssueBody: vi.fn(),
		updateIssueTitle: vi.fn(),
		getAuthenticatedUser: vi.fn(async () => ({ login: "yeetomatic-bot" })),
		listAccessibleRepositories: vi.fn(async () => []),
		getRepository: vi.fn(async () => null),
		getCollaboratorPermissionLevel: vi.fn(async () => null),
		isCollaborator: vi.fn(async () => false),
		listIssueComments: vi.fn(async () => []),
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
		"yeetomatic-bot",
		true,
		overrides?.adminLink ?? {},
	);
	return { command, repo, workspaces, github, tasks, executor };
}

describe("StartIssueSession", () => {
	it("builds the command from a shared factory", () => {
		const repo = makeMockRepo(null);
		const workspaces = {
			createOrGetWorktree: vi.fn(),
			syncWorktree: vi.fn(async () => undefined),
			removeWorktree: vi.fn(),
			commitAndPush: vi.fn(),
			commitAndPushPath: vi.fn(),
			hasChanges: vi.fn(),
			getWorktreePath: vi.fn(),
			getGitStatus: vi.fn(),
			getGitDiff: vi.fn(),
		} as unknown as WorkspaceService;
		const github = { updateIssueAssignees: vi.fn(), updateIssueBody: vi.fn() } as unknown as GitHubService;
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
			githubUsername: "yeetomatic-bot",
			selfReportEnabled: true,
		});

		expect(command).toBeInstanceOf(StartIssueSession);
	});

	it("assigns issue, creates session, and starts execution", async () => {
		const { command, github, executor } = makeCommand(null);
		const result = await command.execute("mbrooks", "yeetomatic", 1, "Test", "Body", ["bug"]);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.started).toBe(true);
			expect(result.data.status).toBe("working");
		}
		expect(github.updateIssueAssignees).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, ["yeetomatic-bot"]);
		expect(executor.execute).toHaveBeenCalled();
	});

	it("returns conflict when session is already active", async () => {
		const { command, tasks } = makeCommand(null);
		(tasks.isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);
		const result = await command.execute("mbrooks", "yeetomatic", 1, "Test", "Body", []);

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("conflict");
			expect(result.message).toBe("Session is already being executed");
		}
	});

	it("returns conflict when a persisted refinement session is working", async () => {
		const { command, repo, github, executor } = makeCommand(makeState("working"));
		await repo.save({ ...makeState("working"), kind: "refinement" });

		const result = await command.execute("mbrooks", "yeetomatic", 1, "Test", "Body", []);

		expect(result).toEqual({ success: false, code: "conflict", message: "Issue refinement is currently running" });
		expect(github.updateIssueAssignees).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("returns started false when session already exists and is not pending", async () => {
		const { command } = makeCommand(makeState("working"));
		const result = await command.execute("mbrooks", "yeetomatic", 1, "Test", "Body", []);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.started).toBe(false);
			expect(result.data.status).toBe("working");
		}
	});

	it("handles errors during execution", async () => {
		const { command, executor } = makeCommand(null);
		(executor.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Execution failed"));
		const result = await command.execute("mbrooks", "yeetomatic", 1, "Test", "Body", []);

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("internal");
			expect(result.message).toBe("Execution failed");
		}
	});

	it("handles errors from ensureSessionExists", async () => {
		const { command, workspaces } = makeCommand(null);
		(workspaces.createOrGetWorktree as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Workspace error"));
		const result = await command.execute("mbrooks", "yeetomatic", 1, "Test", "Body", []);

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
			(owner, repoName) => (owner === "mbrooks" && repoName === "yeetomatic" ? "master" : "main"),
			"yeetomatic-bot",
			true,
		);

		const result = await command.execute("mbrooks", "yeetomatic", 1, "Test", "Body", []);

		expect(result.success).toBe(true);
		expect(executor.execute).toHaveBeenCalled();
	});

	it("appends an admin session link to the pickup comment when enabled", async () => {
		const { command, github } = makeCommand(null, {
			adminLink: {
				adminBaseUrl: "http://host:6767/yeetomatic/admin",
				issueAdminLinkInCommentsEnabled: true,
			},
		});
		const result = await command.execute("mbrooks", "yeetomatic", 1, "Test", "Body", ["bug"]);

		expect(result.success).toBe(true);
		const expectedUrl = "http://host:6767/yeetomatic/admin#/repos/mbrooks/yeetomatic/1/implementation";
		const pickupCall = ((github as any).postComment.mock.calls as unknown as Array<[string, string, number, string]>).find(
			(c) => c[3].startsWith("Picked up by Yeetomatic. Working on it..."),
		)!;
		expect(pickupCall).toBeDefined();
		expect(pickupCall[3]).toContain(`Track status: ${expectedUrl}`);
		expect(pickupCall[3]).not.toContain("#/repos/mbrooks/yeetomatic/issues/1");
	});

	it("omits the admin session link from the pickup comment when admin_base_url is empty", async () => {
		const { command, github } = makeCommand(null, {
			adminLink: {
				adminBaseUrl: "",
				issueAdminLinkInCommentsEnabled: true,
			},
		});
		const result = await command.execute("mbrooks", "yeetomatic", 1, "Test", "Body", ["bug"]);

		expect(result.success).toBe(true);
		const pickupCall = ((github as any).postComment.mock.calls as unknown as Array<[string, string, number, string]>).find(
			(c) => c[3].startsWith("Picked up by Yeetomatic. Working on it..."),
		)!;
		expect(pickupCall).toBeDefined();
		expect(pickupCall[3]).toBe("Picked up by Yeetomatic. Working on it...");
		expect(pickupCall[3]).not.toContain("Track status:");
	});

	it("omits the admin session link from the pickup comment when the toggle is disabled", async () => {
		const { command, github } = makeCommand(null, {
			adminLink: {
				adminBaseUrl: "http://host:6767/yeetomatic/admin",
				issueAdminLinkInCommentsEnabled: false,
			},
		});
		const result = await command.execute("mbrooks", "yeetomatic", 1, "Test", "Body", ["bug"]);

		expect(result.success).toBe(true);
		const pickupCall = ((github as any).postComment.mock.calls as unknown as Array<[string, string, number, string]>).find(
			(c) => c[3].startsWith("Picked up by Yeetomatic. Working on it..."),
		)!;
		expect(pickupCall).toBeDefined();
		expect(pickupCall[3]).not.toContain("Track status:");
	});

	it("reads admin link settings live from the resolver at pickup time", async () => {
		let baseUrl = "http://host:6767/old/admin";
		let enabled = true;
		const { command, github } = makeCommand(null, {
			adminLink: {
				resolveAdminBaseUrl: () => baseUrl,
				resolveIssueAdminLinkInCommentsEnabled: () => enabled,
			},
		});
		await command.execute("mbrooks", "yeetomatic", 1, "Test", "Body", ["bug"]);
		let pickupCall = ((github as any).postComment.mock.calls as unknown as Array<[string, string, number, string]>).find(
			(c) => c[3].startsWith("Picked up by Yeetomatic. Working on it..."),
		)!;
		expect(pickupCall[3]).toContain(
			"Track status: http://host:6767/old/admin#/repos/mbrooks/yeetomatic/1/implementation",
		);
	});
});
