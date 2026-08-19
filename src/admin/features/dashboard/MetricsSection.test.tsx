// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import React from "react";

import { MetricsSection } from "./MetricsSection.js";
import type { MetricsResponse } from "../../app/types.js";

function bucket(overrides: Partial<MetricsResponse["buckets"][number]> = {}): MetricsResponse["buckets"][number] {
	return {
		date: "2026-08-01",
		sessions: { total: 1, complete: 1, failed: 0, cancelled: 0 },
		tokens: { available: true, input: 10, output: 5, total: 15, cost: 0.3 },
		runtimeMs: 60000,
		...overrides,
	};
}

function response(buckets: MetricsResponse["buckets"][number], recent: MetricsResponse["recent"] = []): MetricsResponse {
	return { windowDays: 7, buckets, recent };
}

const recentMetric: MetricsResponse["recent"][number] = {
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
};

describe("MetricsSection", () => {
	it("renders the empty state when no metrics are provided", () => {
		const { container } = render(<MetricsSection metrics={null} />);
		expect(container.textContent).toContain("No metrics recorded yet");
	});

	it("renders the empty state when there are no buckets", () => {
		const { container } = render(<MetricsSection metrics={{ windowDays: 7, buckets: [], recent: [] }} />);
		expect(container.textContent).toContain("No metrics recorded yet");
	});

	it("renders summary cards with totals and the window label", () => {
		const { container } = render(
			<MetricsSection
				metrics={response([
					bucket({ sessions: { total: 2, complete: 1, failed: 1, cancelled: 0 }, tokens: { available: true, input: 30, output: 15, total: 45, cost: 0.9 }, runtimeMs: 120000 }),
					bucket({ date: "2026-08-02", sessions: { total: 1, complete: 0, failed: 0, cancelled: 1 }, tokens: { available: true, input: 5, output: 5, total: 10, cost: 0.1 }, runtimeMs: 30000 }),
				])}
			/>,
		);
		const text = container.textContent ?? "";
		expect(text).toContain("Last 7 days");
		expect(text).toContain("Sessions");
		expect(text).toContain("3");
		expect(text).toContain("2m"); // total runtime 150000ms = 2m
		expect(text).toContain("55"); // total tokens 45+10
	});

	it("renders the three chart cards", () => {
		const { container } = render(<MetricsSection metrics={response([bucket()])} />);
		expect(container.querySelector('[data-testid="metrics-token-chart"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="metrics-runtime-chart"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="metrics-outcomes-chart"]')).not.toBeNull();
	});

	it("renders token usage as 'unknown' when no bucket reported usage", () => {
		const { container } = render(
			<MetricsSection
				metrics={response([
					bucket({ tokens: { available: false, input: 0, output: 0, total: 0, cost: 0 } }),
					bucket({ date: "2026-08-02", tokens: { available: false, input: 0, output: 0, total: 0, cost: 0 } }),
				])}
			/>,
		);
		const text = container.textContent ?? "";
		expect(text).toContain("unknown");
		expect(container.querySelector(".metrics-unknown")).not.toBeNull();
		expect(container.querySelector(".metrics-empty-overlay")).not.toBeNull();
		// Token chart should not draw any data points/lines when usage is unavailable.
		expect(container.querySelector('[data-testid="metrics-token-chart"] .metrics-line')).toBeNull();
	});

	it("does not render the recent executions table even when recent metrics are present", () => {
		const recent = [
			{ ...recentMetric, issueNumber: 1, tokenUsage: { available: true, input: 10, output: 5, totalTokens: 15, cost: 0.3 } },
			{ ...recentMetric, sessionKey: "github-mbrooks-yolomatic-issue-2-implementation", issueNumber: 2, tokenUsage: { available: false, input: 0, output: 0, totalTokens: 0, cost: 0 } },
		];
		const { container } = render(<MetricsSection metrics={response([bucket()], recent)} />);
		expect(container.querySelector(".metrics-recent")).toBeNull();
		expect(container.textContent).not.toContain("Recent Executions");
	});
});