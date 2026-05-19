import { sessionKey } from "../../domain/session/model.js";
import { getSessionLogs, type SessionLogEntry } from "../../logging/session-log-store.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import { fail, ok, type AppResult } from "../result.js";

export interface SessionLogView {
	available: boolean;
	logs: SessionLogEntry[];
}

export class GetSessionLog {
	constructor(private readonly sessions: SessionRepository) {}

	async execute(owner: string, repo: string, issueNumber: number, since?: string): Promise<AppResult<SessionLogView>> {
		const session = await this.sessions.get(owner, repo, issueNumber);
		if (!session) {
			return fail("not_found", "Session not found");
		}

		const key = sessionKey(owner, repo, issueNumber);
		const logs = getSessionLogs(key, since);
		return ok({ available: true, logs });
	}
}
