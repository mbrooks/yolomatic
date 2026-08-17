import type { DatabaseSync, StatementSync } from "node:sqlite";

import { runMigrations } from "../migrations/index.js";
import type { MetricsRecorder, SessionMetric } from "../ports/metrics-recorder.js";

export type { SessionMetric } from "../ports/metrics-recorder.js";

/**
 * Per-day aggregate bucket for the dashboard time-series. Token totals only
 * sum sessions whose provider reported usage; `tokens.available` flags
 * whether any session in the bucket had usage data.
 */
export interface MetricsBucket {
	/** ISO date (YYYY-MM-DD) for the bucket. */
	date: string;
	sessions: {
		total: number;
		complete: number;
		failed: number;
		cancelled: number;
	};
	tokens: {
		available: boolean;
		input: number;
		output: number;
		total: number;
		cost: number;
	};
	runtimeMs: number;
}

export interface MetricsTimeSeries {
	buckets: MetricsBucket[];
}

interface MetricsRow {
	session_key: string;
	owner: string;
	repo: string;
	issue_number: number;
	kind: string;
	status: string;
	started_at: string;
	finished_at: string;
	duration_ms: number;
	tokens_available: number;
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	cost: number;
	recorded_at: string;
}

/**
 * SQLite-backed {@link MetricsRecorder} and time-series aggregator. Shares
 * the bot-state database via the caller-supplied {@link DatabaseSync} handle
 * (the migrations table is shared across stores), so metrics live alongside
 * sessions and session logs and survive restarts.
 */
export class MetricsStore implements MetricsRecorder {
	private readonly insertStmt: StatementSync;
	private readonly recentStmt: StatementSync;
	private readonly rangeStmt: StatementSync;

	constructor(private readonly db: DatabaseSync) {
		runMigrations(db);
		this.insertStmt = db.prepare(
			`INSERT INTO session_metrics (
				session_key, owner, repo, issue_number, kind, status,
				started_at, finished_at, duration_ms,
				tokens_available, input_tokens, output_tokens, total_tokens, cost,
				recorded_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.recentStmt = db.prepare(
			"SELECT session_key, owner, repo, issue_number, kind, status, started_at, finished_at, duration_ms, tokens_available, input_tokens, output_tokens, total_tokens, cost, recorded_at FROM session_metrics ORDER BY id DESC LIMIT ?",
		);
		this.rangeStmt = db.prepare(
			"SELECT session_key, owner, repo, issue_number, kind, status, started_at, finished_at, duration_ms, tokens_available, input_tokens, output_tokens, total_tokens, cost, recorded_at FROM session_metrics WHERE started_at >= ? ORDER BY started_at",
		);
	}

	record(metric: SessionMetric): void {
		this.insertStmt.run(
			metric.sessionKey,
			metric.owner,
			metric.repo,
			metric.issueNumber,
			metric.kind,
			metric.status,
			metric.startedAt,
			metric.finishedAt,
			metric.durationMs,
			metric.tokenUsage.available ? 1 : 0,
			metric.tokenUsage.input,
			metric.tokenUsage.output,
			metric.tokenUsage.totalTokens,
			metric.tokenUsage.cost,
			new Date().toISOString(),
		);
	}

	/** Return the most recently recorded metrics (newest first). */
	recent(limit: number): SessionMetric[] {
		const rows = this.recentStmt.all(limit) as unknown as MetricsRow[];
		return rows.map((row) => this.toMetric(row));
	}

	/** Daily time-series buckets covering the last `days` days, oldest first. */
	timeSeries(days: number): MetricsTimeSeries {
		const buckets = this.buildEmptyBuckets(days);
		const since = buckets.length > 0 ? `${buckets[0].date}T00:00:00.000Z` : new Date(0).toISOString();
		const rows = this.rangeStmt.all(since) as unknown as MetricsRow[];
		const byDate = new Map<string, MetricsBucket>();
		for (const bucket of buckets) {
			byDate.set(bucket.date, bucket);
		}
		for (const row of rows) {
			const date = row.started_at.slice(0, 10);
			const bucket = byDate.get(date);
			if (!bucket) continue;
			this.accumulate(bucket, row);
		}
		return { buckets };
	}

	private buildEmptyBuckets(days: number): MetricsBucket[] {
		const count = Math.max(0, Math.floor(days));
		const buckets: MetricsBucket[] = [];
		const today = new Date();
		// Normalize to the local-midnight boundary expressed as YYYY-MM-DD in
		// UTC for stable bucket keys regardless of session timestamp timezone.
		for (let offset = count - 1; offset >= 0; offset -= 1) {
			const d = new Date(today.getTime() - offset * 24 * 60 * 60 * 1000);
			buckets.push(this.emptyBucket(this.bucketDate(d)));
		}
		return buckets;
	}

	private bucketDate(d: Date): string {
		const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
		const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
		const dd = d.getUTCDate().toString().padStart(2, "0");
		return `${yyyy}-${mm}-${dd}`;
	}

	private emptyBucket(date: string): MetricsBucket {
		return {
			date,
			sessions: { total: 0, complete: 0, failed: 0, cancelled: 0 },
			tokens: { available: false, input: 0, output: 0, total: 0, cost: 0 },
			runtimeMs: 0,
		};
	}

	private accumulate(bucket: MetricsBucket, row: MetricsRow): void {
		bucket.sessions.total += 1;
		if (row.status === "complete") bucket.sessions.complete += 1;
		else if (row.status === "failed") bucket.sessions.failed += 1;
		else if (row.status === "cancelled") bucket.sessions.cancelled += 1;

		bucket.runtimeMs += row.duration_ms;

		if (row.tokens_available === 1) {
			bucket.tokens.available = true;
			bucket.tokens.input += row.input_tokens;
			bucket.tokens.output += row.output_tokens;
			bucket.tokens.total += row.total_tokens;
			bucket.tokens.cost += row.cost;
		}
	}

	private toMetric(row: MetricsRow): SessionMetric {
		return {
			sessionKey: row.session_key,
			owner: row.owner,
			repo: row.repo,
			issueNumber: row.issue_number,
			kind: row.kind as SessionMetric["kind"],
			status: row.status,
			startedAt: row.started_at,
			finishedAt: row.finished_at,
			durationMs: row.duration_ms,
			tokenUsage: {
				available: row.tokens_available === 1,
				input: row.input_tokens,
				output: row.output_tokens,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: row.total_tokens,
				cost: row.cost,
			},
		};
	}
}