import { Octokit } from "@octokit/rest";

export interface PullRequestSnapshot {
	head: {
		ref: string;
	};
	state: string;
	merged: boolean;
}

export interface ReviewCommentSnapshot {
	id: number;
	body: string;
	user: {
		login: string;
	};
	path?: string;
	line?: number | null;
}

export class GitHubClient {
	public constructor(private readonly octokit: Octokit) {}

	addLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<unknown> {
		return this.octokit.issues.addLabels({
			owner,
			repo,
			issue_number: issueNumber,
			labels,
		});
	}

	async removeLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<void> {
		try {
			await this.octokit.issues.removeLabel({
				owner,
				repo,
				issue_number: issueNumber,
				name: label,
			});
		} catch (error) {
			const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
			if (status !== 404) {
				throw error;
			}
		}
	}

	createComment(owner: string, repo: string, issueNumber: number, body: string): Promise<unknown> {
		return this.octokit.issues.createComment({
			owner,
			repo,
			issue_number: issueNumber,
			body,
		});
	}

	createIssue(owner: string, repo: string, title: string, body: string, labels: string[]): Promise<unknown> {
		return this.octokit.issues.create({
			owner,
			repo,
			title,
			body,
			labels,
		});
	}

	async getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestSnapshot> {
		const { data } = await this.octokit.pulls.get({
			owner,
			repo,
			pull_number: prNumber,
		});

		return {
			head: {
				ref: data.head.ref,
			},
			state: data.state,
			merged: data.merged ?? false,
		};
	}

	async createPullRequest(
		owner: string,
		repo: string,
		title: string,
		body: string,
		head: string,
		base: string,
	): Promise<{ number: number; url: string }> {
		const pr = await this.octokit.pulls.create({
			owner,
			repo,
			title,
			body,
			head,
			base,
		});

		return {
			number: pr.data.number,
			url: pr.data.html_url,
		};
	}

	async listOpenPullRequests(owner: string, repo: string, head: string, base: string): Promise<Array<{ number: number; url: string }>> {
		const response = await this.octokit.pulls.list({
			owner,
			repo,
			head,
			base,
			state: "open",
		});

		return response.data.map((pr) => ({
			number: pr.number,
			url: pr.html_url,
		}));
	}

	async listReviewComments(owner: string, repo: string, prNumber: number, reviewId: number): Promise<ReviewCommentSnapshot[]> {
		const { data } = await this.octokit.pulls.listReviewComments({
			owner,
			repo,
			pull_number: prNumber,
			review_id: reviewId,
		});

		return data.map((comment) => ({
			id: comment.id,
			body: comment.body ?? "",
			user: { login: comment.user?.login ?? "" },
			path: comment.path,
			line: comment.line,
		}));
	}
}
