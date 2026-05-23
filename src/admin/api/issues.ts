import { apiPost } from "./client.js";

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

export async function createIssue(payload: CreateIssuePayload): Promise<CreatedIssueResponse> {
	return apiPost<CreatedIssueResponse>("/api/issues", payload);
}
