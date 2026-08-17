import type { MetricsStore, MetricsBucket, MetricsTimeSeries } from "../../metrics/store.js";
import type { SessionMetric } from "../../ports/metrics-recorder.js";
import { ok, type AppResult } from "../result.js";

export interface GetMetricsOptions {
	days?: number;
}

export interface MetricsResponse {
	windowDays: number;
	buckets: MetricsBucket[];
	recent: SessionMetric[];
}

const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 365;

/**
 * Dashboard metrics query. Returns daily time-series buckets covering the
 * last `days` days (default 7, clamped to 1..365) plus the most recent
 * recorded executions for the recent-activity list.
 */
export class GetMetrics {
	constructor(private readonly store: MetricsStore) {}

	async execute(options: GetMetricsOptions = {}): Promise<AppResult<MetricsResponse>> {
		const days = clampDays(options.days);
		const series: MetricsTimeSeries = this.store.timeSeries(days);
		const recent: SessionMetric[] = this.store.recent(20);
		return ok({ windowDays: days, buckets: series.buckets, recent });
	}
}

function clampDays(value: number | undefined): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_WINDOW_DAYS;
	if (n < 1) return DEFAULT_WINDOW_DAYS;
	if (n > MAX_WINDOW_DAYS) return MAX_WINDOW_DAYS;
	return n;
}