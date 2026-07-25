import { apiDelete, apiGet, apiPost } from "./client.js";

export interface AddRepoRequest {
	owner: string;
	repo: string;
}

export interface AddRepoResponse {
	owner: string;
	repo: string;
	fullName: string;
	added: boolean;
	message?: string;
}

export interface AccessibleRepo {
	owner: string;
	repo: string;
	fullName: string;
	visibility: "public" | "private" | "internal";
}

export interface ScanReposResponse {
	repos: AccessibleRepo[];
	added: number;
	skipped?: AccessibleRepo[];
}

export interface RemoveRepoResponse {
	removed: boolean;
}

export interface AccessibleReposResponse {
	repositories: AccessibleRepo[];
	configured: Array<{ owner: string; repo: string }>;
}

export async function addRepo(owner: string, repo: string): Promise<AddRepoResponse> {
	return apiPost<AddRepoResponse>("/api/repos", { owner, repo });
}

export async function listAccessibleRepos(): Promise<AccessibleReposResponse> {
	return apiGet<AccessibleReposResponse>("/api/repos/accessible");
}

export async function scanRepos(): Promise<ScanReposResponse> {
	return apiPost<ScanReposResponse>("/api/repos/scan");
}

export async function removeRepo(owner: string, repo: string): Promise<RemoveRepoResponse> {
	return apiDelete<RemoveRepoResponse>(
		`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
	);
}
