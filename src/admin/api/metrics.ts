import { apiGet } from "./client.js";
import type { MetricsResponse } from "../app/types.js";

/**
 * Fetch the persisted dashboard metrics (daily time-series buckets + recent
 * executions). Token usage is reported per-bucket with an `available` flag so
 * the UI can render "unknown" when the underlying provider did not report
 * usage.
 */
export function fetchMetrics(days?: number): Promise<MetricsResponse> {
	const query = days != null ? `?days=${encodeURIComponent(String(days))}` : "";
	return apiGet<MetricsResponse>(`/api/metrics${query}`);
}