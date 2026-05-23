import { Octokit } from "@octokit/rest";
import type { CreatedPR, GitHubService, PullRequestInfo, ReviewComment } from "../../ports/github-service.js";
import { createOctokit } from "./octokit.js";

export class GitHubServiceAdapter implements GitHubService {
	private readonly octokit: Octokit;

	constructor(options: { githubToken: string; octokit?: Octokit }) {
		this.octokit = options.octokit ?? createOctokit(options.githubToken);
	}

	async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
		await this.octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body });
	}

	async postPRComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
		await this.octokit.issues.createComment({ owner, repo, issue_number: prNumber, body });
	}

	async addLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
		await this.octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels });
	}

	async removeLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<void> {
		try {
			await this.octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
		} catch (error) {
			const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
			if (status !== 404) throw error;
		}
	}

	async getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo | null> {
		try {
			const { data } = await this.octokit.pulls.get({ owner, repo, pull_number: prNumber });
			return { head: data.head, state: data.state, merged: data.merged ?? false };
		} catch {
			return null;
		}
	}

	async createPullRequest(
		owner: string,
		repo: string,
		title: string,
		body: string,
		head: string,
		base: string,
	): Promise<CreatedPR | null> {
		try {
			const pr = await this.octokit.pulls.create({ owner, repo, title, body, head, base });
			return { number: pr.data.number, html_url: pr.data.html_url };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("No commits between")) {
				return null;
			}
			throw error;
		}
	}

	async listPullRequests(
		owner: string,
		repo: string,
		options: { head: string; base: string; state: string },
	): Promise<CreatedPR[]> {
		const { data } = await this.octokit.pulls.list({
			owner,
			repo,
			head: options.head,
			base: options.base,
			state: options.state as "open" | "closed" | "all",
		});
		return data.map((pr) => ({ number: pr.number, html_url: pr.html_url }));
	}

	async getIssue(owner: string, repo: string, issueNumber: number): Promise<{ state: string } | null> {
		try {
			const { data } = await this.octokit.issues.get({ owner, repo, issue_number: issueNumber });
			return { state: data.state };
		} catch {
			return null;
		}
	}

	async createIssue(owner: string, repo: string, title: string, body: string, labels?: string[], assignees?: string[]): Promise<{ number: number; html_url: string }> {
		const { data } = await this.octokit.issues.create({ owner, repo, title, body, labels, assignees });
		return { number: data.number, html_url: data.html_url };
	}

	async fileSelfReport(title: string, body: string, labels: string[]): Promise<string> {
		const { SelfMonitor } = await import("../../self-monitor/index.js");
		const { owner, repo } = SelfMonitor.getTargetRepo();
		const response = await this.octokit.issues.create({ owner, repo, title, body, labels });
		return response.data.html_url;
	}

	async listReviewComments(owner: string, repo: string, prNumber: number, reviewId: number): Promise<ReviewComment[]> {
		try {
			const { data } = await this.octokit.pulls.listReviewComments({
				owner,
				repo,
				pull_number: prNumber,
				review_id: reviewId,
			});
			return data.map((rc) => ({
				id: rc.id,
				body: rc.body ?? "",
				user: rc.user ? { login: rc.user.login } : undefined,
				path: rc.path,
				line: rc.line,
			}));
		} catch {
			return [];
		}
	}
}
