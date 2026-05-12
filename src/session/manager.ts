import type { SessionStore, SessionState, SessionStatus } from "./store.js";
import { isTerminalStatus } from "./store.js";

export class SessionManager {
	public constructor(
		private readonly sessionsDir: string,
		private readonly store: SessionStore,
	) {}

	getSessionKey(owner: string, repo: string, issueNumber: number): string {
		return this.store.getSessionKey(owner, repo, issueNumber);
	}

	getSessionPath(owner: string, repo: string, issueNumber: number): string {
		return this.store.getSessionPath(owner, repo, issueNumber);
	}

	async createSession(
		owner: string,
		repo: string,
		issueNumber: number,
		title: string,
		body: string,
		workspacePath: string,
		labels?: string[],
	): Promise<SessionState> {
		const existing = await this.store.get(owner, repo, issueNumber);
		if (existing) {
			return existing;
		}

		const state: SessionState = {
			issueNumber,
			repo,
			owner,
			title,
			body,
			status: "pending",
			sessionPath: this.getSessionPath(owner, repo, issueNumber),
			workspacePath,
			labels,
			lastActivity: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			seeded: false,
		};

		return this.store.set(state);
	}

	async getSession(owner: string, repo: string, issueNumber: number): Promise<SessionState | null> {
		return this.store.get(owner, repo, issueNumber);
	}

	async resumeSession(
		owner: string,
		repo: string,
		issueNumber: number,
		newComment?: string,
	): Promise<SessionState> {
		const state = await this.store.get(owner, repo, issueNumber);
		if (!state) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}

		state.status = "working";
		state.lastActivity = new Date().toISOString();
		return this.store.set(state);
	}

	async updateStatus(
		owner: string,
		repo: string,
		issueNumber: number,
		status: SessionStatus,
		updates: Partial<Omit<SessionState, "repo" | "issueNumber" | "sessionPath">> = {},
	): Promise<SessionState> {
		const existing = await this.store.get(owner, repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}

		return this.store.set({
			...existing,
			...updates,
			status,
			lastActivity: new Date().toISOString(),
		});
	}

	async markSeeded(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		const existing = await this.store.get(owner, repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}

		return this.store.set({
			...existing,
			seeded: true,
			lastActivity: new Date().toISOString(),
		});
	}

	async associatePR(owner: string, repo: string, issueNumber: number, prNumber: number, prUrl: string): Promise<SessionState> {
		const existing = await this.store.get(owner, repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}

		return this.store.set({
			...existing,
			prNumber,
			prUrl,
			lastActivity: new Date().toISOString(),
		});
	}

	async findSessionByPR(owner: string, repo: string, prNumber: number): Promise<SessionState | null> {
		const sessions = await this.store.getAll();
		return sessions.find((s) => s.owner === owner && s.repo === repo && s.prNumber === prNumber) ?? null;
	}

	async incrementIterationCount(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		const existing = await this.store.get(owner, repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}

		return this.store.set({
			...existing,
			iterationCount: (existing.iterationCount ?? 0) + 1,
			lastActivity: new Date().toISOString(),
		});
	}

	async markStale(owner: string, repo: string, issueNumber: number, reason: string): Promise<SessionState> {
		const existing = await this.store.get(owner, repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}

		return this.store.set({
			...existing,
			staleDetectedAt: new Date().toISOString(),
			staleReason: reason,
		});
	}

	async markFailed(owner: string, repo: string, issueNumber: number, reason?: string): Promise<SessionState> {
		const existing = await this.store.get(owner, repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}

		return this.store.set({
			...existing,
			status: "failed",
			lastActivity: new Date().toISOString(),
			staleDetectedAt: new Date().toISOString(),
			staleReason: reason ?? existing.staleReason,
			summary: reason && !existing.summary ? reason : existing.summary,
		});
	}

	async markComplete(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		const existing = await this.store.get(owner, repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}

		return this.store.set({
			...existing,
			status: "complete",
			lastActivity: new Date().toISOString(),
		});
	}

	async archiveSession(owner: string, repo: string, issueNumber: number, archiveDir: string): Promise<void> {
		const existing = await this.store.get(owner, repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}

		const archived: SessionState = {
			...existing,
			archivedAt: new Date().toISOString(),
		};

		await this.store.set(archived);
		await this.store.archive(archived, archiveDir);
	}

	async cancelSession(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		const existing = await this.store.get(owner, repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}

		return this.store.set({
			...existing,
			status: "cancelled",
			lastActivity: new Date().toISOString(),
		});
	}

	async pauseSession(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		const existing = await this.store.get(owner, repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}

		if (existing.status === "paused") {
			throw new Error(`Session is already paused.`);
		}

		if (isTerminalStatus(existing.status)) {
			throw new Error(`Cannot pause a session in '${existing.status}' status.`);
		}

		return this.store.set({
			...existing,
			status: "paused",
			lastActivity: new Date().toISOString(),
		});
	}

	async unpauseSession(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		const existing = await this.store.get(owner, repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}

		if (existing.status !== "paused") {
			throw new Error(`Cannot resume a session in '${existing.status}' status. Only paused sessions can be resumed.`);
		}

		return this.store.set({
			...existing,
			// Restore to pending so it can be picked up again; do not resume working automatically
			status: "pending",
			lastActivity: new Date().toISOString(),
		});
	}

	async restartSession(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		const existing = await this.store.get(owner, repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}

		if (existing.status === "complete") {
			throw new Error(`Cannot restart a completed session.`);
		}

		if (!isTerminalStatus(existing.status)) {
			throw new Error(
				`Cannot restart session in '${existing.status}' status. Only failed or cancelled sessions can be restarted.`,
			);
		}

		return this.store.set({
			...existing,
			status: "pending",
			summary: undefined,
			prUrl: undefined,
			prNumber: undefined,
			seeded: false,
			iterationCount: undefined,
			restartCount: (existing.restartCount ?? 0) + 1,
			restartedFrom: existing.status,
			lastActivity: new Date().toISOString(),
		});
	}

	async getAll(): Promise<SessionState[]> {
		return this.store.getAll();
	}

	async save(state: SessionState): Promise<SessionState> {
		return this.store.set(state);
	}

	async delete(owner: string, repo: string, issueNumber: number): Promise<void> {
		return this.store.delete(owner, repo, issueNumber);
	}

	async archive(state: SessionState, archiveDir: string): Promise<void> {
		return this.store.archive(state, archiveDir);
	}
}
