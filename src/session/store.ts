import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type SessionStatus = "pending" | "working" | "waiting-feedback" | "complete";

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
}

export class SessionStore {
	private readonly sessions = new Map<string, SessionState>();

	public constructor(private readonly sessionsDir: string) {}

	getSessionKey(repo: string, issueNumber: number): string {
		return `${repo.toLowerCase()}-issue-${issueNumber}`;
	}

	getSessionPath(repo: string, issueNumber: number): string {
		return path.join(this.sessionsDir, `${this.getSessionKey(repo, issueNumber)}.jsonl`);
	}

	getStatePath(repo: string, issueNumber: number): string {
		return path.join(this.sessionsDir, `${this.getSessionKey(repo, issueNumber)}.state.json`);
	}

	async get(repo: string, issueNumber: number): Promise<SessionState | null> {
		const key = this.getSessionKey(repo, issueNumber);
		const cached = this.sessions.get(key);
		if (cached) {
			return cached;
		}

		const statePath = this.getStatePath(repo, issueNumber);
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
		await mkdir(this.sessionsDir, { recursive: true });
		const key = this.getSessionKey(state.repo, state.issueNumber);
		const statePath = this.getStatePath(state.repo, state.issueNumber);
		this.sessions.set(key, state);
		await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		return state;
	}

	async exists(repo: string, issueNumber: number): Promise<boolean> {
		try {
			await access(this.getStatePath(repo, issueNumber));
			return true;
		} catch {
			return false;
		}
	}
}
