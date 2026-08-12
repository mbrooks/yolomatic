import type { RepoVisibility } from "../ports/github-service.js";

export type RepoGitHubEventMode = "webhook" | "polling" | "both";

export type RepositoryVisibility = RepoVisibility;

/**
 * A repository managed by Yolomatic, persisted in the `repositories` SQLite table.
 *
 * `githubEventMode` and `defaultBranch` are nullable per-repo overrides; when
 * null the value is inherited from the global settings.
 */
export interface Repository {
	id: string;
	owner: string;
	repo: string;
	fullName: string | null;
	visibility: RepositoryVisibility | null;
	githubEventMode: RepoGitHubEventMode | null;
	defaultBranch: string | null;
	workerTemplate?: string | null;
	createdAt: string;
	updatedAt: string;
}

export type RepositoryInput = {
	owner: string;
	repo: string;
	fullName?: string | null;
	visibility?: RepositoryVisibility | null;
	githubEventMode?: RepoGitHubEventMode | null;
	defaultBranch?: string | null;
	workerTemplate?: string | null;
};

export function repoModeIncludesWebhook(mode: RepoGitHubEventMode): boolean {
	return mode === "webhook" || mode === "both";
}

export function repoModeIncludesPolling(mode: RepoGitHubEventMode): boolean {
	return mode === "polling" || mode === "both";
}

/**
 * Resolve the effective GitHub event mode for a repository, falling back to
 * the global mode when no per-repo override is set.
 */
export function resolveRepoGitHubEventMode(
	repository: Repository | null | undefined,
	globalMode: RepoGitHubEventMode,
): RepoGitHubEventMode {
	return repository?.githubEventMode ?? globalMode;
}

/**
 * Resolve the effective default branch for a repository, falling back to the
 * global default when no per-repo override is set.
 */
export function resolveRepoDefaultBranch(
	repository: Repository | null | undefined,
	globalDefaultBranch: string,
): string {
	return repository?.defaultBranch ?? globalDefaultBranch;
}

/** Resolve a repository's worker template, falling back to the server default. */
export function resolveRepoWorkerTemplate(
	repository: Pick<Repository, "workerTemplate"> | null | undefined,
	defaultTemplate: string,
): string {
	return repository?.workerTemplate ?? defaultTemplate;
}

export function normalizeRepoGitHubEventMode(value: unknown): RepoGitHubEventMode | null {
	if (typeof value !== "string") return null;
	const mode = value.trim().toLowerCase();
	if (mode === "webhook" || mode === "polling" || mode === "both") return mode;
	return null;
}

export function repoKey(owner: string, repo: string): string {
	return `${owner}/${repo}`.toLowerCase();
}
