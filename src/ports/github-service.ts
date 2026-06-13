export interface PullRequestInfo {
	head: { ref: string };
	state: string;
	merged: boolean;
}

export interface ReviewComment {
	id: number;
	body: string;
	user?: { login: string };
	path?: string;
	line?: number | null;
}

export interface CreatedPR {
	number: number;
	html_url: string;
}

export interface CreatedIssue {
	number: number;
	html_url: string;
}

export interface IssueTemplate {
	name: string;
	body: string;
}

export interface OpenIssue {
	number: number;
	title: string;
	body: string;
	state: string;
	labels: string[];
	assignees: string[];
	html_url: string;
}

export interface PendingInvitation {
	id: number;
	repository: {
		full_name: string;
		name: string;
		owner: { login: string };
	};
	inviter: { login: string } | null;
	permissions: string;
	created_at: string;
	html_url: string;
}

export interface AccessibleRepo {
	owner: string;
	repo: string;
	fullName: string;
}

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

export interface GitHubService {
	postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void>;
	postPRComment(owner: string, repo: string, prNumber: number, body: string): Promise<void>;
	addLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void>;
	removeLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<void>;
	getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo | null>;
	createPullRequest(
		owner: string,
		repo: string,
		title: string,
		body: string,
		head: string,
		base: string,
	): Promise<CreatedPR | null>;
	listPullRequests(
		owner: string,
		repo: string,
		options: { head: string; base: string; state: string },
	): Promise<CreatedPR[]>;
	getIssue(owner: string, repo: string, issueNumber: number): Promise<{ state: string } | null>;
	createIssue(owner: string, repo: string, title: string, body: string, labels?: string[], assignees?: string[]): Promise<CreatedIssue>;
	initializeEmptyRepo(owner: string, repo: string, defaultBranch: string): Promise<void>;
	fileSelfReport(title: string, body: string, labels: string[]): Promise<string>;
	listReviewComments(owner: string, repo: string, prNumber: number, reviewId: number): Promise<ReviewComment[]>;
	listLabels(owner: string, repo: string): Promise<string[]>;
	getIssueTemplates(owner: string, repo: string): Promise<IssueTemplate[]>;
	listRecentCommits(owner: string, repo: string, limit?: number): Promise<string[]>;
	listRelatedIssues(owner: string, repo: string, query: string, limit?: number): Promise<Array<{ number: number; title: string; state: string }>>;
	listOpenIssues(owner: string, repo: string): Promise<OpenIssue[]>;
	listPendingInvitations(): Promise<PendingInvitation[]>;
	acceptInvitation(invitationId: number): Promise<void>;
	updateIssueAssignees(owner: string, repo: string, issueNumber: number, assignees: string[]): Promise<void>;
	getAuthenticatedUser(): Promise<{ login: string } | null>;
	listAccessibleRepositories(): Promise<AccessibleRepo[]>;
}
