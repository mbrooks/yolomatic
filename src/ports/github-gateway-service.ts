import type { GitHubService, ReviewComment } from "./github-service.js";

/**
 * An issue-style comment on either an issue or a pull request. Both use the
 * GitHub issues comment API; pull requests also have separate review comments
 * (see {@link GitHubGatewayService.listPullRequestReviewComments}).
 */
export interface GatewayIssueComment {
	id: number;
	body: string;
	author: string;
	created_at: string;
	updated_at: string;
	html_url: string;
}

/** Full read of an issue, including the fields the worker is allowed to see. */
export interface GatewayIssueDetail {
	number: number;
	title: string;
	body: string;
	state: "open" | "closed";
	labels: string[];
	assignees: string[];
	html_url: string;
	created_at: string;
	updated_at: string;
}

/** Full read of a pull request, including conversation metadata. */
export interface GatewayPullRequestDetail {
	number: number;
	title: string;
	body: string;
	state: "open" | "closed";
	merged: boolean;
	head_ref: string;
	base_ref: string;
	html_url: string;
	created_at: string;
	updated_at: string;
}

/** Minimal pull-request summary used for branch-PR resolution and scoping. */
export interface GatewayPullRequestSummary {
	number: number;
	title: string;
	html_url: string;
	head_ref: string;
	base_ref: string;
	state: string;
	merged: boolean;
}

export interface GatewayIssueUpdateFields {
	title?: string;
	body?: string;
	state?: "open" | "closed";
	labels?: string[];
	assignees?: string[];
}

export interface GatewayPullRequestUpdateFields {
	title?: string;
	body?: string;
	state?: "open" | "closed";
	labels?: string[];
}

/**
 * GitHub access surface used by the worker GitHub gateway.
 *
 * This extends the existing {@link GitHubService} with the richer issue/PR read
 * and write operations the worker needs that are not on the base port. The
 * control plane's {@link GitHubServiceAdapter} implements this interface; the
 * gateway depends only on this interface so scoping logic can be unit-tested
 * with a fake that does not touch GitHub.
 *
 * The gateway never exposes the underlying Octokit or the GitHub token to the
 * worker; every call here is made by the control plane on the worker's behalf.
 */
export interface GitHubGatewayService extends GitHubService {
	getIssueDetail(owner: string, repo: string, issueNumber: number): Promise<GatewayIssueDetail | null>;
	listIssueComments(owner: string, repo: string, issueNumber: number): Promise<GatewayIssueComment[]>;
	updateIssue(
		owner: string,
		repo: string,
		issueNumber: number,
		fields: GatewayIssueUpdateFields,
	): Promise<void>;
	setLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void>;
	getPullRequestDetail(owner: string, repo: string, prNumber: number): Promise<GatewayPullRequestDetail | null>;
	listPullRequestComments(owner: string, repo: string, prNumber: number): Promise<GatewayIssueComment[]>;
	listPullRequestReviewComments(owner: string, repo: string, prNumber: number): Promise<ReviewComment[]>;
	listPullRequestsForHead(
		owner: string,
		repo: string,
		head: string,
		state: "open" | "closed" | "all",
	): Promise<GatewayPullRequestSummary[]>;
	updatePullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		fields: GatewayPullRequestUpdateFields,
	): Promise<void>;
}