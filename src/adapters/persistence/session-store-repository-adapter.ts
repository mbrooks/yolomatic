import type { SessionRepository } from "../../ports/session-repository.js";
import type { SessionKind, SessionState, SessionStatus } from "../../session/store.js";
import { isTerminalStatus } from "../../session/store.js";

export class SessionStoreRepositoryAdapter implements SessionRepository {
	constructor(private readonly store: import("../../session/store.js").SessionStore) {}

	get(owner: string, repo: string, issueNumber: number, kind: SessionKind = "implementation"): Promise<SessionState | null> {
		return this.store.get(owner, repo, issueNumber, kind);
	}

	getAll(): Promise<SessionState[]> {
		return this.store.getAll();
	}

	save(state: SessionState): Promise<SessionState> {
		return this.store.set(state);
	}

	delete(owner: string, repo: string, issueNumber: number, kind: SessionKind = "implementation"): Promise<void> {
		return this.store.delete(owner, repo, issueNumber, kind);
	}

	archive(state: SessionState, archiveDir: string): Promise<void> {
		return this.store.archive(state, archiveDir);
	}

	async createSession(
		owner: string,
		repo: string,
		issueNumber: number,
		title: string,
		body: string,
		workspacePath: string,
		kindOrLabels: SessionKind | string[] = "implementation",
		labels?: string[],
	): Promise<SessionState> {
		const kind = Array.isArray(kindOrLabels) ? "implementation" : kindOrLabels;
		const sessionLabels = Array.isArray(kindOrLabels) ? kindOrLabels : labels;
		const existing = await this.store.get(owner, repo, issueNumber, kind);
		if (existing) {
			return existing;
		}
		const state: SessionState = {
			kind,
			issueNumber,
			repo,
			owner,
			title,
			body,
			status: "pending",
			sessionPath: this.store.getSessionPath(owner, repo, issueNumber, kind),
			workspacePath,
			labels: sessionLabels,
			lastActivity: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			seeded: false,
		};
		return this.store.set(state);
	}

	async updateStatus(
		owner: string,
		repo: string,
		issueNumber: number,
		status: SessionStatus,
		updates?: Partial<Omit<SessionState, "repo" | "issueNumber" | "sessionPath">>,
		kind: SessionKind = "implementation",
	): Promise<SessionState> {
		const existing = await this.store.get(owner, repo, issueNumber, kind);
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
		return this.store.set({ ...existing, seeded: true, lastActivity: new Date().toISOString() });
	}

	async associatePR(owner: string, repo: string, issueNumber: number, prNumber: number, prUrl: string): Promise<SessionState> {
		const existing = await this.store.get(owner, repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}
		return this.store.set({ ...existing, prNumber, prUrl, lastActivity: new Date().toISOString() });
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

	async findSessionByPR(owner: string, repo: string, prNumber: number): Promise<SessionState | null> {
		const sessions = await this.store.getAll();
		return sessions.find((s) => s.owner === owner && s.repo === repo && s.prNumber === prNumber) ?? null;
	}

	async cancelSession(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		return this.updateStatus(owner, repo, issueNumber, "cancelled");
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
		return this.store.set({ ...existing, status: "paused", lastActivity: new Date().toISOString() });
	}

	async unpauseSession(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		const existing = await this.store.get(owner, repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}
		if (existing.status !== "paused") {
			throw new Error(`Cannot resume a session in '${existing.status}' status. Only paused sessions can be resumed.`);
		}
		return this.store.set({ ...existing, status: "pending", lastActivity: new Date().toISOString() });
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
			throw new Error(`Cannot restart session in '${existing.status}' status. Only failed or cancelled sessions can be restarted.`);
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

	async markComplete(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		return this.updateStatus(owner, repo, issueNumber, "complete");
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
}
