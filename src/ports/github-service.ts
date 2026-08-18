export interface PullRequestInfo {
	head: { ref: string; sha?: string };
	base?: { ref: string; sha?: string };
	state: string;
	merged: boolean;
	/** GitHub mergeability computed by a background job (`true | false | null`). `null` means still computing — poll. */
	mergeable?: boolean | null;
	/** Raw `mergeable_state` from `octokit.pulls.get` (`clean | dirty | blocked | unstable | has_hooks | unknown | draft`). */
	mergeableState?: string;
	/** Whether the PR is a draft. */
	draft?: boolean;
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

export type CollaboratorPermission = "admin" | "maintain" | "write" | "triage" | "read";

/**
 * An issue-style comment on either an issue or a pull request, returned by
 * {@link GitHubService.listIssueComments}. Mirrors the gateway's
 * `GatewayIssueComment` shape (author login only; no GitHub account `type`).
 */
export interface IssueComment {
	id: number;
	body: string;
	author: string;
	created_at: string;
	updated_at: string;
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
		draft?: boolean,
	): Promise<CreatedPR | null>;
	markPullRequestReadyForReview(owner: string, repo: string, prNumber: number): Promise<void>;
	listPullRequests(
		owner: string,
		repo: string,
		options: { head: string; base: string; state: string },
	): Promise<CreatedPR[]>;
	/**
	 * List the numbers of all currently open pull requests in a repository
	 * (state `open` only; merged and closed PRs are excluded). Used to restrict
	 * candidate enumeration to unmerged PRs without a per-PR `getPullRequest`
	 * round-trip. Paginates `per_page: 100` up to a safety cap of 500 PRs.
	 */
	listOpenPullRequests(owner: string, repo: string): Promise<number[]>;
	getIssue(owner: string, repo: string, issueNumber: number): Promise<{ state: string; title?: string; body?: string } | null>;
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
	listIssueComments(owner: string, repo: string, issueNumber: number): Promise<IssueComment[]>;
	updateIssueTitle(owner: string, repo: string, issueNumber: number, title: string): Promise<void>;
	getAuthenticatedUser(): Promise<{ login: string } | null>;
	listAccessibleRepositories(): Promise<AccessibleRepo[]>;
	getRepository(owner: string, repo: string): Promise<RepositoryInfo | null>;
	getCollaboratorPermissionLevel(owner: string, repo: string, username: string): Promise<CollaboratorPermission | null>;
	isCollaborator(owner: string, repo: string, username: string): Promise<boolean>;
}
