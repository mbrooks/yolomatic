import { Octokit } from "@octokit/rest";
import type {
	CreatedPR,
	GitHubService,
	IssueTemplate,
	PullRequestInfo,
	ReviewComment,
} from "../../ports/github-service.js";
import type {
	GatewayIssueComment,
	GatewayIssueDetail,
	GatewayIssueUpdateFields,
	GatewayPullRequestDetail,
	GatewayPullRequestSummary,
	GatewayPullRequestUpdateFields,
	GitHubGatewayService,
} from "../../ports/github-gateway-service.js";
import { createOctokit } from "./octokit.js";
import { AccountRepositoryDelegate } from "./delegates/account-repository-delegate.js";
import { IssueDelegate } from "./delegates/issue-delegate.js";
import { PullRequestDelegate } from "./delegates/pull-request-delegate.js";

/**
 * Public façade for the GitHub adapter. Implements both {@link GitHubService}
 * and {@link GitHubGatewayService} by composing three focused internal
 * delegates (account/repository, issues, pull requests). The delegates own the
 * Octokit calls, response mappers, and method-specific fallbacks; this class
 * only wires and orchestrates them. Neither the delegates nor Octokit are
 * exposed through the public ports.
 */
export class GitHubServiceAdapter implements GitHubService, GitHubGatewayService {
	private readonly octokit: Octokit;
	private readonly accounts: AccountRepositoryDelegate;
	private readonly issues: IssueDelegate;
	private readonly pullRequests: PullRequestDelegate;

	constructor(options: { githubToken: string; octokit?: Octokit }) {
		this.octokit = options.octokit ?? createOctokit(options.githubToken);
		this.accounts = new AccountRepositoryDelegate(this.octokit);
		this.issues = new IssueDelegate(this.octokit);
		this.pullRequests = new PullRequestDelegate(this.octokit);
	}

	async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<number> {
		return this.issues.postComment(owner, repo, issueNumber, body);
	}

	async postPRComment(owner: string, repo: string, prNumber: number, body: string): Promise<number> {
		return this.pullRequests.postPRComment(owner, repo, prNumber, body);
	}

