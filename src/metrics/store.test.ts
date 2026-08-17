import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { unlinkSync } from "node:fs";
import { MetricsStore, type SessionMetric, type MetricsTimeSeries } from "./store.js";

const dbPath = "/tmp/yolomatic-metrics-store-test.sqlite";

function freshDb(): DatabaseSync {
	try {
		unlinkSync(dbPath);
	} catch {
		// ignore
	}
	return new DatabaseSync(dbPath);
}

function nowIso(): string {
	return new Date().toISOString();
}

function isoDaysAgo(days: number): string {
	return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function baseMetric(overrides: Partial<SessionMetric> = {}): SessionMetric {
	const startedAt = nowIso();
	return {
		sessionKey: "github-mbrooks-yolomatic-issue-1-implementation",
		owner: "mbrooks",
		repo: "yolomatic",
		issueNumber: 1,
		kind: "implementation",
		status: "complete",
		startedAt,
		finishedAt: new Date(new Date(startedAt).getTime() + 60000).toISOString(),
		durationMs: 60000,
		tokenUsage: { available: true, input: 30, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 42, cost: 1.26 },
		...overrides,
	};
}

describe("MetricsStore", () => {
	afterEach(() => {
		try {
			unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("persists a recorded metric and reads it back via recent()", () => {
		const db = freshDb();
		const store = new MetricsStore(db);
		store.record(baseMetric());

		const recent = store.recent(10);
		expect(recent).toHaveLength(1);
		expect(recent[0]).toMatchObject({
			sessionKey: "github-mbrooks-yolomatic-issue-1-implementation",
			owner: "mbrooks",
			issueNumber: 1,
			status: "complete",
			durationMs: 60000,
		});
		expect(recent[0].tokenUsage.available).toBe(true);
		expect(recent[0].tokenUsage.totalTokens).toBe(42);
		expect(recent[0].tokenUsage.cost).toBeCloseTo(1.26, 10);
		db.close();
	});

	it("records metrics with unavailable token usage without breaking aggregates", () => {
		const db = freshDb();
		const store = new MetricsStore(db);
		store.record(
			baseMetric({
				sessionKey: "github-mbrooks-yolomatic-issue-2-implementation",
				issueNumber: 2,
				status: "failed",
				tokenUsage: { available: false, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
			}),
		);

		const series = store.timeSeries(7);
		expect(series.buckets).toHaveLength(7);
		const today = series.buckets[series.buckets.length - 1];
		expect(today.sessions.total).toBe(1);
		expect(today.sessions.failed).toBe(1);
		expect(today.sessions.complete).toBe(0);
		expect(today.tokens.available).toBe(false);
		expect(today.tokens.total).toBe(0);
		expect(today.runtimeMs).toBe(60000);
		db.close();
	});

	it("aggregates multiple metrics into the same daily bucket by startedAt date", () => {
		const db = freshDb();
		const store = new MetricsStore(db);
		store.record(baseMetric({ issueNumber: 1, status: "complete", tokenUsage: { available: true, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0.3 } }));
		store.record(baseMetric({ issueNumber: 2, status: "failed", tokenUsage: { available: true, input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: 0.6 } }));
		store.record(baseMetric({ issueNumber: 3, status: "cancelled", tokenUsage: { available: false, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 } }));

		const series = store.timeSeries(7);
		const today = series.buckets[series.buckets.length - 1];
		expect(today.sessions.total).toBe(3);
		expect(today.sessions.complete).toBe(1);
		expect(today.sessions.failed).toBe(1);
		expect(today.sessions.cancelled).toBe(1);
		// Only available-usage sessions contribute to token totals.
		expect(today.tokens.available).toBe(true);
		expect(today.tokens.total).toBe(45);
		expect(today.tokens.input).toBe(30);
		expect(today.tokens.output).toBe(15);
		expect(today.tokens.cost).toBeCloseTo(0.9, 10);
		// All sessions contribute to runtime totals.
		expect(today.runtimeMs).toBe(180000);
		db.close();
	});

	it("survives a reopen by loading persisted rows", () => {
		const db = freshDb();
		const store = new MetricsStore(db);
		store.record(baseMetric({ issueNumber: 7 }));
		db.close();

		const reopened = new DatabaseSync(dbPath);
		const store2 = new MetricsStore(reopened);
		const recent = store2.recent(10);
		expect(recent).toHaveLength(1);
		expect(recent[0].issueNumber).toBe(7);
		reopened.close();
	});

	it("returns N daily buckets ending today, oldest first", () => {
		const db = freshDb();
		const store = new MetricsStore(db);
		// Record a metric dated 3 days ago to land in an older bucket.
		const startedAt = isoDaysAgo(3);
		store.record(
			baseMetric({
				issueNumber: 9,
				startedAt,
				finishedAt: new Date(new Date(startedAt).getTime() + 60000).toISOString(),
			}),
		);

		const series: MetricsTimeSeries = store.timeSeries(7);
		expect(series.buckets).toHaveLength(7);
		expect(series.buckets[0].date < series.buckets[6].date).toBe(true);
		// Older bucket should hold the metric.
		const filledBucket = series.buckets.find((b) => b.sessions.total === 1);
		expect(filledBucket).toBeDefined();
		expect(filledBucket!.runtimeMs).toBe(60000);
		db.close();
	});

	it("ignores metrics outside the requested window", () => {
		const db = freshDb();
		const store = new MetricsStore(db);
		const startedAt = isoDaysAgo(30);
		store.record(
			baseMetric({
				issueNumber: 11,
				startedAt,
				finishedAt: new Date(new Date(startedAt).getTime() + 60000).toISOString(),
			}),
		);

		const series = store.timeSeries(7);
		const totalSessions = series.buckets.reduce((sum, b) => sum + b.sessions.total, 0);
		expect(totalSessions).toBe(0);
		db.close();
	});
});
	it("aggregates a metric whose status is not complete/failed/cancelled without incrementing outcome counts", () => {
		const db = freshDb();
		const store = new MetricsStore(db);
		store.record(
			baseMetric({
				issueNumber: 21,
				status: "working",
				tokenUsage: { available: false, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
			}),
		);

		const series = store.timeSeries(7);
		const today = series.buckets[series.buckets.length - 1];
		expect(today.sessions.total).toBe(1);
		expect(today.sessions.complete).toBe(0);
		expect(today.sessions.failed).toBe(0);
		expect(today.sessions.cancelled).toBe(0);
		expect(today.runtimeMs).toBe(60000);
		expect(today.tokens.available).toBe(false);
		db.close();
	});

	it("timeSeries(0) returns no buckets and skips rows that fall outside the (empty) window", () => {
		const db = freshDb();
		const store = new MetricsStore(db);
		store.record(baseMetric({ issueNumber: 22 }));

		const series = store.timeSeries(0);
		expect(series.buckets).toHaveLength(0);
		db.close();
	});
