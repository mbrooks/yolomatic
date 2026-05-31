import type { SessionRepository } from "../../ports/session-repository.js";
import type { SessionState } from "../../session/store.js";
import { fail, ok, type AppResult } from "../result.js";

export class GetSession {
	constructor(private readonly sessions: SessionRepository) {}

	async execute(owner: string, repo: string, issueNumber: number): Promise<AppResult<SessionState>> {
		const session = await this.sessions.get(owner, repo, issueNumber);
		if (!session) {
			return fail("not_found", "Session not found");
		}
		return ok(session);
	}
}
