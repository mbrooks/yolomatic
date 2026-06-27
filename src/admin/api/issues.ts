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

export async function fetchOpenIssues(owner: string, repo: string): Promise<OpenIssue[]> {
	return apiGet<{ issues: OpenIssue[] }>(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`).then(
		(r) => r.issues,
	);
}

export async function assignIssue(
	owner: string,
	repo: string,
	issueNumber: number,
	title: string,
	body: string,
	labels: string[],
): Promise<{ started: boolean; status: string; message: string }> {
	return apiPost<{ started: boolean; status: string; message: string }>(
		`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/assign`,
		{ title, body, labels },
	);
}

export async function startIssueSession(
	owner: string,
	repo: string,
	issueNumber: number,
	title: string,
	body: string,
	labels: string[],
): Promise<{ started: boolean; status: string; message: string }> {
	return apiPost<{ started: boolean; status: string; message: string }>(
		`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/start-session`,
		{ title, body, labels },
	);
}

export async function closeIssue(
	owner: string,
	repo: string,
	issueNumber: number,
): Promise<{ closed: boolean }> {
	return apiPost<{ closed: boolean }>(
		`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/close`,
		{},
	);
}

export async function markIssueDoNotWork(
	owner: string,
	repo: string,
	issueNumber: number,
): Promise<{ closed: boolean; labeled: boolean }> {
	return apiPost<{ closed: boolean; labeled: boolean }>(
		`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/mark-do-not-work`,
		{},
	);
}
