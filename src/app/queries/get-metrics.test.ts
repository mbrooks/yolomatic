import { describe, expect, it, vi } from "vitest";
import { GetMetrics } from "./get-metrics.js";

function makeRecorder(timeSeries: unknown, recent: unknown[] = []) {
	return {
		record: vi.fn(),
		timeSeries: vi.fn(() => timeSeries),
		recent: vi.fn(() => recent),
	};
}

describe("GetMetrics", () => {
	it("returns the time-series from the recorder for the requested window", async () => {
		const series = {
			buckets: [
				{
					date: "2026-08-01",
					sessions: { total: 1, complete: 1, failed: 0, cancelled: 0 },
					tokens: { available: true, input: 10, output: 5, total: 15, cost: 0.3 },
					runtimeMs: 60000,
				},
			],
		};
		const recorder = makeRecorder(series);
		const query = new GetMetrics(recorder as never);

		const result = await query.execute({ days: 7 });

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(recorder.timeSeries).toHaveBeenCalledWith(7);
		expect(result.data.buckets).toHaveLength(1);
		expect(result.data.buckets[0].tokens.total).toBe(15);
	});

	it("clamps days to a positive integer with a sensible default", async () => {
		const recorder = makeRecorder({ buckets: [] });
		const query = new GetMetrics(recorder as never);

		await query.execute({ days: -5 });
		expect(recorder.timeSeries).toHaveBeenLastCalledWith(7);

		await query.execute({});
		expect(recorder.timeSeries).toHaveBeenLastCalledWith(7);

		await query.execute({ days: 0 });
		expect(recorder.timeSeries).toHaveBeenLastCalledWith(7);

		await query.execute({ days: 90 });
		expect(recorder.timeSeries).toHaveBeenLastCalledWith(90);

		await query.execute({ days: 400 });
		expect(recorder.timeSeries).toHaveBeenLastCalledWith(365);
	});

	it("includes recent executions alongside the time-series", async () => {
		const recent = [
			{
				sessionKey: "github-mbrooks-yolomatic-issue-1-implementation",
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 1,
				kind: "implementation",
				status: "complete",
				startedAt: "2026-08-01T00:00:00.000Z",
				finishedAt: "2026-08-01T00:01:00.000Z",
				durationMs: 60000,
				tokenUsage: { available: true, input: 10, output: 5, totalTokens: 15, cost: 0.3 },
			},
		];
		const recorder = makeRecorder({ buckets: [] }, recent);
		const query = new GetMetrics(recorder as never);

		const result = await query.execute({ days: 7 });
		if (!result.success) return;
		expect(result.data.recent).toHaveLength(1);
		expect(result.data.recent[0].issueNumber).toBe(1);
	});
});