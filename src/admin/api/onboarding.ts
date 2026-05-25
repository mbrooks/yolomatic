import { apiGet, apiPost } from "./client.js";

export function fetchOnboardingStatus(): Promise<{ complete: boolean; missing: string[] }> {
	return apiGet<{ complete: boolean; missing: string[] }>("/api/onboarding/status");
}

export function submitOnboarding(body: Record<string, string>): Promise<{ success: boolean; requiresRestart: string[] }> {
	return apiPost<{ success: boolean; requiresRestart: string[] }>("/api/onboarding", body);
}
