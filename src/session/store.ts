import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type SessionStatus = "pending" | "working" | "waiting-feedback" | "paused" | "complete" | "failed" | "cancelled";

export const TERMINAL_STATUSES: readonly SessionStatus[] = ["complete", "failed", "cancelled"];

export function isTerminalStatus(status: SessionStatus): boolean {
	return TERMINAL_STATUSES.includes(status);
}

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
	createdAt?: string;
	seeded: boolean;
	summary?: string;
	prUrl?: string;
	prNumber?: number;
	iterationCount?: number;
	labels?: string[];
	restartCount?: number;
	restartedFrom?: SessionStatus;
	staleDetectedAt?: string;
	staleReason?: string;
	archivedAt?: string;
	resumeOnBoot?: boolean;
	queuedComments?: string[];
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

	getArchivePath(archiveDir: string, owner: string, repo: string, issueNumber: number): string {
		return path.join(archiveDir, `github-${owner}-${repo}`, `issue-${issueNumber}.state.json`);
	}

	getSessionArchivePath(archiveDir: string, owner: string, repo: string, issueNumber: number): string {
		return path.join(archiveDir, `github-${owner}-${repo}`, `issue-${issueNumber}.jsonl`);
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

	async delete(owner: string, repo: string, issueNumber: number): Promise<void> {
		const key = this.getSessionKey(owner, repo, issueNumber);
		this.sessions.delete(key);
		const statePath = this.getStatePath(owner, repo, issueNumber);
		const sessionPath = this.getSessionPath(owner, repo, issueNumber);
		try {
			await rm(statePath, { force: true });
		} catch {
			// ignore
		}
		try {
			await rm(sessionPath, { force: true });
		} catch {
			// ignore
		}
	}

	async getAll(): Promise<SessionState[]> {
		const sessions: SessionState[] = [];
		try {
			const entries = await readdir(this.sessionsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const repoDir = path.join(this.sessionsDir, entry.name);
				const files = await readdir(repoDir);
				for (const file of files) {
					if (!file.endsWith(".state.json")) continue;
					const filePath = path.join(repoDir, file);
					try {
						const raw = await readFile(filePath, "utf8");
						const parsed = JSON.parse(raw) as SessionState;
						if (!parsed.archivedAt) {
							sessions.push(parsed);
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						process.stdout.write(`[session-store] warning: invalid state file ${filePath}: ${message}\n`);
					}
				}
			}
		} catch {
			// sessions dir doesn't exist or isn't readable
		}
		return sessions;
	}

	async archive(state: SessionState, archiveDir: string): Promise<void> {
		const archiveStatePath = this.getArchivePath(archiveDir, state.owner, state.repo, state.issueNumber);
		const archiveSessionPath = this.getSessionArchivePath(archiveDir, state.owner, state.repo, state.issueNumber);
		const currentStatePath = this.getStatePath(state.owner, state.repo, state.issueNumber);
		const currentSessionPath = this.getSessionPath(state.owner, state.repo, state.issueNumber);

		await mkdir(path.dirname(archiveStatePath), { recursive: true });
		await mkdir(path.dirname(archiveSessionPath), { recursive: true });

		try {
			await rename(currentStatePath, archiveStatePath);
		} catch {
			// state file may not exist; ignore
		}

		try {
			await rename(currentSessionPath, archiveSessionPath);
		} catch {
			// session file may not exist; ignore
		}

		const key = this.getSessionKey(state.owner, state.repo, state.issueNumber);
		this.sessions.delete(key);
	}
}
