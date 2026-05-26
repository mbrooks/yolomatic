import { apiPost, apiGet } from "./client.js";

export interface CreateIssuePayload {
	owner: string;
	repo: string;
	title: string;
	body?: string;
	labels?: string[];
	assignees?: string[];
}

export interface CreatedIssueResponse {
	number: number;
	html_url: string;
}

export interface RepoContext {
	labels: string[];
	templates: Array<{ name: string; body: string }>;
	recentCommits: string[];
	relatedIssues: Array<{ number: number; title: string; state: string }>;
}

export interface GenerateIssuePayload {
	owner: string;
	repo: string;
	prompt: string;
	privacyMode?: boolean;
	selectedTemplate?: string;
	context?: RepoContext;
}

export interface GeneratedIssueResponse {
	title: string;
	body: string;
	labels: string[];
	assignees: string[];
}

export async function createIssue(payload: CreateIssuePayload): Promise<CreatedIssueResponse> {
	return apiPost<CreatedIssueResponse>("/api/issues", payload);
}

export async function generateIssue(payload: GenerateIssuePayload): Promise<GeneratedIssueResponse> {
	return apiPost<GeneratedIssueResponse>("/api/issues/generate", payload);
}

export async function fetchRepoContext(owner: string, repo: string): Promise<RepoContext> {
	return apiGet<RepoContext>(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/context`);
}
