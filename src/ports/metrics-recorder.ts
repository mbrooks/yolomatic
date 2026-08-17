import type { SessionKind } from "../session/store.js";
import type { TokenUsage } from "../executor/usage.js";

/**
 * A single task-execution metric, recorded once per session run (after the
 * worker completes, fails, or is cancelled). Token usage may be unavailable
 * when the underlying provider does not report usage; in that case
 * `tokenUsage.available` is false and the numeric fields are zero.
 */
export interface SessionMetric {
	sessionKey: string;
	owner: string;
	repo: string;
	issueNumber: number;
	kind: SessionKind;
	status: string;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	tokenUsage: TokenUsage;
}

/**
 * Port used by the control plane to record per-execution metrics. The SQLite
 * {@link MetricsStore} implements this; tests can substitute a fake recorder.
 */
export interface MetricsRecorder {
	record(metric: SessionMetric): void;
}