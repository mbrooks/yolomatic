import { describe, expect, it, vi } from "vitest";
import { notifyCronRun } from "./notification.js";
import type { CronJob } from "./store.js";
import type { GitHubService } from "../ports/github-service.js";

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

function makeDeps() {
	const postComment = vi.fn(async () => {});
	type AnyFunction = (...args: unknown[]) => unknown;
	return {
		deps: {
			github: { postComment: postComment as AnyFunction } as unknown as GitHubService,
		},
		calls: { postComment },
	};
}

describe("notifyCronRun", () => {
	it("posts success and failure issue comments for issue notification channels", async () => {
		const { deps, calls } = makeDeps();

		await notifyCronRun(
			deps,
			makeCronJob({ notificationChannel: "issue:77" }),
			"success",
			"Updated dependencies",
			null,
		);
		await notifyCronRun(
			deps,
			makeCronJob({ notificationChannel: "issue:78" }),
			"failure",
			"Push failed",
			"Push failed",
		);

		expect(calls.postComment).toHaveBeenNthCalledWith(
			1,
			"mbrooks",
			"tars",
			77,
			expect.stringContaining("Status: ✅ Success"),
		);
		expect(calls.postComment).toHaveBeenNthCalledWith(
			2,
			"mbrooks",
			"tars",
			78,
			expect.stringContaining("Error: Push failed"),
		);
	});

	it("ignores missing or unsupported notification channels", async () => {
		const { deps, calls } = makeDeps();

		await notifyCronRun(deps, makeCronJob(), "success", "Output", null);
		await notifyCronRun(deps, makeCronJob({ notificationChannel: "slack:ops" }), "success", "Output", null);

		expect(calls.postComment).not.toHaveBeenCalled();
	});

	it("swallows notification errors", async () => {
		const { deps, calls } = makeDeps();
		calls.postComment.mockRejectedValue(new Error("notify failed"));

		await expect(
			notifyCronRun(deps, makeCronJob({ notificationChannel: "issue:77" }), "failure", "", "boom"),
		).resolves.toBeUndefined();
	});
});
