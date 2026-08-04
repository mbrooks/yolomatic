import { getSessionLogs, type SessionLogEntry } from "../../logging/session-log-store.js";
import type { RefinementStore } from "../../refinement/store.js";
import { sessionStorageKey } from "../../session/store.js";
import { fail, ok, type AppResult } from "../result.js";

export interface RefinementLogView {
	available: boolean;
	logs: SessionLogEntry[];
}

/**
 * Returns the durable activity log for issue-refinement on an issue, mirroring
 * the {@link GetSessionLog} contract for coding tasks. Unlike the session log
 * view, refinement activity is available even when no implementation session
 * exists for the issue: refinement logs share the issue's session key, and the
 * query gates availability on the presence of a refinement attempt.
 */
export class GetRefinementLog {
	constructor(private readonly refinementStore: RefinementStore) {}

	async execute(owner: string, repo: string, issueNumber: number, since?: string): Promise<AppResult<RefinementLogView>> {
		const attempts = this.refinementStore.listAttemptsByIssue(owner, repo, issueNumber);
		if (attempts.length === 0) {
			return fail("not_found", "No refinement activity for this issue");
		}

		const key = sessionStorageKey(owner, repo, issueNumber, "refinement");
		const logs = getSessionLogs(key, since);
		return ok({ available: true, logs });
	}
}
