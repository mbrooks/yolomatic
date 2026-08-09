import { DatabaseSync, type StatementSync } from "node:sqlite";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runMigrations } from "../migrations/index.js";

export type SessionStatus = "pending" | "working" | "waiting-feedback" | "paused" | "complete" | "failed" | "cancelled";
export type SessionKind = "implementation" | "refinement";

export function sessionStorageKey(owner: string, repo: string, issueNumber: number, kind: SessionKind): string {
	return `github-${owner}-${repo}-issue-${issueNumber}-${kind}`;
}

export const TERMINAL_STATUSES: readonly SessionStatus[] = ["complete", "failed", "cancelled"];

export function isTerminalStatus(status: SessionStatus): boolean {
	return TERMINAL_STATUSES.includes(status);
}

export interface SessionState {
	/** Omitted by legacy persisted sessions; readers normalize it to implementation. */
	kind?: SessionKind;
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
	/** Overrides the default `${repo}-issue-${issueNumber}` log tag */
	sessionTag?: string;
	/** Branch associated with this session. Defaults to `yolomatic/issue-${issueNumber}` for issues. */
	branch?: string;
	/** ISO timestamp when the current/latest task execution started. */
	taskStartedAt?: string;
	/** ISO timestamp when the current/latest task execution finished. */
	taskFinishedAt?: string;
	/** Cumulative time spent executing tasks across all iterations, in milliseconds. */
	totalExecutionTimeMs?: number;
}

/**
 * In-memory cache of the most recently written state for a session key.
 * SQLite is the source of truth; the cache only avoids redundant round-trips
 * for the read-modify-write cycles the session manager issues.
 */
interface CacheEntry {
	state: SessionState;
	archived: boolean;
}

export class SessionStore {
	private readonly db: DatabaseSync;
	private readonly upsertStmt: StatementSync;
	private readonly getStmt: StatementSync;
	private readonly getArchivedStmt: StatementSync;
	private readonly deleteStmt: StatementSync;
	private readonly listActiveStmt: StatementSync;
	private readonly cache = new Map<string, CacheEntry>();
	private migrated = false;

	public constructor(
		dbPath: string,
		private readonly sessionsDir: string,
	) {
		mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		runMigrations(this.db);

		this.getStmt = this.db.prepare("SELECT state_json, archived_at FROM sessions WHERE session_key = ?");
		this.getArchivedStmt = this.db.prepare("SELECT state_json FROM sessions WHERE session_key = ?");
		this.upsertStmt = this.db.prepare(
			`INSERT INTO sessions (session_key, owner, repo, issue_number, status, archived_at, state_json, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(session_key) DO UPDATE SET
			   owner=excluded.owner,
			   repo=excluded.repo,
			   issue_number=excluded.issue_number,
			   status=excluded.status,
			   archived_at=excluded.archived_at,
			   state_json=excluded.state_json,
			   updated_at=excluded.updated_at`,
		);
		this.deleteStmt = this.db.prepare("DELETE FROM sessions WHERE session_key = ?");
		this.listActiveStmt = this.db.prepare(
			"SELECT state_json FROM sessions WHERE archived_at IS NULL ORDER BY updated_at",
		);
	}

	getSessionKey(owner: string, repo: string, issueNumber: number, kind: SessionKind = "implementation"): string {
		return sessionStorageKey(owner, repo, issueNumber, kind);
	}

	getSessionPath(owner: string, repo: string, issueNumber: number, kind: SessionKind = "implementation"): string {
		const suffix = kind === "implementation" ? "" : `-${kind}`;
		return path.join(this.sessionsDir, `github-${owner}-${repo}`, `issue-${issueNumber}${suffix}.jsonl`);
	}

	getStatePath(owner: string, repo: string, issueNumber: number, kind: SessionKind = "implementation"): string {
		const suffix = kind === "implementation" ? "" : `-${kind}`;
		return path.join(this.sessionsDir, `github-${owner}-${repo}`, `issue-${issueNumber}${suffix}.state.json`);
	}

	getArchivePath(archiveDir: string, owner: string, repo: string, issueNumber: number, kind: SessionKind = "implementation"): string {
		const suffix = kind === "implementation" ? "" : `-${kind}`;
		return path.join(archiveDir, `github-${owner}-${repo}`, `issue-${issueNumber}${suffix}.state.json`);
	}

	getSessionArchivePath(archiveDir: string, owner: string, repo: string, issueNumber: number, kind: SessionKind = "implementation"): string {
		const suffix = kind === "implementation" ? "" : `-${kind}`;
		return path.join(archiveDir, `github-${owner}-${repo}`, `issue-${issueNumber}${suffix}.jsonl`);
	}

	async get(owner: string, repo: string, issueNumber: number, kind: SessionKind = "implementation"): Promise<SessionState | null> {
		const key = this.getSessionKey(owner, repo, issueNumber, kind);
		const cached = this.cache.get(key);
		if (cached && !cached.archived) {
			return cached.state;
		}

		const row = this.getStmt.get(key) as { state_json: string; archived_at: string | null } | undefined;
		if (!row || row.archived_at) {
			return null;
		}
		const state = this.parseState(row.state_json, key);
		if (state) {
			this.cache.set(key, { state, archived: false });
		}
		return state;
	}

