import type { SessionKind, SessionState, SessionStatus } from "../session/store.js";

export interface SessionRepository {
	get(owner: string, repo: string, issueNumber: number, kind?: SessionKind): Promise<SessionState | null>;
	getAll(): Promise<SessionState[]>;
	save(state: SessionState): Promise<SessionState>;
	delete(owner: string, repo: string, issueNumber: number, kind?: SessionKind): Promise<void>;
	archive(state: SessionState, archiveDir: string): Promise<void>;
	createSession(
		owner: string,
		repo: string,
		issueNumber: number,
		title: string,
		body: string,
		workspacePath: string,
		kind?: SessionKind | string[],
		labels?: string[],
	): Promise<SessionState>;
	updateStatus(
		owner: string,
		repo: string,
		issueNumber: number,
		status: SessionStatus,
		updates?: Partial<Omit<SessionState, "repo" | "issueNumber" | "sessionPath">>,
		kind?: SessionKind,
	): Promise<SessionState>;
	markSeeded(owner: string, repo: string, issueNumber: number): Promise<SessionState>;
	associatePR(owner: string, repo: string, issueNumber: number, prNumber: number, prUrl: string): Promise<SessionState>;
	incrementIterationCount(owner: string, repo: string, issueNumber: number): Promise<SessionState>;
	findSessionByPR(owner: string, repo: string, prNumber: number): Promise<SessionState | null>;
	cancelSession(owner: string, repo: string, issueNumber: number): Promise<SessionState>;
	pauseSession(owner: string, repo: string, issueNumber: number): Promise<SessionState>;
	unpauseSession(owner: string, repo: string, issueNumber: number): Promise<SessionState>;
	restartSession(owner: string, repo: string, issueNumber: number): Promise<SessionState>;
	markComplete(owner: string, repo: string, issueNumber: number): Promise<SessionState>;
	markFailed(owner: string, repo: string, issueNumber: number, reason?: string): Promise<SessionState>;
	markStale(owner: string, repo: string, issueNumber: number, reason: string): Promise<SessionState>;
}
