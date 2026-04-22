import { mkdir } from "node:fs/promises";

import type { SessionStore, SessionState, SessionStatus } from "./store.js";

export class SessionManager {
	public constructor(
		private readonly sessionsDir: string,
		private readonly store: SessionStore,
	) {}

	getSessionKey(repo: string, issueNumber: number): string {
		return this.store.getSessionKey(repo, issueNumber);
	}

	getSessionPath(repo: string, issueNumber: number): string {
		return this.store.getSessionPath(repo, issueNumber);
	}

	async createSession(
		owner: string,
		repo: string,
		issueNumber: number,
		title: string,
		body: string,
		workspacePath: string,
	): Promise<SessionState> {
		const existing = await this.store.get(repo, issueNumber);
		if (existing) {
			return existing;
		}

		await mkdir(this.sessionsDir, { recursive: true });

		const state: SessionState = {
			issueNumber,
			repo,
			owner,
			title,
			body,
			status: "pending",
			sessionPath: this.getSessionPath(repo, issueNumber),
			workspacePath,
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		return this.store.set(state);
	}

	async getSession(repo: string, issueNumber: number): Promise<SessionState | null> {
		return this.store.get(repo, issueNumber);
	}

	async updateStatus(
		repo: string,
		issueNumber: number,
		status: SessionStatus,
		updates: Partial<Omit<SessionState, "repo" | "issueNumber" | "sessionPath">> = {},
	): Promise<SessionState> {
		const existing = await this.store.get(repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${repo}-issue-${issueNumber}`);
		}

		return this.store.set({
			...existing,
			...updates,
			status,
			lastActivity: new Date().toISOString(),
		});
	}

	async markSeeded(repo: string, issueNumber: number): Promise<SessionState> {
		const existing = await this.store.get(repo, issueNumber);
		if (!existing) {
			throw new Error(`No session for ${repo}-issue-${issueNumber}`);
		}

		return this.store.set({
			...existing,
			seeded: true,
			lastActivity: new Date().toISOString(),
		});
	}
}
