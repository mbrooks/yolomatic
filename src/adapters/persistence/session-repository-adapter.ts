import type { SessionRepository } from "../../ports/session-repository.js";
import type { SessionManager } from "../../session/manager.js";
import type { SessionState, SessionStatus } from "../../session/store.js";

export class SessionRepositoryAdapter implements SessionRepository {
	constructor(private readonly manager: SessionManager) {}

	get(owner: string, repo: string, issueNumber: number): Promise<SessionState | null> {
		return this.manager.getSession(owner, repo, issueNumber);
	}

	getAll(): Promise<SessionState[]> {
		return this.manager.getAll();
	}

	save(state: SessionState): Promise<SessionState> {
		return this.manager.save(state);
	}

	delete(owner: string, repo: string, issueNumber: number): Promise<void> {
		return this.manager.delete(owner, repo, issueNumber);
	}

	archive(state: SessionState, archiveDir: string): Promise<void> {
		return this.manager.archive(state, archiveDir);
	}

	createSession(
		owner: string,
		repo: string,
		issueNumber: number,
		title: string,
		body: string,
		workspacePath: string,
		labels?: string[],
	): Promise<SessionState> {
		return this.manager.createSession(owner, repo, issueNumber, title, body, workspacePath, labels);
	}

	async updateStatus(
		owner: string,
		repo: string,
		issueNumber: number,
		status: SessionStatus,
		updates?: Partial<Omit<SessionState, "repo" | "issueNumber" | "sessionPath">>,
	): Promise<SessionState> {
		if (updates) {
			return this.manager.updateStatus(owner, repo, issueNumber, status, updates);
		}
		return this.manager.updateStatus(owner, repo, issueNumber, status);
	}

	markSeeded(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		return this.manager.markSeeded(owner, repo, issueNumber);
	}

	associatePR(owner: string, repo: string, issueNumber: number, prNumber: number, prUrl: string): Promise<SessionState> {
		return this.manager.associatePR(owner, repo, issueNumber, prNumber, prUrl);
	}

	incrementIterationCount(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		return this.manager.incrementIterationCount(owner, repo, issueNumber);
	}

	findSessionByPR(owner: string, repo: string, prNumber: number): Promise<SessionState | null> {
		return this.manager.findSessionByPR(owner, repo, prNumber);
	}

	cancelSession(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		return this.manager.cancelSession(owner, repo, issueNumber);
	}

	pauseSession(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		return this.manager.pauseSession(owner, repo, issueNumber);
	}

	unpauseSession(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		return this.manager.unpauseSession(owner, repo, issueNumber);
	}

	restartSession(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		return this.manager.restartSession(owner, repo, issueNumber);
	}

	markComplete(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		return this.manager.markComplete(owner, repo, issueNumber);
	}

	markFailed(owner: string, repo: string, issueNumber: number, reason?: string): Promise<SessionState> {
		return this.manager.markFailed(owner, repo, issueNumber, reason);
	}

	markStale(owner: string, repo: string, issueNumber: number, reason: string): Promise<SessionState> {
		return this.manager.markStale(owner, repo, issueNumber, reason);
	}
}
