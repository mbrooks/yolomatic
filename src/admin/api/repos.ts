import { apiPost } from "./client.js";

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

export async function addRepo(owner: string, repo: string): Promise<AddRepoResponse> {
	return apiPost<AddRepoResponse>("/api/repos", { owner, repo });
}

export async function scanRepos(): Promise<ScanReposResponse> {
	return apiPost<ScanReposResponse>("/api/repos/scan");
}
