import { describe, expect, it } from "vitest";
import { buildCronPrompt, createSessionStateForCron } from "./session.js";
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
		prUrl: null,
		prNumber: null,
		...partial,
	};
}

describe("cron session helpers", () => {
	it("builds a cron prompt with protocol and instructions", () => {
		const prompt = buildCronPrompt(makeCronJob({ prompt: "Update dependencies" }));

		expect(prompt).toContain("You are executing a scheduled cron job for mbrooks/tars.");
		expect(prompt).toContain("TARS_STATUS: complete");
		expect(prompt).toContain("Cron job: Nightly build");
		expect(prompt).toContain("Update dependencies");
	});

	it("uses a placeholder when the cron prompt is empty", () => {
		expect(buildCronPrompt(makeCronJob({ prompt: "   " }))).toContain("(no instructions provided)");
	});

	it("creates cron session state", () => {
		const state = createSessionStateForCron(
			makeCronJob(),
			"/tmp/worktree",
			"/tmp/session.jsonl",
			-123,
			new Date("2026-01-01T00:00:00Z"),
		);

		expect(state).toEqual(expect.objectContaining({
			owner: "mbrooks",
			repo: "tars",
			issueNumber: -123,
			title: "Cron: Nightly build",
			status: "working",
			sessionPath: "/tmp/session.jsonl",
			workspacePath: "/tmp/worktree",
			sessionTag: "tars-cron-test-cron-1",
			sessionType: "cron",
			branch: "tars/cron-test-cron-1",
			cronJobId: "test-cron-1",
			cronTriggerTime: "2026-01-01T00:00:00.000Z",
		}));
	});
});
