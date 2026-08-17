/**
 * Onboarding wizard state shape, defaults, persistence, configuration
 * merging, and repository selection.
 *
 * Extracted from `OnboardingWizard.tsx` so the business logic lives in a
 * plain `.ts` module covered by the per-file guardrail. The wizard component
 * composes this state with presentation; it does not own these rules.
 */
import {
	isValidEventMode,
	parsePollIntervalMs,
} from "../../../domain/onboarding/policy.js";
import {
	isSecretField,
	type OnboardingConfig,
	type OnboardingSecretField,
} from "../../api/onboarding.js";

/** localStorage key persisting in-progress wizard state across reloads. */
export const STORAGE_KEY = "yolomatic-onboarding-wizard";

/** Number of steps in the wizard flow. */
export const TOTAL_STEPS = 5;

/** Default Ollama container name prefilled on the AI / LLM step. */
export const DEFAULT_OLLAMA_CONTAINER_NAME = "yolomatic-ollama";

/**
 * A repository rendered by the wizard's workspace-init step. Structurally
 * compatible with `RepoManager`'s `ManagedRepo`; duplicated here so this
 * browser-side module does not need to import a `.tsx` component.
 */
export interface ManagedRepo {
	owner: string;
	repo: string;
	fullName: string;
	selected: boolean;
	configured: boolean;
}

/** Shape of the wizard's in-progress state. */
export interface WizardState {
	step: number;
	adminFullName: string;
	adminUsername: string;
	adminPassword: string;
	adminPasswordProtected: boolean;
	githubToken: string;
	githubTokenProtected: boolean;
	githubUsername: string;
	githubUsernameConfirmed: boolean;
	githubEventMode: string;
	githubPollIntervalMs: string;
	webhookSecret: string;
	webhookSecretProtected: boolean;
	piAgentProvider: string;
	piAgentModel: string;
	ollamaContainerName: string;
	openaiApiKey: string;
	openaiApiKeyProtected: boolean;
	repositories: ManagedRepo[];
	error: string | null;
}

/** Updates a single wizard state field. */
export type UpdateField = <K extends keyof WizardState>(key: K, value: WizardState[K]) => void;

/** Generates a strong random password using the available WebCrypto source. */
export function generatePassword(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_+=";
	const array = new Uint8Array(24);
	globalThis.crypto.getRandomValues(array);
	let password = "";
	for (let i = 0; i < array.length; i++) {
		password += chars[array[i] % chars.length];
	}
	return password;
}

/** Returns the initial default wizard state before any configuration is applied. */
export function getDefaultState(): WizardState {
	return {
		step: 1,
		adminFullName: "Admin",
		adminUsername: "admin",
		adminPassword: generatePassword(),
		adminPasswordProtected: false,
		githubToken: "",
		githubTokenProtected: false,
		githubUsername: "",
		githubUsernameConfirmed: false,
		githubEventMode: "",
		githubPollIntervalMs: "",
		webhookSecret: "",
		webhookSecretProtected: false,
		piAgentProvider: "ollama",
		piAgentModel: "",
		ollamaContainerName: DEFAULT_OLLAMA_CONTAINER_NAME,
		openaiApiKey: "",
		openaiApiKeyProtected: false,
		repositories: [],
		error: null,
	};
}

/** Persists the in-progress wizard state to localStorage, ignoring write errors. */
export function saveState(state: WizardState): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// ignore
	}
}

/** Reads and parses persisted wizard state, or returns null when absent/invalid. */
export function readStoredState(): WizardState | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		return JSON.parse(raw) as WizardState;
	} catch {
		return null;
	}
}

/** Returns a lowercase `owner/repo` key used to deduplicate repositories. */
export function repoKey(owner: string, repo: string): string {
	return `${owner}/${repo}`.toLowerCase();
}

/**
 * Merges the accessible repositories returned by the API with the currently
 * configured repositories and the wizard's previous selection. Configured
 * repos that no longer appear in the accessible list are retained so the
 * operator can still deselect them.
 *
 * Pre-selection rules:
 * - A previous in-progress selection for a repo is always preserved.
 * - When no repositories have been previously configured (first run), every
 *   accessible repo is pre-selected so the operator can just click Finish.
 * - When repositories have already been configured (rerunning the wizard),
 *   only those configured repos are pre-selected; other accessible repos are
 *   left unchecked so the operator does not accidentally opt into new repos.
 */
