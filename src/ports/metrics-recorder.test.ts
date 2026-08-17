import { describe, expect, it } from "vitest";

// metrics-recorder.ts exports only TypeScript interfaces. This test verifies
// the module can be imported and that the interface shapes are satisfied at
// runtime via a dummy implementation.
import type { MetricsRecorder, SessionMetric } from "./metrics-recorder.js";
import type { TokenUsage } from "../executor/usage.js";

const availableUsage: TokenUsage = {
	available: true,
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: 0.3,
};

const unavailableUsage: TokenUsage = {
	available: false,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
};

function baseMetric(overrides: Partial<SessionMetric> = {}): SessionMetric {
	return {
		sessionKey: "github-mbrooks-yolomatic-issue-1-implementation",
		owner: "mbrooks",
		repo: "yolomatic",
		issueNumber: 1,
		kind: "implementation",
		status: "complete",
		startedAt: "2026-08-01T00:00:00.000Z",
		finishedAt: "2026-08-01T00:01:00.000Z",
		durationMs: 60000,
		tokenUsage: availableUsage,
		...overrides,
	};
}

describe("MetricsRecorder interface", () => {
	it("can be implemented by a concrete object that records metrics", () => {
		const recorded: SessionMetric[] = [];
		const recorder: MetricsRecorder = {
			record: (metric) => {
				recorded.push(metric);
			},
		};
		expect(typeof recorder.record).toBe("function");

		recorder.record(baseMetric());
		expect(recorded).toHaveLength(1);
		expect(recorded[0].sessionKey).toBe("github-mbrooks-yolomatic-issue-1-implementation");
	});

	it("accepts refinement-kind metrics", () => {
		const recorded: SessionMetric[] = [];
		const recorder: MetricsRecorder = { record: (m) => recorded.push(m) };

		recorder.record(baseMetric({ kind: "refinement", status: "failed" }));
		expect(recorded[0].kind).toBe("refinement");
		expect(recorded[0].status).toBe("failed");
	});

	it("accepts metrics with unavailable token usage", () => {
		const recorded: SessionMetric[] = [];
		const recorder: MetricsRecorder = { record: (m) => recorded.push(m) };

		recorder.record(baseMetric({ tokenUsage: unavailableUsage }));
		expect(recorded[0].tokenUsage.available).toBe(false);
		expect(recorded[0].tokenUsage.totalTokens).toBe(0);
	});
});