	async addLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
		return this.issues.addLabels(owner, repo, issueNumber, labels);
	}

	async removeLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<void> {
		return this.issues.removeLabel(owner, repo, issueNumber, label);
	}

	async getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo | null> {
		return this.pullRequests.getPullRequest(owner, repo, prNumber);
	}

	async updatePullRequestBranch(owner: string, repo: string, prNumber: number, expectedHeadSha?: string): Promise<void> {
		return this.pullRequests.updatePullRequestBranch(owner, repo, prNumber, expectedHeadSha);
	}

	async createPullRequest(
		owner: string,
		repo: string,
		title: string,
		body: string,
		head: string,
		base: string,
		draft?: boolean,
	): Promise<CreatedPR | null> {
		return this.pullRequests.createPullRequest(owner, repo, title, body, head, base, draft);
	}

	async markPullRequestReadyForReview(owner: string, repo: string, prNumber: number): Promise<void> {
		return this.pullRequests.markPullRequestReadyForReview(owner, repo, prNumber);
	}

	async listPullRequests(
		owner: string,
		repo: string,
		options: { head: string; base: string; state: string },
	): Promise<CreatedPR[]> {
		return this.pullRequests.listPullRequests(owner, repo, options);
	}

	async listOpenPullRequests(owner: string, repo: string): Promise<number[]> {
		return this.pullRequests.listOpenPullRequests(owner, repo);
	}

	async getIssue(owner: string, repo: string, issueNumber: number): Promise<{ state: string; title?: string; body?: string } | null> {
		return this.issues.getIssue(owner, repo, issueNumber);
	}

	async createIssue(owner: string, repo: string, title: string, body: string, labels?: string[], assignees?: string[]): Promise<{ number: number; html_url: string }> {
		return this.issues.createIssue(owner, repo, title, body, labels, assignees);
	}

	async initializeEmptyRepo(owner: string, repo: string, defaultBranch: string): Promise<void> {
		return this.accounts.initializeEmptyRepo(owner, repo, defaultBranch);
	}

	async fileSelfReport(title: string, body: string, labels: string[]): Promise<string> {
		return this.issues.fileSelfReport(title, body, labels);
	}

	async listReviewComments(owner: string, repo: string, prNumber: number, reviewId: number): Promise<ReviewComment[]> {
		return this.pullRequests.listReviewComments(owner, repo, prNumber, reviewId);
	}

	async listLabels(owner: string, repo: string): Promise<string[]> {
		return this.issues.listLabels(owner, repo);
	}

	async getIssueTemplates(owner: string, repo: string): Promise<IssueTemplate[]> {
		return this.issues.getIssueTemplates(owner, repo);
	}

	async listRecentCommits(owner: string, repo: string, limit?: number): Promise<string[]> {
		return this.accounts.listRecentCommits(owner, repo, limit);
	}

	async listRelatedIssues(owner: string, repo: string, query: string, limit?: number): Promise<Array<{ number: number; title: string; state: string }>> {
		return this.issues.listRelatedIssues(owner, repo, query, limit);
	}

	async listOpenIssues(owner: string, repo: string): Promise<import("../../ports/github-service.js").OpenIssue[]> {
		return this.issues.listOpenIssues(owner, repo);
	}

	async listPendingInvitations(): Promise<import("../../ports/github-service.js").PendingInvitation[]> {
		return this.accounts.listPendingInvitations();
	}

	async acceptInvitation(invitationId: number): Promise<void> {
		return this.accounts.acceptInvitation(invitationId);
	}

	async updateIssueAssignees(owner: string, repo: string, issueNumber: number, assignees: string[]): Promise<void> {
		return this.issues.updateIssueAssignees(owner, repo, issueNumber, assignees);
	}

	async closeIssue(owner: string, repo: string, issueNumber: number): Promise<void> {
		return this.issues.closeIssue(owner, repo, issueNumber);
	}

	async updateIssueBody(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
		return this.issues.updateIssueBody(owner, repo, issueNumber, body);
	}

	async updateIssueTitle(owner: string, repo: string, issueNumber: number, title: string): Promise<void> {
		return this.issues.updateIssueTitle(owner, repo, issueNumber, title);
	}

	async getAuthenticatedUser(): Promise<{ login: string } | null> {
		return this.accounts.getAuthenticatedUser();
	}

	async listAccessibleRepositories(): Promise<import("../../ports/github-service.js").AccessibleRepo[]> {
		return this.accounts.listAccessibleRepositories();
	}

	async getRepository(owner: string, repo: string): Promise<import("../../ports/github-service.js").RepositoryInfo | null> {
		return this.accounts.getRepository(owner, repo);
	}

	async getCollaboratorPermissionLevel(
		owner: string,
		repo: string,
		username: string,
	): Promise<import("../../ports/github-service.js").CollaboratorPermission | null> {
		return this.accounts.getCollaboratorPermissionLevel(owner, repo, username);
	}

	async isCollaborator(owner: string, repo: string, username: string): Promise<boolean> {
		return this.accounts.isCollaborator(owner, repo, username);
	}

	async getIssueDetail(owner: string, repo: string, issueNumber: number): Promise<GatewayIssueDetail | null> {
		return this.issues.getIssueDetail(owner, repo, issueNumber);
	}

	async listIssueComments(owner: string, repo: string, issueNumber: number): Promise<GatewayIssueComment[]> {
		return this.issues.listIssueComments(owner, repo, issueNumber);
	}

	async updateIssue(
		owner: string,
		repo: string,
		issueNumber: number,
		fields: GatewayIssueUpdateFields,
	): Promise<void> {
		return this.issues.updateIssue(owner, repo, issueNumber, fields);
	}

	async setLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
		return this.issues.setLabels(owner, repo, issueNumber, labels);
	}

	async getPullRequestDetail(owner: string, repo: string, prNumber: number): Promise<GatewayPullRequestDetail | null> {
		return this.pullRequests.getPullRequestDetail(owner, repo, prNumber);
	}

	async listPullRequestComments(owner: string, repo: string, prNumber: number): Promise<GatewayIssueComment[]> {
		// PRs share the issue comment API; reuse the issue delegate's mapping.
		return this.issues.listIssueComments(owner, repo, prNumber);
	}

	async listPullRequestReviewComments(owner: string, repo: string, prNumber: number): Promise<ReviewComment[]> {
		return this.pullRequests.listPullRequestReviewComments(owner, repo, prNumber);
	}

	async listPullRequestsForHead(
		owner: string,
		repo: string,
		head: string,
		state: "open" | "closed" | "all",
	): Promise<GatewayPullRequestSummary[]> {
		return this.pullRequests.listPullRequestsForHead(owner, repo, head, state);
	}

	async updatePullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		fields: GatewayPullRequestUpdateFields,
	): Promise<void> {
		const { labels, ...metadata } = fields;
		await this.pullRequests.updatePullRequestMetadata(owner, repo, prNumber, metadata);
		if (labels !== undefined) {
			// PR labels use the issues API and share the empty-label 404 handling.
			await this.issues.setLabels(owner, repo, prNumber, labels);
		}
	}
}