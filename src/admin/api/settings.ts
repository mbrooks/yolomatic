import { apiGet } from "./client.js";
import type { SettingView } from "../../settings/model.js";

export interface LlmModelListResult {
	models: string[];
	error?: string;
}

export function fetchSettings(): Promise<{ settings: SettingView[] }> {
	return apiGet<{ settings: SettingView[] }>("/api/settings");
}

export function updateSettings(body: Record<string, string | number | boolean>): Promise<{ updated: string[]; requiresRestart: string[] }> {
	return apiPatch<{ updated: string[]; requiresRestart: string[] }>("/api/settings", body);
}

export function fetchLlmModels(provider: "openai" | "ollama"): Promise<LlmModelListResult> {
	return apiGet<LlmModelListResult>(`/api/llm/models?provider=${encodeURIComponent(provider)}`);
}

async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
	const options: RequestInit = { method: "PATCH" };
	if (body !== undefined) {
		options.headers = { "Content-Type": "application/json" };
		options.body = JSON.stringify(body);
	}
	const response = await fetch(path, options);
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? response.statusText);
	}
	return (await response.json()) as T;
}
