import { isTerminalStatus, type SessionState } from "../../session/store.js";

/**
 * Narrow session operations {@link CleanupOldSessions} can call: list every
 * session and delete one by issue. Composed from {@link SessionRepository}
 * at the wiring boundary via structural typing.
 */
export interface CleanupSessionPort {
	getAll(): Promise<SessionState[]>;
	delete(owner: string, repo: string, issueNumber: number, kind?: SessionState["kind"]): Promise<void>;
}

/**
 * Narrow workspace operations {@link CleanupOldSessions} can call: remove a
 * session's worktree. Composed from {@link WorkspaceService} at the wiring
 * boundary.
 */
export interface CleanupWorkspacePort {
	removeWorktree(owner: string, repo: string, issueNumber: number): Promise<void>;
}

export class CleanupOldSessions {
	constructor(
		private readonly sessions: CleanupSessionPort,
		private readonly workspaces: CleanupWorkspacePort,
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
