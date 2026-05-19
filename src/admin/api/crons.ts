import { apiGet, apiPost } from "./client.js";
import type { CronJob, CronRun } from "../app/types.js";

export function fetchCrons(owner: string, repo: string): Promise<{ crons: CronJob[] }> {
	return apiGet<{ crons: CronJob[] }>(`/api/crons/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
}

export function createCron(
	owner: string,
	repo: string,
	body: {
		name: string;
		description?: string;
		prompt: string;
		scheduleType: string;
		scheduleValue: string;
		branch?: string;
		notificationChannel?: string;
	},
): Promise<CronJob> {
	return apiPost<CronJob>(`/api/crons/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, body);
}

export function updateCron(
	owner: string,
	repo: string,
	id: string,
	body: Partial<{
		name: string;
		description: string;
		prompt: string;
		scheduleType: string;
		scheduleValue: string;
		branch: string;
		notificationChannel: string | null;
		enabled: boolean;
	}>,
): Promise<CronJob> {
	return apiPatch<CronJob>(`/api/crons/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(id)}`, body);
}

export function deleteCron(owner: string, repo: string, id: string): Promise<{ deleted: boolean }> {
	return apiDelete<{ deleted: boolean }>(`/api/crons/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(id)}`);
}

export function runCron(owner: string, repo: string, id: string): Promise<{ queued: boolean }> {
	return apiPost<{ queued: boolean }>(`/api/crons/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(id)}/run`);
}

export function fetchCronRuns(owner: string, repo: string, id: string): Promise<{ runs: CronRun[] }> {
	return apiGet<{ runs: CronRun[] }>(`/api/crons/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(id)}/runs`);
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

async function apiDelete<T>(path: string): Promise<T> {
	const response = await fetch(path, { method: "DELETE" });
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? response.statusText);
	}
	return (await response.json()) as T;
}
