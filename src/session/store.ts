import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type SessionStatus = "pending" | "working" | "waiting-feedback" | "complete" | "failed";

export interface SessionState {
	issueNumber: number;
	repo: string;
	owner: string;
	title: string;
	body: string;
	status: SessionStatus;
	sessionPath: string;
	workspacePath: string;
	lastActivity: string;
	seeded: boolean;
	summary?: string;
	prUrl?: string;
}

export class SessionStore {
	private readonly sessions = new Map<string, SessionState>();

	public constructor(private readonly sessionsDir: string) {}

	getSessionKey(owner: string, repo: string, issueNumber: number): string {
		return `github-${owner}-${repo}-issue-${issueNumber}`;
	}

	getSessionPath(owner: string, repo: string, issueNumber: number): string {
		return path.join(this.sessionsDir, `github-${owner}-${repo}`, `issue-${issueNumber}.jsonl`);
	}

	getStatePath(owner: string, repo: string, issueNumber: number): string {
		return path.join(this.sessionsDir, `github-${owner}-${repo}`, `issue-${issueNumber}.state.json`);
	}

	async get(owner: string, repo: string, issueNumber: number): Promise<SessionState | null> {
		const key = this.getSessionKey(owner, repo, issueNumber);
		const cached = this.sessions.get(key);
		if (cached) {
			return cached;
		}

		const statePath = this.getStatePath(owner, repo, issueNumber);
		try {
			const raw = await readFile(statePath, "utf8");
			const parsed = JSON.parse(raw) as SessionState;
			this.sessions.set(key, parsed);
			return parsed;
		} catch {
			return null;
		}
	}

	async set(state: SessionState): Promise<SessionState> {
		const statePath = this.getStatePath(state.owner, state.repo, state.issueNumber);
		await mkdir(path.dirname(statePath), { recursive: true });
		const key = this.getSessionKey(state.owner, state.repo, state.issueNumber);
		this.sessions.set(key, state);
		await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		return state;
	}

	async exists(owner: string, repo: string, issueNumber: number): Promise<boolean> {
		try {
			await access(this.getStatePath(owner, repo, issueNumber));
			return true;
		} catch {
			return false;
		}
	}
}
