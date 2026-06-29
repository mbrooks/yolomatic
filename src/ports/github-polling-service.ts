import type { AccessibleRepo } from "./github-service.js";

export interface PollIssue {
	number: number;
	title: string;
	body: string | null;
	state: string;
	created_at: string;
	updated_at: string;
	labels: Array<{ name?: string }>;
	assignee: { login: string } | null;
	assignees: Array<{ login: string }>;
	user?: { login: string };
	pull_request?: { url: string };
}

export interface PollIssueEvent {
	id: number;
	event: string;
	created_at: string;
	actor?: { login: string };
	issue: PollIssue;
	assignee?: { login: string };
}

export interface PollIssueComment {
	id: number;
	body: string;
	created_at: string;
	updated_at: string;
	user: { login: string; type?: string };
	issue: PollIssue;
}

export interface PollPullRequest {
	number: number;
	title: string;
	body: string | null;
	state: string;
	merged: boolean;
	created_at: string;
	updated_at: string;
	head: { ref: string };
	user?: { login: string };
}

export interface PollPRReview {
	id: number;
	body: string | null;
	state: string;
	submitted_at: string;
	user: { login: string };
	pull_request: PollPullRequest;
}

export interface PollPRReviewComment {
	id: number;
	body: string;
	created_at: string;
	updated_at: string;
	user: { login: string };
	path?: string;
	line?: number | null;
	pull_request: PollPullRequest;
}

export interface GitHubPollingService {
	listAccessibleRepositories(): Promise<AccessibleRepo[]>;
	listIssuesUpdatedSince(owner: string, repo: string, since: string): Promise<PollIssue[]>;
	listIssueEventsSince(owner: string, repo: string, since: string): Promise<PollIssueEvent[]>;
	listIssueCommentsSince(owner: string, repo: string, since: string): Promise<PollIssueComment[]>;
	listPullRequestsUpdatedSince(owner: string, repo: string, since: string): Promise<PollPullRequest[]>;
	listPRReviewsSince(owner: string, repo: string, since: string): Promise<PollPRReview[]>;
	listPRReviewCommentsSince(owner: string, repo: string, since: string): Promise<PollPRReviewComment[]>;
}
