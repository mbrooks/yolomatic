import type { SessionStore, SessionState, SessionStatus } from "./store.js";

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
			lastActivity: new Date().toISOString(),
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
}
