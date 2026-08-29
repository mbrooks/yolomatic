import { apiGet } from "./client.js";

export interface RepoSettingView {
	key:
		| "github_event_mode"
		| "default_branch"
		| "worker_template"
		| "issue_new_comment_enabled"
		| "issue_admin_link_in_comments_enabled"
		| "pi_agent_build_model";
	value: string;
	default: string;
	override: string | null;
	inherited: boolean;
	requiresRestart: boolean;
	description: string;
	options?: string[];
	optionLabels?: Record<string, string>;
}

export function fetchRepoSettings(owner: string, repo: string): Promise<{ settings: RepoSettingView[] }> {
	return apiGet<{ settings: RepoSettingView[] }>(
		`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings`,
	);
}

export function updateRepoSettings(
	owner: string,
	repo: string,
	body: Record<string, string>,
): Promise<{ updated: string[]; requiresRestart: string[] }> {
	return apiPatch<{ updated: string[]; requiresRestart: string[] }>(
		`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings`,
		body,
	);
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
