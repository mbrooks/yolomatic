import { describe, expect, it, vi } from "vitest";
import { createSessionStateForCron } from "./scheduler.js";
import type { CronJob } from "./store.js";

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
		...partial,
	};
}

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
