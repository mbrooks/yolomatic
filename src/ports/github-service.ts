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

export type RepoVisibility = "public" | "private" | "internal";

export interface AccessibleRepo {
	owner: string;
	repo: string;
	fullName: string;
	visibility: RepoVisibility;
}

export interface RepositoryInfo {
	owner: string;
	repo: string;
	fullName: string;
	visibility: RepoVisibility;
}

export function isPublicVisibility(visibility: RepoVisibility): boolean {
	return visibility === "public";
}

export interface GitHubService {
	postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<number>;
	postPRComment(owner: string, repo: string, prNumber: number, body: string): Promise<number>;
	addLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void>;
	removeLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<void>;
	getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo | null>;
	updatePullRequestBranch(owner: string, repo: string, prNumber: number, expectedHeadSha?: string): Promise<void>;
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
	getIssue(owner: string, repo: string, issueNumber: number): Promise<{ state: string; body?: string } | null>;
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
	closeIssue(owner: string, repo: string, issueNumber: number): Promise<void>;
	updateIssueBody(owner: string, repo: string, issueNumber: number, body: string): Promise<void>;
	getAuthenticatedUser(): Promise<{ login: string } | null>;
	listAccessibleRepositories(): Promise<AccessibleRepo[]>;
	getRepository(owner: string, repo: string): Promise<RepositoryInfo | null>;
}
