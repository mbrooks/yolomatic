import { getSessionLogs, type SessionLogEntry } from "../../logging/session-log-store.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import { sessionStorageKey, type SessionKind } from "../../session/store.js";
import { fail, ok, type AppResult } from "../result.js";

export interface SessionLogView {
	available: boolean;
	logs: SessionLogEntry[];
}

export class GetSessionLog {
	constructor(private readonly sessions: SessionRepository) {}

	async execute(
		owner: string,
		repo: string,
		issueNumber: number,
		kindOrSince: SessionKind | string = "implementation",
		since?: string,
	): Promise<AppResult<SessionLogView>> {
		const isKind = kindOrSince === "implementation" || kindOrSince === "refinement";
		const kind: SessionKind = isKind ? kindOrSince : "implementation";
		const resolvedSince = isKind ? since : kindOrSince;
		const session = await this.sessions.get(owner, repo, issueNumber, kind);
		if (!session) {
			return fail("not_found", "Session not found");
		}

		const key = sessionStorageKey(owner, repo, issueNumber, kind);
		const logs = getSessionLogs(key, resolvedSince);
		return ok({ available: true, logs });
	}
}
