import { apiGet, apiPost } from "./client.js";
import type { OllamaSignInStatus } from "./ollama.js";

export interface OnboardingStatus {
	complete: boolean;
	missing: string[];
}

export interface OnboardingSecretField {
	configured: boolean;
}

/**
 * Effective onboarding configuration returned by GET /api/onboarding/config.
 * Non-sensitive settings are returned as plain strings (empty when unset);
 * sensitive settings are reported as `{ configured }` so the stored secret is
 * never exposed to the client.
 */
export type OnboardingConfig = Record<string, string | OnboardingSecretField>;

export function isSecretField(value: string | OnboardingSecretField): value is OnboardingSecretField {
	return typeof value === "object" && value !== null && typeof value.configured === "boolean";
}

export interface VerifyTokenResponse {
	username: string;
}

export interface GenerateSecretResponse {
	secret: string;
}

export interface RepoItem {
	owner: string;
	repo: string;
	fullName: string;
}

export interface ListReposResponse {
	repositories: RepoItem[];
	configured?: Array<{ owner: string; repo: string }>;
}

export interface InitWorkspacesRequest {
	token: string;
	username: string;
	repos: Array<{ owner: string; repo: string }>;
}

export interface InitWorkspacesResponse {
	initialized: string[];
}

export function fetchOnboardingStatus(): Promise<OnboardingStatus> {
	return apiGet<OnboardingStatus>("/api/onboarding/status");
}

export function fetchOnboardingConfig(): Promise<OnboardingConfig> {
	return apiGet<OnboardingConfig>("/api/onboarding/config");
}

export function verifyGitHubToken(token: string): Promise<VerifyTokenResponse> {
	return apiPost<VerifyTokenResponse>("/api/onboarding/verify-token", { token });
}

export function generateWebhookSecret(): Promise<GenerateSecretResponse> {
	return apiPost<GenerateSecretResponse>("/api/onboarding/generate-secret");
}

export function listAccessibleRepositories(token: string): Promise<ListReposResponse> {
	return apiPost<ListReposResponse>("/api/onboarding/repos", { token });
}

export function initializeWorkspaces(payload: InitWorkspacesRequest): Promise<InitWorkspacesResponse> {
	return apiPost<InitWorkspacesResponse>("/api/onboarding/init-workspaces", payload);
}

export function submitOnboarding(
	body: Record<string, string>,
): Promise<{ success: boolean; activated: boolean; requiresRestart: string[] }> {
	return apiPost<{ success: boolean; activated: boolean; requiresRestart: string[] }>("/api/onboarding", body);
}

export type { OllamaSignInStatus };

/**
 * Fetches Ollama sign-in status via the onboarding-scoped endpoint, which is
 * reachable before any admin session exists (the wizard runs during first-run
 * onboarding when the auth-gated `/api/ollama/signin` route would return 503).
 * Returns the same `OllamaSignInStatus` shape as `fetchOllamaSignInStatus`.
 */
export function fetchOnboardingOllamaSignInStatus(): Promise<OllamaSignInStatus> {
	return apiGet<OllamaSignInStatus>("/api/onboarding/ollama-signin");
}
