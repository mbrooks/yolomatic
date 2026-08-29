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
	issueNewCommentEnabled?: boolean | null;
	issueAdminLinkInCommentsEnabled?: boolean | null;
	/**
	 * Per-repository build-model override (`PI_AGENT_MODEL` for build sessions).
	 * Null inherits the global model; a slash-form value (provider/model) may
	 * target a different provider than the global one. Issue refinement
	 * sessions never consult this value — they always run the global model.
	 */
	piAgentBuildModel?: string | null;
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
	issueNewCommentEnabled?: boolean | null;
	issueAdminLinkInCommentsEnabled?: boolean | null;
	piAgentBuildModel?: string | null;
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

/**
 * Resolve a repository's build-model override, or `undefined` when unset or
 * blank so the caller inherits the global model. A slash-form value
 * (`provider/model`) may select a model from a provider other than the
 * instance's global provider.
 */
export function resolveRepoBuildModelOverride(
	repository: Pick<Repository, "piAgentBuildModel"> | null | undefined,
): string | undefined {
	return repository?.piAgentBuildModel?.trim() || undefined;
}

/** Provider ids the repository build-model selector understands. */
export const BUILD_MODEL_PROVIDERS = ["ollama", "openai"] as const;

export type BuildModelProvider = (typeof BUILD_MODEL_PROVIDERS)[number];

/** Decomposed parts of a per-repo build-model override for the provider-aware dropdown UI. */
export interface ParsedRepoBuildModel {
	/** Selected provider; empty means inherit the global provider (bare model form). */
	provider: BuildModelProvider | "";
	/** Model identifier without the provider prefix; empty means inherit the global model. */
	model: string;
}

/**
 * Split a stored build-model override into its provider and model parts for
 * the repository settings dropdowns.
 *
 * Only the supported `ollama/` and `openai/` prefixes are decomposed into a
 * provider selection; every other value (a bare id, or a namespaced Ollama
 * identifier like `qwen/qwen3:30b`) stays a whole model id resolved within
 * the global provider, mirroring how `resolveConfiguredModel` first matches
 * registered models before falling back to slash parsing.
 */
export function parseRepoBuildModelOverride(value: string | null | undefined): ParsedRepoBuildModel {
	const trimmed = value?.trim() ?? "";
	for (const provider of BUILD_MODEL_PROVIDERS) {
		if (trimmed.startsWith(`${provider}/`)) {
			return { provider, model: trimmed.slice(provider.length + 1).trim() };
		}
	}
	return { provider: "", model: trimmed };
}

/**
 * Compose the persisted build-model override from the selected provider and
 * model: blank parts inherit the global build model (`""`), a model without a
 * provider composes the bare id form (resolved within the global provider),
 * and an explicit provider composes the `provider/model` slash form. A
 * provider pick without a model is not representable in the stored value, so
 * it composes an inherit-all value.
 */
export function composeRepoBuildModelOverride(provider: string, model: string): string {
	const trimmedModel = model.trim();
	if (!trimmedModel) return "";
	const trimmedProvider = provider.trim();
	return trimmedProvider ? `${trimmedProvider}/${trimmedModel}` : trimmedModel;
}

/** Resolve a repository's worker template, falling back to the server default. */
export function resolveRepoWorkerTemplate(
	repository: Pick<Repository, "workerTemplate"> | null | undefined,
	defaultTemplate: string,
): string {
	return repository?.workerTemplate ?? defaultTemplate;
}

/**
 * Resolve the effective `issue_new_comment_enabled` for a repository, falling
 * back to the global value when no per-repo override is set.
 */
export function resolveRepoIssueNewCommentEnabled(
	repository: Pick<Repository, "issueNewCommentEnabled"> | null | undefined,
	globalValue: boolean,
): boolean {
	return repository?.issueNewCommentEnabled ?? globalValue;
}

/**
 * Resolve the effective `issue_admin_link_in_comments_enabled` for a
 * repository, falling back to the global value when no per-repo override is
 * set.
 */
export function resolveRepoIssueAdminLinkInCommentsEnabled(
	repository: Pick<Repository, "issueAdminLinkInCommentsEnabled"> | null | undefined,
	globalValue: boolean,
): boolean {
	return repository?.issueAdminLinkInCommentsEnabled ?? globalValue;
}

/**
 * Normalize a per-repo boolean override body value into `true`/`false`/`null`.
 * Accepts actual booleans and the strings "true"/"false" (case-insensitive,
 * trimmed). Empty/whitespace strings and unknown values resolve to `null`,
 * which clears the override and returns the repository to inheriting the
 * global default.
 */
export function normalizeRepoBooleanOverride(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "") return null;
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	return null;
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
