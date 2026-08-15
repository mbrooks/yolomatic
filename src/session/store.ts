import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
 * Read-only preflight report for the file-backed session compatibility
 * retirement. `auditLegacyState()` never mutates on-disk files or SQLite rows;
 * it only reports what remains so operators can decide when to remove the
 * legacy data as a separate explicit operational step.
 */
export interface LegacyStateAudit {
	/** Absolute paths of readable `.state.json` files still on disk. */
	legacyStateFiles: string[];
	/** Session keys whose persisted state omits `kind` (not yet normalized). */
	sessionsMissingKind: string[];
	/** Legacy `.state.json` files that could not be parsed as JSON. */
	malformedStateFiles: string[];
	/** True when there is no remaining legacy data to clean up. */
	clean: boolean;
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
	private readonly listAllStateStmt: StatementSync;
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
		this.listAllStateStmt = this.db.prepare(
			"SELECT session_key, state_json FROM sessions ORDER BY session_key",
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

		// Legacy on-disk state/transcript files are intentionally NOT removed
		// here. Legacy-file deletion is a separate explicit operational step
		// (`removeLegacyStateFiles`) so it is never an automatic side effect of
		// a code deployment. SQLite is the source of truth.
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
		const currentSessionPath = this.getSessionPath(state.owner, state.repo, state.issueNumber, kind);

		await mkdir(path.dirname(archiveStatePath), { recursive: true });
		await mkdir(path.dirname(archiveSessionPath), { recursive: true });

		// Always write the archived state fresh from the SQLite source of truth.
		// The legacy on-disk `.state.json` file (if any) is left in place and is
		// NOT moved or deleted here; legacy-file deletion is a separate explicit
		// operational step. This keeps state archiving decoupled from legacy
		// state JSON lifecycle while preserving transcript archiving below.
		await writeFile(archiveStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

		// Transcript archiving remains intact: move the session transcript to
		// the archive directory when present.
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

	/**
	 * Read-only preflight/audit for the file-backed session compatibility
	 * retirement. Reports remaining legacy `.state.json` files on disk and
	 * persisted sessions whose `state_json` omits `kind`, without modifying
	 * anything. Malformed legacy files are reported separately and skipped so
	 * they cannot corrupt valid SQLite rows.
	 *
	 * Run this before retiring the compatibility importer and again before the
	 * explicit legacy-file deletion step.
	 */
	async auditLegacyState(): Promise<LegacyStateAudit> {
		const legacyStateFiles: string[] = [];
		const malformedStateFiles: string[] = [];

		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(this.sessionsDir, { withFileTypes: true });
		} catch {
			entries = [];
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
					JSON.parse(raw);
					legacyStateFiles.push(filePath);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[session-store] warning: malformed legacy state file ${filePath}: ${message}\n`);
					malformedStateFiles.push(filePath);
				}
			}
		}

		const sessionsMissingKind: string[] = [];
		const rows = this.listAllStateStmt.all() as Array<{ session_key: string; state_json: string }>;
		for (const row of rows) {
			let state: Record<string, unknown>;
			try {
				state = JSON.parse(row.state_json) as Record<string, unknown>;
			} catch {
				// Malformed SQLite rows are handled by the durable normalization
				// migration and recovery paths; they are not "missing kind".
				continue;
			}
			if (state.kind === undefined) {
				sessionsMissingKind.push(row.session_key);
			}
		}

		const clean =
			legacyStateFiles.length === 0 &&
			sessionsMissingKind.length === 0 &&
			malformedStateFiles.length === 0;
		return { legacyStateFiles, sessionsMissingKind, malformedStateFiles, clean };
	}

	/**
	 * Explicit operational step that removes the on-disk legacy `.state.json`
	 * and session transcript (`.jsonl`) files for a single session. This is
	 * decoupled from `delete()`/`archive()` so legacy-file deletion is never an
	 * automatic side effect of a code deployment. Idempotent when the files are
	 * already absent.
	 */
	async removeLegacyStateFiles(owner: string, repo: string, issueNumber: number, kind: SessionKind = "implementation"): Promise<void> {
		await this.silentRemove(this.getStatePath(owner, repo, issueNumber, kind));
		await this.silentRemove(this.getSessionPath(owner, repo, issueNumber, kind));
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

	private async silentRemove(p: string): Promise<void> {
		try {
			await rm(p, { force: true });
		} catch {
			// ignore
		}
	}
}
