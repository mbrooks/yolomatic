import { apiGet, apiPost } from "./client.js";

/** ChatGPT Codex OAuth sign-in status returned by the status endpoints. */
export interface OpenAICodexSignInStatus {
	signedIn: boolean;
	signInUrl?: string;
	pending?: boolean;
	account?: string;
	expired?: boolean;
	message: string;
}

/** Response from beginning a ChatGPT OAuth login. */
export interface OpenAICodexLoginResponse {
	authUrl: string;
}

/**
 * ChatGPT Codex OAuth status for the Settings screen (authed). The onboarding
 * wizard uses the onboarding-scoped variant below so it works before any admin
 * session exists.
 */
export function fetchOpenAICodexStatus(): Promise<OpenAICodexSignInStatus> {
	return apiGet<OpenAICodexSignInStatus>("/api/openai-codex/status");
}

export function beginOpenAICodexLogin(): Promise<OpenAICodexLoginResponse> {
	return apiPost<OpenAICodexLoginResponse>("/api/openai-codex/login");
}

export function logoutOpenAICodex(): Promise<{ success: boolean }> {
	return apiPost<{ success: boolean }>("/api/openai-codex/logout");
}

/** Onboarding-scoped (unauthenticated) ChatGPT Codex OAuth status. */
export function fetchOnboardingOpenAICodexStatus(): Promise<OpenAICodexSignInStatus> {
	return apiGet<OpenAICodexSignInStatus>("/api/onboarding/openai-codex-status");
}

export function beginOnboardingOpenAICodexLogin(): Promise<OpenAICodexLoginResponse> {
	return apiPost<OpenAICodexLoginResponse>("/api/onboarding/openai-codex-login");
}

export function logoutOnboardingOpenAICodex(): Promise<{ success: boolean }> {
	return apiPost<{ success: boolean }>("/api/onboarding/openai-codex-logout");
}