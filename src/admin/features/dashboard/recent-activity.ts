import type { Session, SessionMetric } from "../../app/types.js";
import { sessionKey } from "../../lib/session-key.js";

/** Token usage attached to a Recent Activity row, or null when unavailable. */
export type ActivityTokenUsage = {
	available: boolean;
	totalTokens: number;
};

/**
 * A unified Recent Activity row. `session` is the live `Session` when the
 * row is sourced from the live sessions list; `null` when the row exists only
 * in the persisted recent executions (e.g. the session was archived).
 */
export type ActivityItem = {
	sessionKey: string;
	owner: string;
	repo: string;
	issueNumber: number;
	kind: Session["kind"];
	status: string;
	/** ISO timestamp used for recency ordering and relative display. */
	activity: string;
	/** Live session, or null when sourced only from recent executions. */
	session: Session | null;
	/** Execution runtime in milliseconds, or null when unknown. */
	runtimeMs: number | null;
	/** Token usage for the row, or null when no metric reported usage. */
	tokenUsage: ActivityTokenUsage | null;
};

/**
 * Merge live sessions with persisted recent executions into a single Recent
 * Activity list. Sessions win on duplicate `sessionKey` (no second row is
 * produced for a session that also has an execution record). Items are sorted
 * most-recent-first by their activity timestamp and capped at `limit` rows.
 */
export function buildRecentActivity(
	sessions: Session[],
	recent: SessionMetric[] = [],
	limit = 10,
): ActivityItem[] {
	const byKey = new Map<string, ActivityItem>();

	// Index recent metrics by sessionKey so live-session rows can borrow the
	// matching metric's token usage without producing a second row.
	const metricsByKey = new Map<string, SessionMetric>();
	for (const m of recent) {
		if (!metricsByKey.has(m.sessionKey)) metricsByKey.set(m.sessionKey, m);
	}

	for (const s of sessions) {
		const key = sessionKey(s.owner, s.repo, s.issueNumber, s.kind);
		if (byKey.has(key)) continue;
		const matchingMetric = metricsByKey.get(key);
		byKey.set(key, {
			sessionKey: key,
			owner: s.owner,
			repo: s.repo,
			issueNumber: s.issueNumber,
			kind: s.kind,
			status: s.status,
			activity: s.lastActivity,
			session: s,
			runtimeMs: s.totalExecutionTimeMs,
			tokenUsage: matchingMetric ? toActivityTokenUsage(matchingMetric.tokenUsage) : null,
		});
	}

	for (const m of recent) {
		if (byKey.has(m.sessionKey)) continue;
		byKey.set(m.sessionKey, {
			sessionKey: m.sessionKey,
			owner: m.owner,
			repo: m.repo,
			issueNumber: m.issueNumber,
			kind: m.kind,
			status: m.status,
			activity: m.finishedAt || m.startedAt,
			session: null,
			runtimeMs: m.durationMs,
			tokenUsage: toActivityTokenUsage(m.tokenUsage),
		});
	}

	return Array.from(byKey.values())
		.sort((a, b) => new Date(b.activity).getTime() - new Date(a.activity).getTime())
		.slice(0, limit);
}

function toActivityTokenUsage(usage: SessionMetric["tokenUsage"]): ActivityTokenUsage {
	return { available: usage.available, totalTokens: usage.totalTokens };
}