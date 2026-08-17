import { Octokit } from "@octokit/rest";
import type {
	GitHubPollingService,
	PollIssue,
	PollIssueComment,
	PollIssueEvent,
	PollPRReview,
	PollPRReviewComment,
	PollPullRequest,
} from "../../ports/github-polling-service.js";
import { createOctokit } from "./octokit.js";

export class GitHubPollingAdapter implements GitHubPollingService {
	private readonly octokit: Octokit;

	constructor(options: { githubToken: string; octokit?: Octokit }) {
		this.octokit = options.octokit ?? createOctokit(options.githubToken);
	}

	async listAccessibleRepositories(): Promise<import("../../ports/github-service.js").AccessibleRepo[]> {
		try {
			const { data } = await this.octokit.repos.listForAuthenticatedUser({ per_page: 100, sort: "updated" });
			return data.map((repo) => ({
				owner: repo.owner?.login ?? "",
				repo: repo.name ?? "",
				fullName: repo.full_name ?? "",
				visibility: this.normalizeVisibility(repo.visibility, repo.private),
			}));
		} catch {
			return [];
		}
	}

	async listIssuesUpdatedSince(owner: string, repo: string, since: string): Promise<PollIssue[]> {
		try {
			const { data } = await this.octokit.issues.listForRepo({
				owner,
				repo,
				state: "open",
				since,
				sort: "updated",
				direction: "asc",
				per_page: 100,
			});
			return data.map((issue) => this.mapPollIssue(issue));
		} catch {
			return [];
		}
	}

	async listIssueEventsSince(owner: string, repo: string, since: string): Promise<PollIssueEvent[]> {
		const issues = await this.listIssuesUpdatedSince(owner, repo, since);
		const sinceMs = Date.parse(since);
		const events: PollIssueEvent[] = [];
		for (const issue of issues) {
			try {
				const { data } = await (this.octokit.issues as any).listEventsForTimeline({
					owner,
					repo,
					issue_number: issue.number,
					per_page: 100,
				});
				for (const event of data as any[]) {
					const createdAt = String(event.created_at ?? "");
					if (!createdAt || Date.parse(createdAt) < sinceMs) continue;
					if (event.event !== "assigned" && event.event !== "unassigned") continue;
					events.push({
						id: Number(event.id ?? 0),
						event: String(event.event),
						created_at: createdAt,
						actor: event.actor?.login ? { login: event.actor.login } : undefined,
						assignee: event.assignee?.login ? { login: event.assignee.login } : undefined,
						issue,
					});
				}
			} catch {
				// Keep polling other issues.
			}
		}
		return events;
	}

	async listIssueCommentsSince(owner: string, repo: string, since: string): Promise<PollIssueComment[]> {
		try {
			const { data } = await this.octokit.issues.listCommentsForRepo({
				owner,
				repo,
				since,
				sort: "updated",
				direction: "asc",
				per_page: 100,
			});
			const comments: PollIssueComment[] = [];
			for (const comment of data) {
				const issueNumber = this.issueNumberFromUrl(comment.issue_url);
				if (!issueNumber) continue;
				const issue = await this.getPollIssue(owner, repo, issueNumber);
				if (!issue) continue;
				comments.push({
					id: comment.id,
					body: comment.body ?? "",
					created_at: comment.created_at,
					updated_at: comment.updated_at ?? comment.created_at,
					user: { login: comment.user?.login ?? "", type: comment.user?.type },
					issue,
				});
			}
			return comments;
		} catch {
			return [];
		}
	}

	async listPullRequestsUpdatedSince(owner: string, repo: string, since: string): Promise<PollPullRequest[]> {
		try {
			const { data } = await this.octokit.pulls.list({
				owner,
				repo,
				state: "all",
				sort: "updated",
				direction: "asc",
				per_page: 100,
			} as any);
			const sinceMs = Date.parse(since);
			return data
				.map((pr) => this.mapPollPullRequest(pr))
				.filter((pr) => Date.parse(pr.updated_at) >= sinceMs);
		} catch {
			return [];
		}
	}

