import { describe, expect, it, vi } from "vitest";
import { runCronExecution } from "./execution.js";
import type { CronJob } from "./store.js";
import type { PiAgentExecutor } from "../executor/index.js";
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

describe("runCronExecution", () => {
	it("resets the cron worktree and invokes the executor with the cron prompt", async () => {
		const createOrResetCronWorktree = vi.fn(async () => ({}));
		const executeWithOverride = vi.fn(async () => ({
			status: "complete" as const,
			summary: "Done",
			rawResponse: "TARS_STATUS: complete\nDone",
		}));
		type AnyFunction = (...args: unknown[]) => unknown;
		const deps = {
			workspaceManager: {
				createOrResetCronWorktree: createOrResetCronWorktree as AnyFunction,
			} as unknown as WorkspaceManager,
			executor: { executeWithOverride: executeWithOverride as AnyFunction } as unknown as PiAgentExecutor,
		};
		const state = makeSessionState();

		const result = await runCronExecution(
			deps,
			makeCronJob({ branch: undefined as unknown as string, prompt: "   " }),
			state,
			"/tmp/memory/sessions/test.jsonl",
		);

		expect(result.status).toBe("complete");
		expect(createOrResetCronWorktree).toHaveBeenCalledWith("mbrooks", "tars", "test-cron-1", "main");
		expect(executeWithOverride).toHaveBeenCalledWith(
			state,
			expect.stringContaining("(no instructions provided)"),
		);
	});
});
