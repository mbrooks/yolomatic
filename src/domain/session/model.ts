import { isTerminalStatus, type SessionState } from "../../session/store.js";

/**
 * Compatibility re-exports for existing callers.
 *
 * Canonical imports:
 * - Persisted session shapes and storage classes live in `src/session/store.ts`.
 * - Domain helpers in this module are the canonical source for derived session
 *   concepts such as keys, branch names, repo summaries, risks, and agent status.
 *
 * Keep these re-exports during the transition so public imports from
 * `domain/session/model.js` continue to compile. Remove them only as part of a
 * separate API migration.
 */
export { isTerminalStatus, type SessionState, type SessionStatus } from "../../session/store.js";

export function sessionKey(owner: string, repo: string, issueNumber: number): string {
	return `${owner}/${repo}#${issueNumber}`;
}

export function branchName(issueNumber: number): string {
	return `tars/issue-${issueNumber}`;
}

export interface SessionRisk {
	suspectedMisroute: boolean;
	reasons: string[];
	referencedIssueNumber: number | null;
}

export function detectSessionRisk(session: SessionState): SessionRisk {
	const reasons: string[] = [];
	let referencedIssueNumber: number | null = null;

	const fixesMatch = /^Fixes #(\d+)/u.exec(session.body.trim());
	if (fixesMatch) {
		referencedIssueNumber = Number.parseInt(fixesMatch[1], 10);
		if (referencedIssueNumber !== session.issueNumber) {
			reasons.push(`Session body references issue #${referencedIssueNumber}.`);
		}
	}

	if (session.title.trim().startsWith("TARS:")) {
		reasons.push("Session title looks like a generated PR title.");
	}

	if (!session.workspacePath.endsWith(`issue-${session.issueNumber}`)) {
		reasons.push(`Workspace path does not end with issue-${session.issueNumber}.`);
	}

	return {
		suspectedMisroute: reasons.length > 0,
		reasons,
		referencedIssueNumber,
	};
}

export interface RepoSummary {
	owner: string;
	repo: string;
	sessionCount: number;
	activeCount: number;
	lastActivity: string | null;
}

export function buildRepoSummaries(sessions: SessionState[]): RepoSummary[] {
	const map = new Map<string, RepoSummary>();
	for (const s of sessions) {
		const key = `${s.owner}/${s.repo}`;
		const existing = map.get(key);
		if (existing) {
			existing.sessionCount++;
			if (!isTerminalStatus(s.status)) existing.activeCount++;
			if (s.lastActivity > (existing.lastActivity ?? "")) {
				existing.lastActivity = s.lastActivity;
			}
		} else {
			map.set(key, {
				owner: s.owner,
				repo: s.repo,
				sessionCount: 1,
				activeCount: isTerminalStatus(s.status) ? 0 : 1,
				lastActivity: s.lastActivity,
			});
		}
	}
	return Array.from(map.values()).sort((a, b) => {
		if (a.owner !== b.owner) return a.owner.localeCompare(b.owner);
		return a.repo.localeCompare(b.repo);
	});
}

export function computeAgentStatus(sessions: SessionState[]): "online" | "busy" | "feedback" {
	const hasWorking = sessions.some((s) => s.status === "working");
	if (hasWorking) return "busy";
	const hasFeedback = sessions.some((s) => s.status === "waiting-feedback");
	if (hasFeedback) return "feedback";
	return "online";
}

export function sortSessionsByRecency(sessions: SessionState[]): SessionState[] {
	return [...sessions].sort((a, b) => {
		const aTime = a.createdAt ?? a.lastActivity;
		const bTime = b.createdAt ?? b.lastActivity;
		return new Date(bTime).getTime() - new Date(aTime).getTime();
	});
}
