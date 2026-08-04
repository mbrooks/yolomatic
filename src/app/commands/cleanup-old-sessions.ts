import { isTerminalStatus, type SessionState } from "../../session/store.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";

export class CleanupOldSessions {
	constructor(
		private readonly sessions: SessionRepository,
		private readonly workspaces: WorkspaceService,
	) {}

	async execute(retentionDays: number): Promise<{ deleted: number; failed: number }> {
		const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
		const all = await this.sessions.getAll();
		const stale = all.filter((s) => isTerminalStatus(s.status) && new Date(s.lastActivity).getTime() < cutoff);
		let deleted = 0;
		let failed = 0;
		for (const session of stale) {
			try {
				await this.workspaces.removeWorktree(session.owner, session.repo, session.issueNumber);
				await this.sessions.delete(session.owner, session.repo, session.issueNumber, session.kind ?? "implementation");
				deleted++;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				process.stdout.write(`[cleanup] failed to delete ${session.owner}/${session.repo}#${session.issueNumber}: ${message}\n`);
				failed++;
			}
		}
		if (deleted > 0 || failed > 0) {
			process.stdout.write(`[cleanup] ${deleted} deleted, ${failed} failed out of ${stale.length} stale sessions\n`);
		}
		return { deleted, failed };
	}
}
