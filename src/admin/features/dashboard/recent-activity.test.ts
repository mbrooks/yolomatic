import { describe, expect, it } from "vitest";

import { buildRecentActivity } from "./recent-activity.js";
import type { Session, SessionMetric } from "../../app/types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		kind: "implementation",
		owner: "mbrooks",
		repo: "yolomatic",
		issueNumber: 1,
		status: "working",
		title: null,
		body: null,
		summary: null,
		workspacePath: "/ws/1",
		branch: "yolomatic/issue-1",
		lastActivity: "2026-08-01T00:00:00.000Z",
		createdAt: "2026-07-31T00:00:00.000Z",
		prUrl: null,
		prNumber: null,
		risk: { suspectedMisroute: false, reasons: [], referencedIssueNumber: null },
		staleDetectedAt: null,
		staleReason: null,
		stale: null,
		taskStartedAt: null,
		taskFinishedAt: null,
		totalExecutionTimeMs: null,
		...overrides,
	};
}

function makeMetric(overrides: Partial<SessionMetric> = {}): SessionMetric {
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
		tokenUsage: { available: true, input: 10, output: 5, totalTokens: 15, cost: 0.3 },
		...overrides,
	};
}

describe("buildRecentActivity", () => {
	it("dedupes a live session and a metric sharing the same sessionKey to one item, keeping the live session", () => {
		const sessions = [makeSession({ issueNumber: 1, lastActivity: "2026-08-01T12:00:00.000Z" })];
		const recent = [
			makeMetric({
				sessionKey: "github-mbrooks-yolomatic-issue-1-implementation",
				issueNumber: 1,
				finishedAt: "2026-08-01T00:01:00.000Z",
			}),
		];

		const result = buildRecentActivity(sessions, recent);

		expect(result).toHaveLength(1);
		expect(result[0].sessionKey).toBe("github-mbrooks-yolomatic-issue-1-implementation");
		expect(result[0].session).not.toBeNull();
		expect(result[0].session?.issueNumber).toBe(1);
		// Recent Activity entry wins: activity uses the session's lastActivity.
		expect(result[0].activity).toBe("2026-08-01T12:00:00.000Z");
	});

	it("includes a metrics-only entry (no matching live session) with session=null and activity from finishedAt", () => {
		const recent = [
			makeMetric({
				sessionKey: "github-mbrooks-yolomatic-issue-2-implementation",
				issueNumber: 2,
				finishedAt: "2026-08-02T00:01:00.000Z",
			}),
		];

		const result = buildRecentActivity([], recent);

		expect(result).toHaveLength(1);
		expect(result[0].session).toBeNull();
		expect(result[0].activity).toBe("2026-08-02T00:01:00.000Z");
		expect(result[0].issueNumber).toBe(2);
	});

	it("orders merged items most-recent-first across both sources", () => {
		const sessions = [
			makeSession({ issueNumber: 1, lastActivity: "2026-08-01T05:00:00.000Z" }),
			makeSession({ issueNumber: 3, lastActivity: "2026-08-03T05:00:00.000Z" }),
		];
		const recent = [
			makeMetric({
				sessionKey: "github-mbrooks-yolomatic-issue-2-implementation",
				issueNumber: 2,
				finishedAt: "2026-08-02T05:00:00.000Z",
			}),
		];

		const result = buildRecentActivity(sessions, recent);

		expect(result.map((r) => r.issueNumber)).toEqual([3, 2, 1]);
	});

	it("caps the merged list at the configured limit", () => {
		const sessions = Array.from({ length: 7 }, (_, i) =>
			makeSession({ issueNumber: i + 1, lastActivity: `2026-08-0${i + 1}T00:00:00.000Z` }),
		);
		const recent = Array.from({ length: 7 }, (_, i) =>
			makeMetric({
				sessionKey: `github-mbrooks-yolomatic-issue-${i + 8}-implementation`,
				issueNumber: i + 8,
				finishedAt: `2026-08-0${i + 8}T00:00:00.000Z`,
			}),
		);

		const result = buildRecentActivity(sessions, recent, 10);

		expect(result).toHaveLength(10);
	});

	it("returns an empty list when both sources are empty", () => {
		expect(buildRecentActivity([], [])).toEqual([]);
	});

	it("treats undefined recent as empty", () => {
		const result = buildRecentActivity([makeSession({ issueNumber: 1 })], undefined as unknown as SessionMetric[]);
		expect(result).toHaveLength(1);
	});

	it("skips a duplicate live session that shares a sessionKey with an earlier entry", () => {
		const first = makeSession({ issueNumber: 1, lastActivity: "2026-08-01T12:00:00.000Z" });
		const dup = makeSession({ issueNumber: 1, lastActivity: "2026-08-01T13:00:00.000Z" });

		const result = buildRecentActivity([first, dup], []);

		expect(result).toHaveLength(1);
		expect(result[0].activity).toBe("2026-08-01T12:00:00.000Z");
	});

	it("falls back to startedAt for a metrics-only row when finishedAt is missing", () => {
		const recent = [
			makeMetric({
				sessionKey: "github-mbrooks-yolomatic-issue-2-implementation",
				issueNumber: 2,
				finishedAt: "",
				startedAt: "2026-08-02T03:00:00.000Z",
			}),
		];

		const result = buildRecentActivity([], recent);

		expect(result).toHaveLength(1);
		expect(result[0].activity).toBe("2026-08-02T03:00:00.000Z");
	});

	it("populates runtimeMs and tokenUsage on a metrics-only row from the metric", () => {
		const recent = [
			makeMetric({
				sessionKey: "github-mbrooks-yolomatic-issue-2-implementation",
				issueNumber: 2,
				durationMs: 42000,
				tokenUsage: { available: true, input: 100, output: 50, totalTokens: 150, cost: 0.1 },
			}),
		];

		const result = buildRecentActivity([], recent);

		expect(result).toHaveLength(1);
		expect(result[0].runtimeMs).toBe(42000);
		expect(result[0].tokenUsage).toEqual({ available: true, totalTokens: 150 });
	});

	it("keeps tokenUsage.available === false on a metrics-only row", () => {
		const recent = [
			makeMetric({
				sessionKey: "github-mbrooks-yolomatic-issue-2-implementation",
				issueNumber: 2,
				tokenUsage: { available: false, input: 0, output: 0, totalTokens: 0, cost: 0 },
			}),
		];

		const result = buildRecentActivity([], recent);

		expect(result[0].tokenUsage).toEqual({ available: false, totalTokens: 0 });
	});

	it("populates runtimeMs from the live session and tokenUsage from the matching metric on a live row", () => {
		const sessions = [
			makeSession({ issueNumber: 1, totalExecutionTimeMs: 90000, lastActivity: "2026-08-01T12:00:00.000Z" }),
		];
		const recent = [
			makeMetric({
				sessionKey: "github-mbrooks-yolomatic-issue-1-implementation",
				issueNumber: 1,
				durationMs: 123456,
				tokenUsage: { available: true, input: 10, output: 5, totalTokens: 15, cost: 0.3 },
			}),
		];

		const result = buildRecentActivity(sessions, recent);

		expect(result).toHaveLength(1);
		expect(result[0].session).not.toBeNull();
		// Runtime comes from the live session, not the metric.
		expect(result[0].runtimeMs).toBe(90000);
		// Tokens come from the matching metric.
		expect(result[0].tokenUsage).toEqual({ available: true, totalTokens: 15 });
	});

	it("sets tokenUsage to null on a live row with no matching metric", () => {
		const sessions = [makeSession({ issueNumber: 1, totalExecutionTimeMs: null })];

		const result = buildRecentActivity(sessions, []);

		expect(result).toHaveLength(1);
		expect(result[0].runtimeMs).toBeNull();
		expect(result[0].tokenUsage).toBeNull();
	});
});