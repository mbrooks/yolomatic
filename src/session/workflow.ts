import type { SessionManager } from "./manager.js";
import type { SessionState, SessionStatus } from "./store.js";

export class SessionWorkflow {
	public constructor(private readonly sessionManager: SessionManager) {}

	getSession(owner: string, repo: string, issueNumber: number): Promise<SessionState | null> {
		return this.sessionManager.getSession(owner, repo, issueNumber);
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
		return this.sessionManager.createSession(owner, repo, issueNumber, title, body, workspacePath, labels);
	}

	markWorking(owner: string, repo: string, issueNumber: number, updates?: Partial<Omit<SessionState, "repo" | "issueNumber" | "sessionPath">>) {
		return this.transition(owner, repo, issueNumber, "working", updates);
	}

	markPending(owner: string, repo: string, issueNumber: number, updates?: Partial<Omit<SessionState, "repo" | "issueNumber" | "sessionPath">>) {
		return this.transition(owner, repo, issueNumber, "pending", updates);
	}

	markWaitingFeedback(
		owner: string,
		repo: string,
		issueNumber: number,
		updates?: Partial<Omit<SessionState, "repo" | "issueNumber" | "sessionPath">>,
	) {
		return this.transition(owner, repo, issueNumber, "waiting-feedback", updates);
	}

	markComplete(owner: string, repo: string, issueNumber: number, updates?: Partial<Omit<SessionState, "repo" | "issueNumber" | "sessionPath">>) {
		return this.transition(owner, repo, issueNumber, "complete", updates);
	}

	markFailed(owner: string, repo: string, issueNumber: number, updates?: Partial<Omit<SessionState, "repo" | "issueNumber" | "sessionPath">>) {
		return this.transition(owner, repo, issueNumber, "failed", updates);
	}

	markCancelled(
		owner: string,
		repo: string,
		issueNumber: number,
		updates?: Partial<Omit<SessionState, "repo" | "issueNumber" | "sessionPath">>,
	) {
		return this.transition(owner, repo, issueNumber, "cancelled", updates);
	}

	markSeeded(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		return this.sessionManager.markSeeded(owner, repo, issueNumber);
	}

	associatePR(owner: string, repo: string, issueNumber: number, prNumber: number, prUrl: string): Promise<SessionState> {
		return this.sessionManager.associatePR(owner, repo, issueNumber, prNumber, prUrl);
	}

	findSessionByPR(owner: string, repo: string, prNumber: number): Promise<SessionState | null> {
		return this.sessionManager.findSessionByPR(owner, repo, prNumber);
	}

	incrementIterationCount(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		return this.sessionManager.incrementIterationCount(owner, repo, issueNumber);
	}

	cancelSession(owner: string, repo: string, issueNumber: number): Promise<SessionState> {
		return this.sessionManager.cancelSession(owner, repo, issueNumber);
	}

	private transition(
		owner: string,
		repo: string,
		issueNumber: number,
		status: SessionStatus,
		updates: Partial<Omit<SessionState, "repo" | "issueNumber" | "sessionPath">> = {},
	): Promise<SessionState> {
		if (Object.keys(updates).length === 0) {
			return this.sessionManager.updateStatus(owner, repo, issueNumber, status);
		}
		return this.sessionManager.updateStatus(owner, repo, issueNumber, status, updates);
	}
}
