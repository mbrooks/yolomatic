import { describe, expect, it, vi } from "vitest";
import { deliverCronResult } from "./delivery.js";
import type { CronJob } from "./store.js";
import type { ExecutionResult } from "../executor/index.js";
import type { GitHubService } from "../ports/github-service.js";
import type { SessionState } from "../session/store.js";
import type { WorkspaceManager } from "../workspace/manager.js";

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

function makeSessionState(partial: Partial<SessionState> = {}): SessionState {
	return {
		owner: "mbrooks",
		repo: "tars",
		issueNumber: -1,
		title: "Cron: Nightly build",
		body: "Do something",
		status: "working",
		sessionPath: "/tmp/session.jsonl",
		workspacePath: "/tmp/worktree",
		lastActivity: "2026-01-01T00:00:00.000Z",
		createdAt: "2026-01-01T00:00:00.000Z",
		seeded: true,
		sessionType: "cron",
		...partial,
	};
}

function makeResult(partial: Partial<ExecutionResult> = {}): ExecutionResult {
	return {
		status: "complete",
		summary: "Updated deps.",
		rawResponse: "TARS_STATUS: complete\nUpdated deps.",
		...partial,
	};
}

function makeDeps() {
	const commitAndPushPath = vi.fn(async () => true);
	const createPullRequest = vi.fn(async () => ({
		number: 123,
		html_url: "https://github.com/mbrooks/tars/pull/123",
	}));
	const listPullRequests = vi.fn(async () => [] as Array<{ number: number; html_url: string }>);
	type AnyFunction = (...args: unknown[]) => unknown;
	return {
		deps: {
			workspaceManager: { commitAndPushPath: commitAndPushPath as AnyFunction } as unknown as WorkspaceManager,
			github: {
				createPullRequest: createPullRequest as AnyFunction,
				listPullRequests: listPullRequests as AnyFunction,
			} as unknown as GitHubService,
		},
		calls: { commitAndPushPath, createPullRequest, listPullRequests },
	};
}

function makeInput(job = makeCronJob(), state = makeSessionState()) {
	return {
		job,
		state,
		result: makeResult(),
		output: "Updated deps.",
		issueNumber: -123,
		cronWorktreePath: "/tmp/worktree",
		branchName: "tars/cron-test-cron-1",
	};
}

describe("deliverCronResult", () => {
	it("commits, pushes, and creates a PR", async () => {
		const { deps, calls } = makeDeps();
		const state = makeSessionState();

		const delivery = await deliverCronResult(deps, makeInput(makeCronJob(), state));

		expect(calls.commitAndPushPath).toHaveBeenCalledWith(
			"/tmp/worktree",
			"tars/cron-test-cron-1",
			"TARS: Update deps",
			"main",
		);
		expect(calls.createPullRequest).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			"TARS: Nightly build",
			"Cron job: Nightly build\n\nUpdated deps.",
			"tars/cron-test-cron-1",
			"main",
		);
		expect(delivery.output).toContain("PR created: https://github.com/mbrooks/tars/pull/123");
		expect(state.prNumber).toBe(123);
		expect(state.prUrl).toBe("https://github.com/mbrooks/tars/pull/123");
	});

	it("returns no-change output when there is nothing to push", async () => {
		const { deps, calls } = makeDeps();
		calls.commitAndPushPath.mockResolvedValue(false);

		const delivery = await deliverCronResult(deps, makeInput());

		expect(calls.createPullRequest).not.toHaveBeenCalled();
		expect(delivery.output).toBe("No changes to deliver.\n\nUpdated deps.");
	});

	it("reuses an existing PR when GitHub rejects duplicate PR creation", async () => {
		const { deps, calls } = makeDeps();
		const state = makeSessionState();
		calls.createPullRequest.mockRejectedValue(new Error("A pull request already exists"));
		calls.listPullRequests.mockResolvedValue([
			{ number: 99, html_url: "https://github.com/mbrooks/tars/pull/99" },
		]);

		const delivery = await deliverCronResult(deps, makeInput(makeCronJob(), state));

		expect(calls.listPullRequests).toHaveBeenCalledWith("mbrooks", "tars", {
			head: "mbrooks:tars/cron-test-cron-1",
			base: "main",
			state: "open",
		});
		expect(delivery.output).toContain("PR already exists: https://github.com/mbrooks/tars/pull/99");
		expect(state.prNumber).toBe(99);
		expect(state.prUrl).toBe("https://github.com/mbrooks/tars/pull/99");
	});

	it("treats no-commit PR errors and null PRs as successful no-op delivery", async () => {
		const { deps, calls } = makeDeps();
		calls.createPullRequest.mockRejectedValueOnce(new Error("No commits between base and head"));

		await expect(deliverCronResult(deps, makeInput())).resolves.toEqual({
			output: "No PR created (no changes).\n\nUpdated deps.",
		});

		calls.createPullRequest.mockResolvedValueOnce(null as never);
		await expect(deliverCronResult(deps, makeInput())).resolves.toEqual({
			output: "No PR created (no commits).\n\nUpdated deps.",
		});
	});

	it("rethrows unhandled PR creation errors", async () => {
		const { deps, calls } = makeDeps();
		calls.createPullRequest.mockRejectedValue(new Error("GitHub unavailable"));

		await expect(deliverCronResult(deps, makeInput())).rejects.toThrow("GitHub unavailable");
	});

	it("rethrows duplicate PR errors when no existing PR can be found", async () => {
		const { deps, calls } = makeDeps();
		calls.createPullRequest.mockRejectedValue(new Error("A pull request already exists"));
		calls.listPullRequests.mockResolvedValue([]);

		await expect(deliverCronResult(deps, makeInput())).rejects.toThrow("A pull request already exists");
	});
});
