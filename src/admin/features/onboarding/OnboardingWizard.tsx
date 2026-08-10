import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	submitOnboarding,
	verifyGitHubToken,
	generateWebhookSecret,
	listAccessibleRepositories,
	initializeWorkspaces,
	fetchOnboardingConfig,
	fetchOnboardingOllamaSignInStatus,
	isSecretField,
	type OnboardingConfig,
	type OnboardingSecretField,
} from "../../api/onboarding.js";
import { Modal } from "../../components/Modal.js";
import { RepoManager, type ManagedRepo } from "../repos/RepoManager.js";
import { OllamaSignInPanel } from "../settings/OllamaSignInPanel.js";

export type GithubEventMode = "webhook" | "polling" | "both";

interface WizardState {
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

const STORAGE_KEY = "yolomatic-onboarding-wizard";
const TOTAL_STEPS = 5;

export const LLM_PROVIDER_OPTIONS: readonly string[] = ["ollama", "openai"];
export const DEFAULT_OLLAMA_CONTAINER_NAME = "yolomatic-ollama";

export const EVENT_MODE_OPTIONS: readonly GithubEventMode[] = ["webhook", "polling", "both"];
export const MIN_POLL_INTERVAL_MS = 1000;
export const DEFAULT_POLL_INTERVAL_MS = 60000;

export function isPollingMode(mode: string): boolean {
	return mode === "polling" || mode === "both";
}

export function isWebhookMode(mode: string): boolean {
	return mode === "webhook" || mode === "both";
}

export function isValidEventMode(mode: string): boolean {
	return (EVENT_MODE_OPTIONS as readonly string[]).includes(mode);
}

/**
 * Parses a polling interval string into a positive integer of at least
 * MIN_POLL_INTERVAL_MS, or returns null when the value is empty or invalid.
 */
export function parsePollIntervalMs(raw: string): number | null {
	const trimmed = raw.trim();
	if (!/^[0-9]+$/.test(trimmed)) {
		return null;
	}
	const value = Number.parseInt(trimmed, 10);
	if (!Number.isInteger(value) || value < MIN_POLL_INTERVAL_MS) {
		return null;
	}
	return value;
}

function repoKey(owner: string, repo: string): string {
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
function mergeAccessibleRepos(
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

function generatePassword(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_+=";
	const array = new Uint8Array(24);
	window.crypto.getRandomValues(array);
	let password = "";
	for (let i = 0; i < array.length; i++) {
		password += chars[array[i] % chars.length];
	}
	return password;
}

function saveState(state: WizardState): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// ignore
	}
}

function getDefaultState(): WizardState {
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

function readStoredState(): WizardState | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		return JSON.parse(raw) as WizardState;
	} catch {
		return null;
	}
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

function applyConfig(state: WizardState, config: OnboardingConfig): void {
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

function mergeStoredState(base: WizardState, stored: WizardState): WizardState {
	const merged: WizardState = { ...base, ...stored, error: null };
	// Preserve protected flags from the in-progress session, but unprotect a
	// sensitive field once the operator has typed a replacement value.
	if (stored.adminPassword && stored.adminPassword.length > 0) merged.adminPasswordProtected = false;
	if (stored.githubToken && stored.githubToken.length > 0) merged.githubTokenProtected = false;
	if (stored.webhookSecret && stored.webhookSecret.length > 0) merged.webhookSecretProtected = false;
	if (stored.openaiApiKey && stored.openaiApiKey.length > 0) merged.openaiApiKeyProtected = false;
	return merged;
}

export function OnboardingWizard({ onComplete }: { onComplete?: () => void }): React.ReactElement {
	const [state, setState] = useState<WizardState>(getDefaultState);
	const [configLoading, setConfigLoading] = useState(true);
	const [configError, setConfigError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [done, setDone] = useState(false);

	useEffect(() => {
		let cancelled = false;
		fetchOnboardingConfig()
			.then((config) => {
				if (cancelled) return;
				setState(buildInitialState(config));
				setConfigLoading(false);
			})
			.catch((err) => {
				if (cancelled) return;
				setConfigError(err instanceof Error ? err.message : String(err));
				setState(buildInitialState(null));
				setConfigLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!configLoading) saveState(state);
	}, [state, configLoading]);

	const setError = useCallback((error: string | null) => {
		setState((prev) => ({ ...prev, error }));
	}, []);

	const goToStep = useCallback((step: number) => {
		setState((prev) => ({ ...prev, step: Math.max(1, Math.min(TOTAL_STEPS, step)), error: null }));
	}, []);

	const updateField = useCallback(<K extends keyof WizardState>(key: K, value: WizardState[K]) => {
		setState((prev) => ({ ...prev, [key]: value, error: null }));
	}, []);

	const handleVerifyToken = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await verifyGitHubToken(state.githubToken.trim());
			setState((prev) => ({ ...prev, githubUsername: result.username, githubUsernameConfirmed: true }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [state.githubToken, setError]);

	const handleGenerateSecret = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await generateWebhookSecret();
			setState((prev) => ({ ...prev, webhookSecret: result.secret }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [setError]);

	const hasAutoGeneratedSecretRef = useRef(false);

	useEffect(() => {
		if (
			state.step === 3 &&
			isWebhookMode(state.githubEventMode) &&
			!state.webhookSecret &&
			!state.webhookSecretProtected &&
			!loading &&
			!hasAutoGeneratedSecretRef.current
		) {
			hasAutoGeneratedSecretRef.current = true;
			handleGenerateSecret();
		}
	}, [state.step, state.githubEventMode, state.webhookSecret, state.webhookSecretProtected, loading, handleGenerateSecret]);

	const handleFetchRepos = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await listAccessibleRepositories(state.githubToken.trim());
			setState((prev) => ({
				...prev,
				repositories: mergeAccessibleRepos(
					result.repositories,
					result.configured ?? [],
					prev.repositories,
				),
			}));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [state.githubToken, setError]);

	const toggleRepo = useCallback((index: number) => {
		setState((prev) => {
			const repos = [...prev.repositories];
			repos[index] = { ...repos[index], selected: !repos[index].selected };
			return { ...prev, repositories: repos };
		});
	}, []);

	const setAllReposSelected = useCallback((selected: boolean) => {
		setState((prev) => ({
			...prev,
			repositories: prev.repositories.map((repo) => ({ ...repo, selected })),
		}));
	}, []);

	const hasAutoFetchedReposRef = useRef(false);

	useEffect(() => {
		// Auto-load the repository list when the operator reaches step 5 so they
		// do not have to click Fetch. Only runs once per mount and only when a
		// GitHub token is available (entered or already configured).
		const hasToken = state.githubToken.trim().length > 0 || state.githubTokenProtected;
		if (
			state.step === 5 &&
			hasToken &&
			state.repositories.length === 0 &&
			!loading &&
			!hasAutoFetchedReposRef.current
		) {
			hasAutoFetchedReposRef.current = true;
			void handleFetchRepos();
		}
	}, [state.step, state.githubToken, state.githubTokenProtected, state.repositories, loading, handleFetchRepos]);

	const handleFinish = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const selectedRepos = state.repositories.filter((r) => r.selected);
			const canInitWorkspaces = state.githubToken.trim().length > 0 || state.githubTokenProtected;
			if (canInitWorkspaces && selectedRepos.length > 0) {
				await initializeWorkspaces({
					token: state.githubToken.trim(),
					username: state.githubUsername.trim(),
					repos: selectedRepos.map((r) => ({ owner: r.owner, repo: r.repo })),
				});
			}

			const onboardingBody: Record<string, string> = {
				github_token: state.githubToken.trim(),
				github_username: state.githubUsername.trim(),
				admin_full_name: state.adminFullName.trim(),
				admin_username: state.adminUsername.trim(),
				admin_password: state.adminPassword.trim(),
				github_event_mode: state.githubEventMode,
			};
			if (isWebhookMode(state.githubEventMode)) {
				onboardingBody.webhook_secret = state.webhookSecret.trim();
			}
			if (isPollingMode(state.githubEventMode)) {
				const interval = parsePollIntervalMs(state.githubPollIntervalMs);
				if (interval !== null) {
					onboardingBody.github_poll_interval_ms = String(interval);
				}
			}
			onboardingBody.pi_agent_provider = state.piAgentProvider.trim();
			onboardingBody.pi_agent_model = state.piAgentModel.trim();
			onboardingBody.ollama_container_name = state.ollamaContainerName.trim();
			onboardingBody.openai_api_key = state.openaiApiKey.trim();
			await submitOnboarding(onboardingBody);

			localStorage.removeItem(STORAGE_KEY);
			setDone(true);
			onComplete?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setLoading(false);
		}
	}, [state, onComplete]);

	const handleCancel = useCallback(() => {
		if (confirm("Are you sure you want to cancel the onboarding? Your progress will be lost.")) {
			localStorage.removeItem(STORAGE_KEY);
			window.location.reload();
		}
	}, []);

	const canGoNext = useMemo(() => {
		switch (state.step) {
			case 1:
				return state.adminFullName.trim().length > 0 && state.adminUsername.trim().length > 0 && (state.adminPasswordProtected || state.adminPassword.trim().length > 0);
			case 2:
				return (state.githubTokenProtected || state.githubToken.trim().length > 0) && state.githubUsernameConfirmed;
			case 3:
				return isEventModeStepValid(state.githubEventMode, state.githubPollIntervalMs, state.webhookSecret, state.webhookSecretProtected);
			case 4:
				return isAiLlmStepValid(state.piAgentProvider, state.piAgentModel, state.ollamaContainerName);
			case 5:
				return true;
			default:
				return false;
		}
	}, [state]);

	if (configLoading) {
		return (
			<div className="onboarding-screen">
				<div className="onboarding-card">
					<h2>Loading configuration…</h2>
					<p className="onboarding-subtitle">
						Loading your current onboarding settings.
					</p>
				</div>
			</div>
		);
	}

	if (done) {
		return (
			<div className="onboarding-screen">
				<div className="onboarding-card">
					<h2>Setup Complete</h2>
					<p className="onboarding-subtitle">
						Your settings have been saved and Yolomatic is loading them now.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="onboarding-screen">
			<div className="onboarding-card">
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
					<h1>Welcome to Yolomatic</h1>
					<span style={{ color: "var(--muted)", fontSize: "0.875rem" }}>Step {state.step} of {TOTAL_STEPS}</span>
				</div>
				<div
					style={{
						display: "flex",
						gap: "0.25rem",
						marginBottom: "1.5rem",
					}}
				>
					{Array.from({ length: TOTAL_STEPS }, (_, i) => (
						<div
							key={i}
							style={{
								flex: 1,
								height: "4px",
								borderRadius: "2px",
								background: i < state.step ? "var(--blue)" : "var(--border)",
								transition: "background 0.2s ease",
							}}
						/>
					))}
				</div>
				<p className="onboarding-subtitle">{getStepSubtitle(state.step)}</p>

				{configError && (
				<div className="error-banner" style={{ background: "var(--yellow)" }}>
					Could not load current configuration ({configError}). Showing defaults.
				</div>
			)}
			{state.error && <div className="error-banner">{state.error}</div>}

				{state.step === 1 && (
					<StepOneAdminCredentials
						state={state}
						updateField={updateField}
						onGeneratePassword={() => updateField("adminPassword", generatePassword())}
					/>
				)}
				{state.step === 2 && (
					<StepTwoGitHubIntegration
						state={state}
						updateField={updateField}
						onVerifyToken={handleVerifyToken}
						loading={loading}
					/>
				)}
				{state.step === 3 && (
					<StepThreeEventMode
						state={state}
						updateField={updateField}
						onGenerateSecret={handleGenerateSecret}
						loading={loading}
					/>
				)}
				{state.step === 4 && (
					<StepFourAiLlm
						state={state}
						updateField={updateField}
					/>
				)}
				{state.step === 5 && (
					<StepFiveWorkspaceInit
						state={state}
						onFetchRepos={handleFetchRepos}
						onToggleRepo={toggleRepo}
						onSetAllReposSelected={setAllReposSelected}
						loading={loading}
					/>
				)}

				<div style={{ display: "flex", gap: "0.75rem", marginTop: "1.5rem", justifyContent: "space-between" }}>
					<div style={{ display: "flex", gap: "0.75rem" }}>
						{state.step > 1 && (
							<button
								className="action-btn"
								style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
								type="button"
								onClick={() => goToStep(state.step - 1)}
								disabled={loading}
							>
								Back
							</button>
						)}
						<button
							className="action-btn"
							style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--red)" }}
							type="button"
								onClick={handleCancel}
								disabled={loading}
							>
							Cancel
						</button>
					</div>
					{state.step < TOTAL_STEPS ? (
						<button
							className="action-btn restart"
							type="button"
							onClick={() => goToStep(state.step + 1)}
							disabled={!canGoNext || loading}
						>
							Next
						</button>
					) : (
						<button
							className="action-btn restart"
							type="button"
							onClick={handleFinish}
							disabled={!canGoNext || loading}
						>
							{loading ? "Initializing..." : "Initialize & Finish"}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

export function isEventModeStepValid(
	mode: string,
	pollInterval: string,
	webhookSecret: string,
	webhookSecretProtected = false,
): boolean {
	if (!isValidEventMode(mode)) {
		return false;
	}
	if (isPollingMode(mode) && parsePollIntervalMs(pollInterval) === null) {
		return false;
	}
	if (isWebhookMode(mode) && !webhookSecretProtected && webhookSecret.trim().length === 0) {
		return false;
	}
	return true;
}

/**
 * Validates the AI / LLM wizard step. A provider must be selected; when the
 * provider is `ollama` the container name and model fields must be non-empty.
 * Ollama sign-in status is informational only and never gates advancing.
 */
export function isAiLlmStepValid(
	provider: string,
	model: string,
	containerName: string,
): boolean {
	const providerTrimmed = provider.trim();
	if (!providerTrimmed) {
		return false;
	}
	if (providerTrimmed === "ollama") {
		if (containerName.trim().length === 0) {
			return false;
		}
	}
	if (model.trim().length === 0) {
		return false;
	}
	return true;
}

function getStepSubtitle(step: number): string {
	switch (step) {
		case 1:
			return "Create the master admin account for the dashboard.";
		case 2:
			return "Connect your GitHub account with a Personal Access Token.";
		case 3:
			return "Choose how Yolomatic receives GitHub events by default.";
		case 4:
			return "Configure the AI / LLM provider, Ollama container, and model.";
		case 5:
			return "Initialize workspaces for the repositories you want Yolomatic to manage.";
		default:
			return "";
	}
}

function StepOneAdminCredentials({
	state,
	updateField,
	onGeneratePassword,
}: {
	state: WizardState;
	updateField: <K extends keyof WizardState>(key: K, value: WizardState[K]) => void;
	onGeneratePassword: () => void;
}): React.ReactElement {
	const [showPassword, setShowPassword] = useState(true);

	return (
		<div className="onboarding-form">
			<div className="form-group">
				<label htmlFor="admin_full_name">Admin Full Name</label>
				<input
					id="admin_full_name"
					type="text"
					value={state.adminFullName}
					onChange={(e) => updateField("adminFullName", e.target.value)}
					placeholder="Ada Lovelace"
					required
				/>
				<span className="setting-description">Full name for the master admin account</span>
			</div>
			<div className="form-group">
				<label htmlFor="admin_username">Admin Username</label>
				<input
					id="admin_username"
					type="text"
					value={state.adminUsername}
					onChange={(e) => updateField("adminUsername", e.target.value)}
					placeholder="admin"
					required
				/>
				<span className="setting-description">Username for the admin dashboard</span>
			</div>
			<div className="form-group">
				<label htmlFor="admin_password">Admin Password</label>
				<div style={{ display: "flex", gap: "0.5rem" }}>
					<input
						id="admin_password"
						type={showPassword ? "text" : "password"}
						value={state.adminPassword}
						onChange={(e) => {
							updateField("adminPassword", e.target.value);
							if (state.adminPasswordProtected) updateField("adminPasswordProtected", false);
						}}
						placeholder={state.adminPasswordProtected ? "Leave unchanged (configured)" : "password"}
						required
						style={{ flex: 1 }}
					/>
					<button
						type="button"
						className="action-btn"
						style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)", whiteSpace: "nowrap" }}
						onClick={onGeneratePassword}
					>
						Regenerate
					</button>
				</div>
				<div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.35rem" }}>
					<label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer", fontSize: "0.875rem", color: "var(--muted)" }}>
						<input
							type="checkbox"
							checked={showPassword}
							onChange={(e) => setShowPassword(e.target.checked)}
						/>
						Show password
					</label>
				</div>
				<span className="setting-description">{state.adminPasswordProtected ? "A password is already configured. Leave the field blank to keep it, or enter a new one to replace it." : "A strong password has been suggested. You may override it."}</span>
			</div>
		</div>
	);
}

function StepTwoGitHubIntegration({
	state,
	updateField,
	onVerifyToken,
	loading,
}: {
	state: WizardState;
	updateField: <K extends keyof WizardState>(key: K, value: WizardState[K]) => void;
	onVerifyToken: () => Promise<void>;
	loading: boolean;
}): React.ReactElement {
	return (
		<div className="onboarding-form">
			<div className="form-group">
				<label htmlFor="github_token">GitHub PAT (Personal Access Token)</label>
				<div style={{ display: "flex", gap: "0.5rem" }}>
					<input
						id="github_token"
						type="password"
						value={state.githubToken}
						onChange={(e) => {
							updateField("githubToken", e.target.value);
							updateField("githubUsernameConfirmed", false);
							updateField("githubUsername", "");
							if (state.githubTokenProtected) updateField("githubTokenProtected", false);
						}}
						placeholder={state.githubTokenProtected ? "Leave unchanged (configured)" : "ghp_..."}
						required
						style={{ flex: 1 }}
					/>
					<button
						type="button"
						className="action-btn"
						style={{ background: "var(--blue)", color: "#000", whiteSpace: "nowrap" }}
						onClick={onVerifyToken}
						disabled={loading || !state.githubToken.trim()}
					>
						{loading ? "Verifying..." : "Verify"}
					</button>
				</div>
				<span className="setting-description">Personal access token with repo and issues scope</span>
			</div>

			{state.githubUsernameConfirmed && (
				<div className="form-group">
					<label htmlFor="github_username">GitHub Username</label>
					<input
						id="github_username"
						type="text"
						value={state.githubUsername}
						onChange={(e) => updateField("githubUsername", e.target.value)}
						placeholder="username"
						required
					/>
					<span className="setting-description">Inferred from your token. Confirm or edit if needed.</span>
				</div>
			)}
		</div>
	);
}

function StepThreeEventMode({
	state,
	updateField,
	onGenerateSecret,
	loading,
}: {
	state: WizardState;
	updateField: <K extends keyof WizardState>(key: K, value: WizardState[K]) => void;
	onGenerateSecret: () => Promise<void>;
	loading: boolean;
}): React.ReactElement {
	const mode = state.githubEventMode;
	const showPollInterval = isPollingMode(mode);
	const showWebhookSecret = isWebhookMode(mode);
	const [showSecret, setShowSecret] = useState(true);
	const [showInstructions, setShowInstructions] = useState(false);
	const intervalError =
		showPollInterval && state.githubPollIntervalMs.trim().length > 0
			? parsePollIntervalMs(state.githubPollIntervalMs) === null
				? `Polling interval must be a whole number of at least ${MIN_POLL_INTERVAL_MS} ms.`
				: null
			: null;

	return (
		<div className="onboarding-form">
			<div className="form-group">
				<label htmlFor="github_event_mode">GitHub Event Mode</label>
				<select
					id="github_event_mode"
					value={mode}
					onChange={(e) => {
						const next = e.target.value;
						updateField("githubEventMode", next);
						if (isPollingMode(next) && !state.githubPollIntervalMs.trim()) {
							updateField("githubPollIntervalMs", String(DEFAULT_POLL_INTERVAL_MS));
						}
					}}
				>
					<option value="" disabled>Select an option…</option>
					{EVENT_MODE_OPTIONS.map((option) => (
						<option key={option} value={option}>
							{option === "webhook" ? "Webhook" : option === "polling" ? "Polling" : "Both"}
						</option>
					))}
				</select>
				<span className="setting-description">Choose how Yolomatic discovers GitHub events.</span>
				<span className="setting-description">These are the default settings for all projects. Each project can override them later.</span>
			</div>

			{showPollInterval && (
				<div className="form-group">
					<label htmlFor="github_poll_interval_ms">Polling Interval (ms)</label>
					<input
						id="github_poll_interval_ms"
						type="number"
						min={MIN_POLL_INTERVAL_MS}
						step={1000}
						value={state.githubPollIntervalMs}
						onChange={(e) => updateField("githubPollIntervalMs", e.target.value)}
						placeholder={`at least ${MIN_POLL_INTERVAL_MS}`}
						required
					/>
					<span className="setting-description">
						Positive integer in milliseconds. Minimum {MIN_POLL_INTERVAL_MS} ms.
					</span>
					{intervalError && (
						<span style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{intervalError}</span>
					)}
				</div>
			)}

			{showWebhookSecret && (
				<div className="form-group">
					<label htmlFor="webhook_secret">Webhook Secret</label>
					<div style={{ display: "flex", gap: "0.5rem" }}>
						<input
							id="webhook_secret"
							type={showSecret ? "text" : "password"}
							value={state.webhookSecret}
							onChange={(e) => {
								updateField("webhookSecret", e.target.value);
								if (state.webhookSecretProtected) updateField("webhookSecretProtected", false);
							}}
							placeholder={state.webhookSecretProtected ? "Leave unchanged (configured)" : "Generate a secret..."}
							required
							style={{ flex: 1 }}
						/>
						<button
							type="button"
							className="action-btn"
							style={{ background: "var(--yellow)", color: "#000", whiteSpace: "nowrap" }}
							onClick={onGenerateSecret}
							disabled={loading}
						>
							{loading ? "Generating..." : "Regenerate"}
						</button>
					</div>
					<div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.35rem" }}>
						<label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer", fontSize: "0.875rem", color: "var(--muted)" }}>
							<input
								type="checkbox"
								checked={showSecret}
								onChange={(e) => setShowSecret(e.target.checked)}
							/>
							Show secret
						</label>
					</div>
					<span className="setting-description">Used to verify GitHub webhook signatures.</span>
					<button
						type="button"
						className="action-btn"
						style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)", marginTop: "0.5rem" }}
						onClick={() => setShowInstructions(true)}
					>
						How do I configure this secret in GitHub?
					</button>
				</div>
			)}

			{mode === "polling" && (
				<p className="setting-description">No webhook secret is required for polling-only mode.</p>
			)}

			<Modal open={showInstructions} onClose={() => setShowInstructions(false)} title="Configure the webhook secret in GitHub">
				<ol style={{ marginLeft: "1.25rem", lineHeight: 1.6 }}>
					<li>Go to your repository on GitHub.</li>
					<li>Click <strong>Settings</strong> then <strong>Webhooks</strong>.</li>
					<li>Click <strong>Add webhook</strong>.</li>
					<li>Set <strong>Payload URL</strong> to your Yolomatic webhook endpoint.</li>
					<li>Paste the secret above into <strong>Secret</strong>.</li>
					<li>Select <strong>Let me select individual events</strong> and enable <strong>Issues</strong> and <strong>Issue comments</strong>.</li>
					<li>Click <strong>Add webhook</strong>.</li>
				</ol>
			</Modal>
		</div>
	);
}

function StepFourAiLlm({
	state,
	updateField,
}: {
	state: WizardState;
	updateField: <K extends keyof WizardState>(key: K, value: WizardState[K]) => void;
}): React.ReactElement {
	const provider = state.piAgentProvider.trim();
	const isOllama = provider === "ollama";
	const isOpenAi = provider === "openai";
	return (
		<div className="onboarding-form">
			<div className="form-group">
				<label htmlFor="pi_agent_provider">LLM Provider</label>
				<select
					id="pi_agent_provider"
					value={state.piAgentProvider}
					onChange={(e) => updateField("piAgentProvider", e.target.value)}
				>
					{LLM_PROVIDER_OPTIONS.map((option) => (
						<option key={option} value={option}>{option}</option>
					))}
				</select>
				<span className="setting-description">
					Select the LLM provider worker containers use. Ollama runs locally;
					openai uses an OpenAI platform API key.
				</span>
			</div>

			{isOllama && (
				<>
					<div className="form-group">
						<label htmlFor="ollama_container_name">Ollama Container Name</label>
						<input
							id="ollama_container_name"
							type="text"
							value={state.ollamaContainerName}
							onChange={(e) => updateField("ollamaContainerName", e.target.value)}
							placeholder={DEFAULT_OLLAMA_CONTAINER_NAME}
							required
						/>
						<span className="setting-description">
							Name of the Ollama Docker container the control plane shells into to
							check sign-in status. Defaults to yolomatic-ollama.
						</span>
					</div>

					<OllamaSignInPanel
						containerName={state.ollamaContainerName}
						fetchStatus={fetchOnboardingOllamaSignInStatus}
					/>
				</>
			)}

			{isOpenAi && (
				<div className="form-group">
					<label htmlFor="openai_api_key">OpenAI API Key</label>
					<input
						id="openai_api_key"
						type="password"
						value={state.openaiApiKey}
						onChange={(e) => {
							updateField("openaiApiKey", e.target.value);
							if (state.openaiApiKeyProtected) updateField("openaiApiKeyProtected", false);
						}}
						placeholder={state.openaiApiKeyProtected ? "Leave unchanged (configured)" : "sk-..."}
						required
					/>
					<span className="setting-description">
						{state.openaiApiKeyProtected
							? "An OpenAI API key is already configured. Leave the field blank to keep it, or enter a new one to replace it."
							: "OpenAI platform API key. Required for the openai provider; forwarded to worker containers as OPENAI_API_KEY."}
					</span>
				</div>
			)}

			<div className="form-group">
				<label htmlFor="pi_agent_model">LLM Model</label>
				<input
					id="pi_agent_model"
					type="text"
					value={state.piAgentModel}
					onChange={(e) => updateField("piAgentModel", e.target.value)}
					placeholder="e.g. kimi-k2.7-code:cloud or gpt-5.2-codex"
					required
				/>
				<span className="setting-description">
					The model identifier worker containers use when invoking the LLM. This
					matches the free-text field on Settings → AI / LLM.
				</span>
			</div>
		</div>
	);
}

function StepFiveWorkspaceInit({
	state,
	onFetchRepos,
	onToggleRepo,
	onSetAllReposSelected,
	loading,
}: {
	state: WizardState;
	onFetchRepos: () => Promise<void>;
	onToggleRepo: (index: number) => void;
	onSetAllReposSelected: (selected: boolean) => void;
	loading: boolean;
}): React.ReactElement {
	return (
		<div className="onboarding-form">
			<RepoManager
				repos={state.repositories}
				loading={loading}
				error={state.error}
				selectable
				onToggleRepo={onToggleRepo}
				onSetAllSelected={onSetAllReposSelected}
				onRefresh={onFetchRepos}
				refreshing={loading}
				refreshLabel="Refresh"
				note={
					state.githubTokenProtected
						? "Using the configured GitHub token."
						: undefined
				}
				emptyMessage="No repositories are accessible to the configured GitHub account."
				loadingMessage={
					loading && state.repositories.length === 0
						? "Fetching repositories..."
						: "Loading repositories..."
				}
			/>
		</div>
	);
}
