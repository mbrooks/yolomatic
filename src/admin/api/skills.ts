import { apiGet, apiPost } from "./client.js";
import type { ServerSkill, RepoSkill } from "../app/types.js";

export function fetchServerSkills(): Promise<{ skills: ServerSkill[] }> {
	return apiGet<{ skills: ServerSkill[] }>("/api/skills");
}

export function createServerSkill(body: {
	name: string;
	description: string;
	content: string;
	enabled: boolean;
}): Promise<ServerSkill> {
	return apiPost<ServerSkill>("/api/skills", body);
}

export async function updateServerSkill(
	id: string,
	body: Partial<{ name: string; description: string; content: string; enabled: boolean }>,
): Promise<ServerSkill> {
	const response = await fetch(`/api/skills/${encodeURIComponent(id)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? response.statusText);
	}
	return (await response.json()) as ServerSkill;
}

export async function deleteServerSkill(id: string): Promise<{ deleted: boolean }> {
	const response = await fetch(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? response.statusText);
	}
	return (await response.json()) as { deleted: boolean };
}

export function fetchRepoSkills(owner: string, repo: string): Promise<{ skills: RepoSkill[] }> {
	return apiGet<{ skills: RepoSkill[] }>(
		`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/skills`,
	);
}

export function createRepoSkill(
	owner: string,
	repo: string,
	body: { name: string; description: string; content: string; enabled: boolean },
): Promise<RepoSkill> {
	return apiPost<RepoSkill>(
		`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/skills`,
		body,
	);
}

export async function updateRepoSkill(
	owner: string,
	repo: string,
	name: string,
	body: Partial<{ name: string; description: string; content: string; enabled: boolean }>,
): Promise<unknown> {
	const response = await fetch(
		`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/skills/${encodeURIComponent(name)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? response.statusText);
	}
	return response.json();
}

export async function deleteRepoSkill(
	owner: string,
	repo: string,
	name: string,
): Promise<{ deleted: boolean }> {
	const response = await fetch(
		`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/skills/${encodeURIComponent(name)}`,
		{ method: "DELETE" },
	);
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? response.statusText);
	}
	return (await response.json()) as { deleted: boolean };
}
