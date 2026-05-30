import { apiPost, apiGet } from "./client.js";

export interface OpenIssue {
	number: number;
	title: string;
	body: string;
	state: string;
	labels: string[];
	assignees: string[];
	html_url: string;
}

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

export interface IssueDraft {
	title: string;
	body: string;
	labels: string[];
	assignees: string[];
}

export interface IssueChatMessage {
	role: "assistant" | "user";
	text: string;
}

export interface IssueChatPayload {
	owner?: string;
	repo?: string;
	privacyMode?: boolean;
	selectedTemplate?: string;
	context?: RepoContext;
	draft?: Partial<IssueDraft>;
	messages: IssueChatMessage[];
}

export interface IssueChatResponse {
	message: string;
	owner: string;
	repo: string;
	draft: IssueDraft;
	readyToCreate: boolean;
	shouldCreate: boolean;
	createdIssue?: CreatedIssueResponse;
}

export interface IssueChatProgressEvent {
	type: "started" | "creating" | "completed" | "error";
	message: string;
	response?: IssueChatResponse;
}

export async function createIssue(payload: CreateIssuePayload): Promise<CreatedIssueResponse> {
	return apiPost<CreatedIssueResponse>("/api/issues", payload);
}

export async function generateIssue(payload: GenerateIssuePayload): Promise<GeneratedIssueResponse> {
	return apiPost<GeneratedIssueResponse>("/api/issues/generate", payload);
}

export async function chatIssue(payload: IssueChatPayload): Promise<IssueChatResponse> {
	return apiPost<IssueChatResponse>("/api/issues/chat", payload);
}

export async function fetchRepoContext(owner: string, repo: string): Promise<RepoContext> {
	return apiGet<RepoContext>(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/context`);
}

export async function fetchOpenIssues(owner: string, repo: string): Promise<OpenIssue[]> {
	return apiGet<{ issues: OpenIssue[] }>(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`).then(
		(r) => r.issues,
	);
}
