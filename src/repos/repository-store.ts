import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { runMigrations } from "../migrations/index.js";
import {
	repoKey,
	type RepoGitHubEventMode,
	type Repository,
	type RepositoryInput,
	type RepositoryVisibility,
} from "./repository.js";

function rowToRepository(row: Record<string, unknown>): Repository {
	return {
		id: String(row.id),
		owner: String(row.owner),
		repo: String(row.repo),
		fullName: row.full_name == null ? null : String(row.full_name),
		visibility: (row.visibility == null ? null : String(row.visibility)) as RepositoryVisibility | null,
		githubEventMode: (row.github_event_mode == null
			? null
			: String(row.github_event_mode)) as RepoGitHubEventMode | null,
		defaultBranch: row.default_branch == null ? null : String(row.default_branch),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

export class RepositoryStore {
	private readonly db: DatabaseSync;
	private readonly upsertStmt: StatementSync;
	private readonly getStmt: StatementSync;
	private readonly deleteStmt: StatementSync;
	private readonly listStmt: StatementSync;
	private readonly listForPollingStmt: StatementSync;

	public constructor(dbPath: string) {
		mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		runMigrations(this.db);

		this.upsertStmt = this.db.prepare(
			`INSERT INTO repositories (id, owner, repo, full_name, visibility, github_event_mode, default_branch, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(owner, repo) DO UPDATE SET
			 full_name=excluded.full_name,
			 visibility=excluded.visibility,
			 github_event_mode=excluded.github_event_mode,
			 default_branch=excluded.default_branch,
			 updated_at=excluded.updated_at`,
		);
		this.getStmt = this.db.prepare(
			"SELECT * FROM repositories WHERE owner = ? AND repo = ?",
		);
		this.deleteStmt = this.db.prepare(
			"DELETE FROM repositories WHERE owner = ? AND repo = ?",
		);
		this.listStmt = this.db.prepare(
			"SELECT * FROM repositories ORDER BY owner ASC, repo ASC",
		);
		this.listForPollingStmt = this.db.prepare(
			`SELECT * FROM repositories
			 WHERE github_event_mode IS NULL OR github_event_mode IN ('polling', 'both')
			 ORDER BY owner ASC, repo ASC`,
		);
	}

	async list(): Promise<Repository[]> {
		return this.listSync();
	}

	listSync(): Repository[] {
		const rows = this.listStmt.all() as Array<Record<string, unknown>>;
		return rows.map(rowToRepository);
	}

	async get(owner: string, repo: string): Promise<Repository | null> {
		return this.getSync(owner, repo);
	}

	getSync(owner: string, repo: string): Repository | null {
		const row = this.getStmt.get(owner, repo) as Record<string, unknown> | undefined;
		if (!row) return null;
		return rowToRepository(row);
	}

	async upsert(input: RepositoryInput): Promise<Repository> {
		return this.upsertSync(input);
	}

	upsertSync(input: RepositoryInput): Repository {
		const owner = input.owner.trim();
		const repo = input.repo.trim();
		if (!owner || !repo) {
			throw new Error("owner and repo are required");
		}
		const id = repoKey(owner, repo);
		const now = new Date().toISOString();
		this.upsertStmt.run(
			id,
			owner,
			repo,
			input.fullName ?? null,
			input.visibility ?? null,
			input.githubEventMode ?? null,
			input.defaultBranch ?? null,
			now,
			now,
		);
		const result = this.getSync(owner, repo);
		if (!result) {
			throw new Error(`Failed to upsert repository ${owner}/${repo}`);
		}
		return result;
	}

	async remove(owner: string, repo: string): Promise<boolean> {
		return this.removeSync(owner, repo);
	}

	removeSync(owner: string, repo: string): boolean {
		const existing = this.getSync(owner, repo);
		if (!existing) return false;
		this.deleteStmt.run(owner, repo);
		return true;
	}

	/**
	 * Returns repositories whose effective event mode could include polling:
	 * repos with an explicit `polling`/`both` override, plus repos that inherit
	 * the global mode (null override). Callers must still apply the global
	 * mode to inherited entries to decide whether to actually poll.
	 */
	async listForPolling(): Promise<Repository[]> {
		const rows = this.listForPollingStmt.all() as Array<Record<string, unknown>>;
		return rows.map(rowToRepository);
	}

	close(): void {
		this.db.close();
	}
}