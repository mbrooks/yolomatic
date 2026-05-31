import { describe, expect, it, vi } from "vitest";
import { finalizeCronSessionAndRecordRun } from "./recording.js";
import type { CronJob, CronRun, CronStore } from "./store.js";
import type { SessionState, SessionStore } from "../session/store.js";

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
		nextRunAt: "2026-01-01T00:00:00.000Z",
		lastRunAt: null,
		lastRunStatus: null,
		lastError: null,
		createdAt: "2026-01-01T00:00:00.000Z",
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

function makeDeps() {
	const setSession = vi.fn(async () => ({}));
	const addRun = vi.fn(async () => {});
	const setCron = vi.fn(async () => {});
	type AnyFunction = (...args: unknown[]) => unknown;
	return {
		deps: {
			sessionStore: { set: setSession as AnyFunction } as unknown as SessionStore,
			cronStore: {
				addRun: addRun as AnyFunction,
				set: setCron as AnyFunction,
			} as unknown as CronStore,
		},
		calls: { setSession, addRun, setCron },
	};
}

describe("finalizeCronSessionAndRecordRun", () => {
	it("marks successful sessions complete, records the run, and updates PR fields", async () => {
		const { deps, calls } = makeDeps();
		const job = makeCronJob();
		const state = makeSessionState({
			prNumber: 123,
			prUrl: "https://github.com/mbrooks/tars/pull/123",
		});
		const now = new Date("2026-01-01T00:00:00Z");

		await finalizeCronSessionAndRecordRun(deps, {
			job,
			state,
			now,
			status: "success",
			output: "PR created",
			error: null,
		});

		expect(calls.setSession).toHaveBeenCalledWith(expect.objectContaining({
			status: "complete",
			summary: "PR created",
			prNumber: 123,
		}));
		const addRunCalls = calls.addRun.mock.calls as unknown as Array<[CronRun]>;
		const run = addRunCalls[0][0];
		expect(run).toEqual(expect.objectContaining({
			cronId: "test-cron-1",
			status: "success",
			output: "PR created",
			error: null,
			startedAt: "2026-01-01T00:00:00.000Z",
		}));
		expect(run.id).toEqual(expect.any(String));
		expect(calls.setCron).toHaveBeenCalledWith(expect.objectContaining({
			lastRunAt: "2026-01-01T00:00:00.000Z",
			lastRunStatus: "success",
			lastError: null,
			prNumber: 123,
			prUrl: "https://github.com/mbrooks/tars/pull/123",
			nextRunAt: "2026-01-01T02:00:00.000Z",
		}));
	});

	it("marks failed sessions failed and stores the error summary", async () => {
		const { deps, calls } = makeDeps();

		await finalizeCronSessionAndRecordRun(deps, {
			job: makeCronJob(),
			state: makeSessionState(),
			now: new Date("2026-01-01T00:00:00Z"),
			status: "failure",
			output: "Push failed",
			error: "Push failed",
		});

		expect(calls.setSession).toHaveBeenCalledWith(expect.objectContaining({
			status: "failed",
			summary: "Push failed",
		}));
		expect(calls.setCron).toHaveBeenCalledWith(expect.objectContaining({
			lastRunStatus: "failure",
			lastError: "Push failed",
		}));
	});
});