export function mergeAccessibleRepos(
	accessible: Array<{ owner: string; repo: string; fullName: string }>,
	configured: Array<{ owner: string; repo: string }>,
	previous: ManagedRepo[],
): ManagedRepo[] {
	const configuredKeys = new Set(configured.map((r) => repoKey(r.owner, r.repo)));
	const previousByKey = new Map(previous.map((r) => [repoKey(r.owner, r.repo), r]));
	const hasAnyConfigured = configured.length > 0;
	const defaultSelected = (isConfigured: boolean): boolean =>
		hasAnyConfigured ? isConfigured : true;

	const merged: ManagedRepo[] = accessible.map((repo) => {
		const key = repoKey(repo.owner, repo.repo);
		const isConfigured = configuredKeys.has(key);
		const prev = previousByKey.get(key);
		return {
			owner: repo.owner,
			repo: repo.repo,
			fullName: repo.fullName,
			selected: prev ? prev.selected : defaultSelected(isConfigured),
			configured: isConfigured,
		};
	});

	const accessibleKeys = new Set(accessible.map((r) => repoKey(r.owner, r.repo)));
	for (const repo of configured) {
		const key = repoKey(repo.owner, repo.repo);
		if (accessibleKeys.has(key)) continue;
		const prev = previousByKey.get(key);
		merged.push({
			owner: repo.owner,
			repo: repo.repo,
			fullName: `${repo.owner}/${repo.repo}`,
			selected: prev ? prev.selected : defaultSelected(true),
			configured: true,
		});
	}

	merged.sort((a, b) => a.fullName.localeCompare(b.fullName));
	return merged;
}

/**
 * Applies the effective onboarding configuration to a default wizard state,
 * marking configured secrets as protected so the operator can preserve them
 * without re-entering them.
 */
export function applyConfig(state: WizardState, config: OnboardingConfig): void {
	const adminFullName = config.admin_full_name;
	if (typeof adminFullName === "string" && adminFullName.trim()) {
		state.adminFullName = adminFullName;
	}
	const adminUsername = config.admin_username;
	if (typeof adminUsername === "string" && adminUsername.trim()) {
		state.adminUsername = adminUsername;
	}
	if (isSecretField(config.admin_password) && config.admin_password.configured) {
		state.adminPassword = "";
		state.adminPasswordProtected = true;
	}
	if (isSecretField(config.github_token) && config.github_token.configured) {
		state.githubTokenProtected = true;
	}
	const githubUsername = config.github_username;
	if (typeof githubUsername === "string" && githubUsername.trim()) {
		state.githubUsername = githubUsername;
		state.githubUsernameConfirmed = true;
	}
	const eventMode = config.github_event_mode;
	if (typeof eventMode === "string" && isValidEventMode(eventMode)) {
		state.githubEventMode = eventMode;
	}
	const pollInterval = config.github_poll_interval_ms;
	if (typeof pollInterval === "string" && parsePollIntervalMs(pollInterval) !== null) {
		state.githubPollIntervalMs = pollInterval;
	}
	if (isSecretField(config.webhook_secret) && config.webhook_secret.configured) {
		state.webhookSecretProtected = true;
	}
	if (isSecretField(config.openai_api_key) && config.openai_api_key.configured) {
		state.openaiApiKeyProtected = true;
	}
	const provider = config.pi_agent_provider;
	if (typeof provider === "string" && provider.trim()) {
		state.piAgentProvider = provider.trim();
	}
	const model = config.pi_agent_model;
	if (typeof model === "string" && model.trim()) {
		state.piAgentModel = model.trim();
	}
	const container = config.ollama_container_name;
	if (typeof container === "string" && container.trim()) {
		state.ollamaContainerName = container.trim();
	}
}

/**
 * Overlays persisted in-progress state on top of the configuration-applied
 * base state, preserving protected flags from the session but unprotecting a
 * sensitive field once the operator has typed a replacement value.
 */
export function mergeStoredState(base: WizardState, stored: WizardState): WizardState {
	const merged: WizardState = { ...base, ...stored, error: null };
	if (stored.adminPassword && stored.adminPassword.length > 0) merged.adminPasswordProtected = false;
	if (stored.githubToken && stored.githubToken.length > 0) merged.githubTokenProtected = false;
	if (stored.webhookSecret && stored.webhookSecret.length > 0) merged.webhookSecretProtected = false;
	if (stored.openaiApiKey && stored.openaiApiKey.length > 0) merged.openaiApiKeyProtected = false;
	return merged;
}

/**
 * Builds the initial wizard state by layering the effective configuration
 * over the defaults, then overlaying any in-progress wizard state from
 * localStorage so the operator does not lose unsaved edits on reload.
 */
export function buildInitialState(config: OnboardingConfig | null): WizardState {
	const base = getDefaultState();
	if (config) {
		applyConfig(base, config);
	}
	const stored = readStoredState();
	if (!stored) return base;
	return mergeStoredState(base, stored);
}

/** Re-exported for callers that need to inspect secret-field values. */
export type { OnboardingSecretField };