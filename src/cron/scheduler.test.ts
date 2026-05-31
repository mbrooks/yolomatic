import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSessionStateForCron,
	executeCronJob,
	startCronScheduler,
	stopCronScheduler,
	tickCrons,
} from "./scheduler.js";
import type { CronJob, CronStore } from "./store.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { PiAgentExecutor } from "../executor/index.js";
import type { GitHubService } from "../ports/github-service.js";
import type { SessionStore, SessionState } from "../session/store.js";

function makeCronJob(partial: Partial<CronJob> = {}): CronJob {
	return {
		id: "test-cron-1",
		owner: "mbrooks",
		repo: "tars",
		name: "Nightly build",
		description: "Test",
		prompt: "Do something",
		scheduleType: "daily",
		scheduleValue: "02:00",
		branch: "main",
		notificationChannel: null,
		enabled: true,
		nextRunAt: new Date().toISOString(),
		lastRunAt: null,
		lastRunStatus: null,
		lastError: null,
		createdAt: new Date().toISOString(),
		prUrl: null,
		prNumber: null,
		...partial,
	};
}

function createMockDeps() {
	const commitAndPushPath = vi.fn(async () => true);
	const getCronWorktreePath = vi.fn(
		(_owner: string, _repo: string, cronId: string) =>
			`/tmp/test-workspaces/mbrooks-tars/.worktrees/cron-${cronId}`,
	);
	const getCronBranchName = vi.fn((cronId: string) => `tars/cron-${cronId}`);
	const createOrResetCronWorktree = vi.fn(
		async (owner: string, repo: string, cronId: string, baseBranch: string) => ({
			owner,
			repo,
			cronId,
			path: getCronWorktreePath(owner, repo, cronId),
			branch: getCronBranchName(cronId),
			baseBranch,
		}),
	);
	const createPullRequest = vi.fn(async () => ({
		number: 123,
		html_url: "https://github.com/mbrooks/tars/pull/123",
	}));
	const listPullRequests = vi.fn(async () => [] as Array<{ number: number; html_url: string }>);
	const postComment = vi.fn(async () => {});
	const addRun = vi.fn(async () => {});
	const setCron = vi.fn(async () => {});
	const getAll = vi.fn(async () => [] as CronJob[]);
	const setSession = vi.fn(async () => ({} as ReturnType<SessionStore["set"]>));
	type AnyFunction = (...args: unknown[]) => unknown;
	return {
		workspaceManager: {
			getCronWorktreePath: getCronWorktreePath as AnyFunction,
			getCronBranchName: getCronBranchName as AnyFunction,
			createOrResetCronWorktree: createOrResetCronWorktree as AnyFunction,
			commitAndPushPath: commitAndPushPath as AnyFunction,
		} as unknown as WorkspaceManager,
		executor: {
			execute: vi.fn(async () => ({
				status: "complete" as const,
				summary: "Updated deps.",
				rawResponse: "TARS_STATUS: complete\nUpdated deps.",
			})),
		} as unknown as PiAgentExecutor,
		github: {
			createPullRequest: createPullRequest as AnyFunction,
			listPullRequests: listPullRequests as AnyFunction,
			postComment: postComment as AnyFunction,
		} as unknown as GitHubService,
		sessionStore: {
			set: setSession as AnyFunction,
		} as unknown as SessionStore,
		cronStore: {
			getAll: getAll as AnyFunction,
			addRun: addRun as AnyFunction,
			set: setCron as AnyFunction,
		} as unknown as CronStore,
		memoryDir: "/tmp/memory",
		githubToken: "token",
		githubUsername: "tars",
		calls: {
			createOrResetCronWorktree,
			getCronWorktreePath,
			getCronBranchName,
			commitAndPushPath,
			createPullRequest,
			listPullRequests,
			postComment,
			getAll,
			addRun,
			setCron,
			setSession,
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
	stopCronScheduler();
});

describe("createSessionStateForCron", () => {
	it("returns a SessionState with sessionType 'cron'", () => {
		const job = makeCronJob();
		const state = createSessionStateForCron(job, "/tmp/ws", "/tmp/session.jsonl", -12345, new Date("2026-01-01T00:00:00Z"));

		expect(state.sessionType).toBe("cron");
		expect(state.owner).toBe("mbrooks");
		expect(state.repo).toBe("tars");
		expect(state.issueNumber).toBe(-12345);
		expect(state.title).toBe("Cron: Nightly build");
		expect(state.body).toBe("Do something");
		expect(state.status).toBe("working");
		expect(state.branch).toBe("tars/cron-test-cron-1");
		expect(state.cronJobId).toBe("test-cron-1");
		expect(state.cronJobName).toBe("Nightly build");
		expect(state.cronScheduleExpression).toBe("daily:02:00");
		expect(state.cronTriggerTime).toBe("2026-01-01T00:00:00.000Z");
	});
});

describe("executeCronJob", () => {
	it("commits, pushes, and creates a PR when executor completes", async () => {
		const deps = createMockDeps();
		const job = makeCronJob({ id: "update-deps", name: "Update project dependencies" });
		const now = new Date("2026-01-01T00:00:00Z");

		await executeCronJob(deps, job, now);

		expect(deps.calls.createOrResetCronWorktree).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			"update-deps",
			"main",
		);
		expect(deps.calls.commitAndPushPath).toHaveBeenCalledWith(
			"/tmp/test-workspaces/mbrooks-tars/.worktrees/cron-update-deps",
			"tars/cron-update-deps",
			"TARS: Update deps",
			"main",
		);
		expect(deps.calls.createPullRequest).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			"TARS: Update project dependencies",
			"Cron job: Update project dependencies\n\nUpdated deps.",
			"tars/cron-update-deps",
			"main",
		);
		expect(deps.calls.setCron).toHaveBeenCalled();
		expect(deps.calls.addRun).toHaveBeenCalled();
		const setCronCalls = deps.calls.setCron.mock.calls as unknown as Array<[CronJob]>;
		const lastCron = setCronCalls[setCronCalls.length - 1][0];
		expect(lastCron.prNumber).toBe(123);
		expect(lastCron.prUrl).toBe("https://github.com/mbrooks/tars/pull/123");
		const sessionCalls = deps.calls.setSession.mock.calls as unknown as Array<[SessionState]>;
		const lastState = sessionCalls[sessionCalls.length - 1][0];
		expect(lastState.status).toBe("complete");
		expect(lastState.prNumber).toBe(123);
		expect(lastState.prUrl).toBe("https://github.com/mbrooks/tars/pull/123");
	});

	it("does not create a PR when there are no changes to deliver", async () => {
		const deps = createMockDeps();
		deps.calls.commitAndPushPath.mockResolvedValue(false);
		const job = makeCronJob();
		const now = new Date("2026-01-01T00:00:00Z");

		await executeCronJob(deps, job, now);

		expect(deps.calls.createPullRequest).not.toHaveBeenCalled();
		expect(deps.calls.setCron).toHaveBeenCalled();
		const setCronCalls = deps.calls.setCron.mock.calls as unknown as Array<[CronJob]>;
		const lastCron = setCronCalls[setCronCalls.length - 1][0];
		expect(lastCron.prNumber).toBeNull();
		expect(lastCron.prUrl).toBeNull();
		const sessionCalls = deps.calls.setSession.mock.calls as unknown as Array<[SessionState]>;
		const lastState = sessionCalls[sessionCalls.length - 1][0];
		expect(lastState.status).toBe("complete");
	});

	it("marks job as failed when delivery throws", async () => {
		const deps = createMockDeps();
		deps.calls.commitAndPushPath.mockRejectedValue(new Error("Push failed"));
		const job = makeCronJob();
		const now = new Date("2026-01-01T00:00:00Z");

		await executeCronJob(deps, job, now);

		expect(deps.calls.createPullRequest).not.toHaveBeenCalled();
		expect(deps.calls.setCron).toHaveBeenCalled();
		const setCronArgs = deps.calls.setCron.mock.calls[0] as unknown as [CronJob];
		expect(setCronArgs[0].lastRunStatus).toBe("failure");
		expect(setCronArgs[0].lastError).toBe("Push failed");
		expect(setCronArgs[0].prNumber).toBeNull();
		expect(setCronArgs[0].prUrl).toBeNull();
	});

	it("marks job as failed when cron execution is cancelled", async () => {
		const deps = createMockDeps();
		deps.executor.execute = vi.fn(async () => ({
			status: "cancelled" as const,
			summary: "",
			rawResponse: "",
		}));
		const job = makeCronJob();
		const now = new Date("2026-01-01T00:00:00Z");

		await executeCronJob(deps, job, now);

		expect(deps.calls.commitAndPushPath).not.toHaveBeenCalled();
		const sessionCalls = deps.calls.setSession.mock.calls as unknown as Array<[SessionState]>;
		const lastState = sessionCalls[sessionCalls.length - 1][0];
		expect(lastState.status).toBe("failed");
		expect(lastState.summary).toBe("Task was cancelled.");
	});

	it("reuses existing PR when createPullRequest reports PR already exists", async () => {
		const deps = createMockDeps();
		deps.calls.createPullRequest.mockRejectedValue(new Error("A pull request already exists"));
		deps.calls.listPullRequests.mockResolvedValue([
			{ number: 99, html_url: "https://github.com/mbrooks/tars/pull/99" },
		]);
		const job = makeCronJob();
		const now = new Date("2026-01-01T00:00:00Z");

		await executeCronJob(deps, job, now);

		expect(deps.calls.listPullRequests).toHaveBeenCalledWith("mbrooks", "tars", {
			head: "mbrooks:tars/cron-test-cron-1",
			base: "main",
			state: "open",
		});
		expect(deps.calls.setCron).toHaveBeenCalled();
		const setCronCalls = deps.calls.setCron.mock.calls as unknown as Array<[CronJob]>;
		const lastCron = setCronCalls[setCronCalls.length - 1][0];
		expect(lastCron.prNumber).toBe(99);
		expect(lastCron.prUrl).toBe("https://github.com/mbrooks/tars/pull/99");
	 const sessionCalls = deps.calls.setSession.mock.calls as unknown as Array<[SessionState]>;
		const lastState = sessionCalls[sessionCalls.length - 1][0];
		expect(lastState.prNumber).toBe(99);
		expect(lastState.prUrl).toBe("https://github.com/mbrooks/tars/pull/99");
	});

	it("treats a null pull request result as no commits to publish", async () => {
		const deps = createMockDeps();
		deps.calls.createPullRequest.mockResolvedValue(null as unknown as { number: number; html_url: string });
		const job = makeCronJob();

		await executeCronJob(deps, job, new Date("2026-01-01T00:00:00Z"));

		const sessionCalls = deps.calls.setSession.mock.calls as unknown as Array<[SessionState]>;
		const lastState = sessionCalls[sessionCalls.length - 1][0];
		expect(lastState.summary).toContain("No PR created (no commits).");
	});

	it("treats GitHub no-commit PR errors as a successful no-op delivery", async () => {
		const deps = createMockDeps();
		deps.calls.createPullRequest.mockRejectedValue(new Error("No commits between base and head"));
		const job = makeCronJob();

		await executeCronJob(deps, job, new Date("2026-01-01T00:00:00Z"));

		const sessionCalls = deps.calls.setSession.mock.calls as unknown as Array<[SessionState]>;
		const lastState = sessionCalls[sessionCalls.length - 1][0];
		expect(lastState.status).toBe("complete");
		expect(lastState.summary).toContain("No PR created (no changes).");
	});

	it("records a failure when cron worktree setup throws", async () => {
		const deps = createMockDeps();
		deps.calls.createOrResetCronWorktree.mockRejectedValue(new Error("setup failed"));
		const job = makeCronJob();

		await executeCronJob(deps, job, new Date("2026-01-01T00:00:00Z"));

		expect(deps.calls.commitAndPushPath).not.toHaveBeenCalled();
		expect(deps.calls.addRun).toHaveBeenCalled();
		const setCronCalls = deps.calls.setCron.mock.calls as unknown as Array<[CronJob]>;
		expect(setCronCalls[setCronCalls.length - 1][0].lastRunStatus).toBe("failure");
		expect(setCronCalls[setCronCalls.length - 1][0].lastError).toBe("setup failed");
	});

	it("posts a notification comment when configured with an issue target", async () => {
		const deps = createMockDeps();
		deps.calls.commitAndPushPath.mockResolvedValue(false);
		const job = makeCronJob({ notificationChannel: "issue:77" });

		await executeCronJob(deps, job, new Date("2026-01-01T00:00:00Z"));

		expect(deps.calls.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			77,
			expect.stringContaining("Cron job: Nightly build"),
		);
	});

	it("ignores unsupported notification targets and notification errors", async () => {
		const deps = createMockDeps();
		deps.calls.commitAndPushPath.mockResolvedValue(false);
		deps.calls.postComment.mockRejectedValue(new Error("notify failed"));

		await executeCronJob(
			deps,
			makeCronJob({ id: "unsupported", notificationChannel: "slack:ops" }),
			new Date("2026-01-01T00:00:00Z"),
		);
		await executeCronJob(
			deps,
			makeCronJob({ id: "failing", notificationChannel: "issue:99" }),
			new Date("2026-01-01T00:00:00Z"),
		);

		expect(deps.calls.postComment).toHaveBeenCalledTimes(1);
	});

	it("defaults the base branch to main when the cron job branch is unset", async () => {
		const deps = createMockDeps();
		deps.calls.commitAndPushPath.mockResolvedValue(false);

		await executeCronJob(
			deps,
			makeCronJob({ id: "default-base", branch: undefined, prompt: "   " }),
			new Date("2026-01-01T00:00:00Z"),
		);

		expect(deps.calls.createOrResetCronWorktree).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			"default-base",
			"main",
		);
		expect(deps.executor.execute).toHaveBeenCalledWith(
			expect.any(Object),
			undefined,
			undefined,
			undefined,
			undefined,
			expect.stringContaining("(no instructions provided)"),
		);
	});
});