	async set(state: SessionState): Promise<SessionState> {
		const normalizedState: SessionState = { ...state, kind: state.kind ?? "implementation" };
		const key = this.getSessionKey(normalizedState.owner, normalizedState.repo, normalizedState.issueNumber, normalizedState.kind!);
		const stateJson = JSON.stringify(normalizedState, null, 2);
		this.upsertStmt.run(
			key,
			normalizedState.owner,
			normalizedState.repo,
			normalizedState.issueNumber,
			normalizedState.status,
			normalizedState.archivedAt ?? null,
			stateJson,
			new Date().toISOString(),
		);
		this.cache.set(key, { state: normalizedState, archived: !!normalizedState.archivedAt });
		return normalizedState;
	}

	async exists(owner: string, repo: string, issueNumber: number, kind: SessionKind = "implementation"): Promise<boolean> {
		const key = this.getSessionKey(owner, repo, issueNumber, kind);
		const cached = this.cache.get(key);
		if (cached && !cached.archived) {
			return true;
		}
		const row = this.getStmt.get(key) as { archived_at: string | null } | undefined;
		return !!row && !row.archived_at;
	}

	async delete(owner: string, repo: string, issueNumber: number, kind: SessionKind = "implementation"): Promise<void> {
		const key = this.getSessionKey(owner, repo, issueNumber, kind);
		this.cache.delete(key);
		this.deleteStmt.run(key);

		// Remove any legacy on-disk state/transcript files too (idempotent).
		const statePath = this.getStatePath(owner, repo, issueNumber, kind);
		const sessionPath = this.getSessionPath(owner, repo, issueNumber, kind);
		await this.silentRemove(statePath);
		await this.silentRemove(sessionPath);
	}

	async getAll(): Promise<SessionState[]> {
		const rows = this.listActiveStmt.all() as Array<{ state_json: string }>;
		const sessions: SessionState[] = [];
		for (const row of rows) {
			const state = this.parseState(row.state_json);
			if (state) {
				sessions.push(state);
			}
		}
		return sessions;
	}

	async archive(state: SessionState, archiveDir: string): Promise<void> {
		const kind = state.kind ?? "implementation";
		const archiveStatePath = this.getArchivePath(archiveDir, state.owner, state.repo, state.issueNumber, kind);
		const archiveSessionPath = this.getSessionArchivePath(archiveDir, state.owner, state.repo, state.issueNumber, kind);
		const currentStatePath = this.getStatePath(state.owner, state.repo, state.issueNumber, kind);
		const currentSessionPath = this.getSessionPath(state.owner, state.repo, state.issueNumber, kind);

		await mkdir(path.dirname(archiveStatePath), { recursive: true });
		await mkdir(path.dirname(archiveSessionPath), { recursive: true });

		// Move any legacy on-disk state file to the archive; otherwise write the
		// current SQLite state out so archived sessions remain queryable on disk.
		const legacyStateExists = await this.pathExists(currentStatePath);
		if (legacyStateExists) {
			try {
				await rename(currentStatePath, archiveStatePath);
			} catch {
				// fall back to writing fresh below if rename fails
				await writeFile(archiveStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
			}
		} else {
			await writeFile(archiveStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		}

		try {
			await rename(currentSessionPath, archiveSessionPath);
		} catch {
			// session transcript may not exist (e.g. never started); ignore
		}

		const key = this.getSessionKey(state.owner, state.repo, state.issueNumber, kind);
		this.deleteStmt.run(key);
		this.cache.delete(key);
	}

	/**
	 * One-time migration of any pre-existing file-backed sessions into SQLite.
	 * Safe to call on every boot: existing rows are left untouched, and on-disk
	 * files are preserved (not deleted) so a rollback can re-read them.
	 *
	 * Returns the number of sessions imported.
	 */
	async migrateFromFileStoreIfNeeded(): Promise<number> {
		if (this.migrated) return 0;
		this.migrated = true;

		let imported = 0;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(this.sessionsDir, { withFileTypes: true });
		} catch {
			return 0;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const repoDir = path.join(this.sessionsDir, entry.name);
			let files: string[];
			try {
				files = await readdir(repoDir);
			} catch {
				continue;
			}
			for (const file of files) {
				if (!file.endsWith(".state.json")) continue;
				const filePath = path.join(repoDir, file);
				try {
					const raw = await readFile(filePath, "utf8");
					const parsed = this.normalizeState(JSON.parse(raw) as SessionState);
					if (!parsed || typeof parsed.owner !== "string" || typeof parsed.repo !== "string" || typeof parsed.issueNumber !== "number") {
						continue;
					}
					const key = this.getSessionKey(parsed.owner, parsed.repo, parsed.issueNumber, parsed.kind!);
					const existing = this.getStmt.get(key) as { session_key: string } | undefined;
					if (existing) {
						// Already in SQLite; leave the file in place as a compatibility copy.
						continue;
					}
					const now = new Date().toISOString();
					this.upsertStmt.run(
						key,
						parsed.owner,
						parsed.repo,
						parsed.issueNumber,
						parsed.status ?? "pending",
						parsed.archivedAt ?? null,
						JSON.stringify(parsed, null, 2),
						now,
					);
					imported++;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[session-store] warning: invalid state file ${filePath}: ${message}\n`);
				}
			}
		}
		return imported;
	}

	private parseState(raw: string, key?: string): SessionState | null {
		try {
			return this.normalizeState(JSON.parse(raw) as SessionState);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[session-store] warning: invalid state row ${key ?? ""}: ${message}\n`);
			return null;
		}
	}

	private normalizeState(state: SessionState): SessionState {
		return { ...state, kind: state.kind ?? "implementation" };
	}

	private async pathExists(p: string): Promise<boolean> {
		try {
			await access(p);
			return true;
		} catch {
			return false;
		}
	}

	private async silentRemove(p: string): Promise<void> {
		try {
			await rm(p, { force: true });
		} catch {
			// ignore
		}
	}
}
