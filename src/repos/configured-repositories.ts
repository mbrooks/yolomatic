export type RepoGitHubEventMode = "webhook" | "polling" | "both";

export interface ConfiguredRepositorySettings {
	github_event_mode?: RepoGitHubEventMode;
	default_branch?: string;
}

export interface ConfiguredRepository {
	owner: string;
	repo: string;
	settings?: ConfiguredRepositorySettings;
}

function normalizeString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeGithubEventMode(value: unknown): RepoGitHubEventMode | undefined {
	const normalized = normalizeString(value).toLowerCase();
	if (normalized === "webhook" || normalized === "polling" || normalized === "both") {
		return normalized;
	}
	return undefined;
}

function normalizeDefaultBranch(value: unknown): string | undefined {
	const branch = normalizeString(value);
	return branch || undefined;
}

function normalizeSettings(value: unknown): ConfiguredRepositorySettings | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const githubEventMode = normalizeGithubEventMode(
		"value" in value && typeof value.value === "string"
			? value.value
			: "github_event_mode" in value
				? (value as Record<string, unknown>).github_event_mode
				: undefined,
	);
	const defaultBranch = normalizeDefaultBranch(
		"value" in value && typeof value.value === "string"
			? value.value
			: "default_branch" in value
				? (value as Record<string, unknown>).default_branch
				: undefined,
	);
	const settings: ConfiguredRepositorySettings = {};
	if (githubEventMode) {
		settings.github_event_mode = githubEventMode;
	}
	if (defaultBranch) {
		settings.default_branch = defaultBranch;
	}
	return Object.keys(settings).length > 0 ? settings : undefined;
}

export function parseConfiguredRepositories(raw: string | undefined): ConfiguredRepository[] {
	if (!raw?.trim()) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}
		const repos: ConfiguredRepository[] = [];
		const seen = new Set<string>();
		for (const item of parsed) {
			if (!item || typeof item !== "object") {
				continue;
			}
			const owner = "owner" in item ? normalizeString(item.owner) : "";
			const repo = "repo" in item ? normalizeString(item.repo) : "";
			if (!owner || !repo) {
				continue;
			}
			const key = `${owner}/${repo}`.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			const settings = "settings" in item ? normalizeSettings(item.settings) : undefined;
			repos.push(settings ? { owner, repo, settings } : { owner, repo });
		}
		return repos;
	} catch {
		return [];
	}
}

export function stringifyConfiguredRepositories(repos: ConfiguredRepository[]): string {
	return JSON.stringify(
		repos.map((repo) => ({
			owner: repo.owner,
			repo: repo.repo,
			...(repo.settings ? { settings: repo.settings } : {}),
		})),
	);
}

export function upsertConfiguredRepository(
	repositories: ConfiguredRepository[],
	repository: ConfiguredRepository,
): ConfiguredRepository[] {
	const next = [...repositories];
	const key = `${repository.owner}/${repository.repo}`.toLowerCase();
	const index = next.findIndex((repo) => `${repo.owner}/${repo.repo}`.toLowerCase() === key);
	if (index >= 0) {
		next[index] = repository.settings ? { ...repository, settings: repository.settings } : { owner: repository.owner, repo: repository.repo };
		return next;
	}
	next.push(repository.settings ? { ...repository, settings: repository.settings } : { owner: repository.owner, repo: repository.repo });
	return next;
}

export function findConfiguredRepository(
	repositories: ConfiguredRepository[],
	owner: string,
	repo: string,
): ConfiguredRepository | undefined {
	const key = `${owner}/${repo}`.toLowerCase();
	return repositories.find((entry) => `${entry.owner}/${entry.repo}`.toLowerCase() === key);
}

export function removeConfiguredRepository(
	repositories: ConfiguredRepository[],
	owner: string,
	repo: string,
): ConfiguredRepository[] {
	const key = `${owner}/${repo}`.toLowerCase();
	return repositories.filter((entry) => `${entry.owner}/${entry.repo}`.toLowerCase() !== key);
}

export function resolveConfiguredRepoDefaultBranch(
	repositories: ConfiguredRepository[],
	owner: string,
	repo: string,
	globalDefaultBranch: string,
): string {
	return findConfiguredRepository(repositories, owner, repo)?.settings?.default_branch ?? globalDefaultBranch;
}

export function resolveConfiguredRepoGitHubEventMode(
	repositories: ConfiguredRepository[],
	owner: string,
	repo: string,
	globalMode: RepoGitHubEventMode,
): RepoGitHubEventMode {
	return findConfiguredRepository(repositories, owner, repo)?.settings?.github_event_mode ?? globalMode;
}

export function repoModeIncludesWebhook(mode: RepoGitHubEventMode): boolean {
	return mode === "webhook" || mode === "both";
}

export function repoModeIncludesPolling(mode: RepoGitHubEventMode): boolean {
	return mode === "polling" || mode === "both";
}