describe("tickCrons", () => {
	it("runs only due and enabled cron jobs", async () => {
		const deps = createMockDeps();
		const now = new Date("2026-01-01T12:00:00Z");
		deps.calls.getAll.mockResolvedValue([
			makeCronJob({ id: "due-job", nextRunAt: "2026-01-01T11:00:00.000Z", enabled: true }),
			makeCronJob({ id: "future-job", nextRunAt: "2026-01-01T13:00:00.000Z", enabled: true }),
			makeCronJob({ id: "disabled-job", nextRunAt: "2026-01-01T11:00:00.000Z", enabled: false }),
		]);

		await tickCrons(deps, now);

		expect(deps.calls.createOrResetCronWorktree).toHaveBeenCalledTimes(1);
		expect(deps.calls.createOrResetCronWorktree).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			"due-job",
			"main",
		);
	});

	it("returns early when a tick is already in progress", async () => {
		const deps = createMockDeps();
		let resolveExecution: (() => void) | undefined;
		const executionGate = new Promise<void>((resolve) => {
			resolveExecution = resolve;
		});
		deps.executor.execute = vi.fn(async () => {
			await executionGate;
			return {
				status: "complete" as const,
				summary: "Updated deps.",
				rawResponse: "TARS_STATUS: complete\nUpdated deps.",
			};
		});
		deps.calls.getAll.mockResolvedValue([
			makeCronJob({ id: "slow-job", nextRunAt: "2026-01-01T11:00:00.000Z", enabled: true }),
		]);
		const now = new Date("2026-01-01T12:00:00Z");

		const firstTick = tickCrons(deps, now);
		await Promise.resolve();
		await tickCrons(deps, now);
		resolveExecution?.();
		await firstTick;

		expect(deps.calls.createOrResetCronWorktree).toHaveBeenCalledTimes(1);
	});

});

describe("cron scheduler lifecycle", () => {
	it("starts and stops the interval", () => {
		vi.useFakeTimers();
		const deps = createMockDeps();
		deps.calls.getAll.mockResolvedValue([]);

		startCronScheduler(deps);
		vi.advanceTimersByTime(60_000);
		stopCronScheduler();

		expect(deps.calls.getAll).toHaveBeenCalledTimes(1);
	});
});
