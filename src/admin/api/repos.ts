import { apiPost } from "./client.js";

export interface AccessibleRepo {
	owner: string;
	repo: string;
	fullName: string;
}

export interface ScanReposResponse {
	repos: AccessibleRepo[];
	added: number;
}

export async function scanRepos(): Promise<ScanReposResponse> {
	return apiPost<ScanReposResponse>("/api/repos/scan");
}