	async listPRReviewsSince(owner: string, repo: string, since: string): Promise<PollPRReview[]> {
		const prs = await this.listPullRequestsUpdatedSince(owner, repo, since);
		const sinceMs = Date.parse(since);
		const reviews: PollPRReview[] = [];
		for (const pr of prs) {
			try {
				const { data } = await this.octokit.pulls.listReviews({
					owner,
					repo,
					pull_number: pr.number,
					per_page: 100,
				});
				for (const review of data) {
					const submittedAt = review.submitted_at ?? "";
					if (!submittedAt || Date.parse(submittedAt) < sinceMs) continue;
					reviews.push({
						id: review.id,
						body: review.body ?? null,
						state: review.state,
						submitted_at: submittedAt,
						user: { login: review.user?.login ?? "" },
						pull_request: pr,
					});
				}
			} catch {
				// Keep polling other PRs.
			}
		}
		return reviews;
	}

	async listPRReviewCommentsSince(owner: string, repo: string, since: string): Promise<PollPRReviewComment[]> {
		try {
			const { data } = await this.octokit.pulls.listReviewCommentsForRepo({
				owner,
				repo,
				since,
				sort: "updated",
				direction: "asc",
				per_page: 100,
			} as any);
			const comments: PollPRReviewComment[] = [];
			for (const comment of data as any[]) {
				const prNumber = Number(comment.pull_request_url?.split("/").pop());
				if (!prNumber) continue;
				const pr = await this.getPollPullRequest(owner, repo, prNumber);
				if (!pr) continue;
				comments.push({
					id: Number(comment.id),
					body: String(comment.body ?? ""),
					created_at: String(comment.created_at),
					updated_at: String(comment.updated_at ?? comment.created_at),
					user: { login: String(comment.user?.login ?? "") },
					path: comment.path,
					line: comment.line,
					pull_request: pr,
				});
			}
			return comments;
		} catch {
			return [];
		}
	}

	async getDefaultBranchHeadSha(owner: string, repo: string, branch: string): Promise<string | null> {
		try {
			const { data } = await this.octokit.repos.getBranch({ owner, repo, branch });
			return String(data?.commit?.sha ?? "");
		} catch {
			return null;
		}
	}

	private async getPollIssue(owner: string, repo: string, issueNumber: number): Promise<PollIssue | null> {
		try {
			const { data } = await this.octokit.issues.get({ owner, repo, issue_number: issueNumber });
			return this.mapPollIssue(data);
		} catch {
			return null;
		}
	}

	private async getPollPullRequest(owner: string, repo: string, prNumber: number): Promise<PollPullRequest | null> {
		try {
			const { data } = await this.octokit.pulls.get({ owner, repo, pull_number: prNumber });
			return this.mapPollPullRequest(data);
		} catch {
			return null;
		}
	}

	private mapPollIssue(issue: any): PollIssue {
		return {
			number: Number(issue.number),
			title: String(issue.title ?? ""),
			body: issue.body ?? null,
			state: String(issue.state ?? ""),
			created_at: String(issue.created_at ?? new Date().toISOString()),
			updated_at: String(issue.updated_at ?? issue.created_at ?? new Date().toISOString()),
			labels: (issue.labels ?? []).map((label: any) => ({ name: typeof label === "string" ? label : label.name })),
			assignee: issue.assignee?.login ? { login: issue.assignee.login } : null,
			assignees: (issue.assignees ?? []).map((assignee: any) => ({ login: assignee.login })).filter((a: { login?: string }) => !!a.login),
			user: issue.user?.login ? { login: issue.user.login } : undefined,
			pull_request: issue.pull_request?.url ? { url: issue.pull_request.url } : undefined,
		};
	}

	private mapPollPullRequest(pr: any): PollPullRequest {
		return {
			number: Number(pr.number),
			title: String(pr.title ?? ""),
			body: pr.body ?? null,
			state: String(pr.state ?? ""),
			merged: Boolean(pr.merged ?? false),
			created_at: String(pr.created_at ?? new Date().toISOString()),
			updated_at: String(pr.updated_at ?? pr.created_at ?? new Date().toISOString()),
			head: { ref: String(pr.head?.ref ?? "") },
			user: pr.user?.login ? { login: pr.user.login } : undefined,
		};
	}

	private issueNumberFromUrl(url?: string): number | null {
		const raw = url?.split("/").pop();
		if (!raw) return null;
		const parsed = Number(raw);
		return Number.isFinite(parsed) ? parsed : null;
	}

	private normalizeVisibility(
		visibility: unknown,
		isPrivate: unknown,
	): "public" | "private" | "internal" {
		const normalized = String(visibility ?? "").toLowerCase();
		if (normalized === "public" || normalized === "private" || normalized === "internal") {
			return normalized;
		}
		return isPrivate ? "private" : "public";
	}
}
