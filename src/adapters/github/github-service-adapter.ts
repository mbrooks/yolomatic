import { Octokit } from "@octokit/rest";
import type {
	CreatedPR,
	GitHubService,
	IssueTemplate,
	PollIssue,
	PollIssueComment,
	PollIssueEvent,
	PollPRReview,
	PollPRReviewComment,
	PollPullRequest,
	PullRequestInfo,
	ReviewComment,
} from "../../ports/github-service.js";
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

	async initializeEmptyRepo(owner: string, repo: string, defaultBranch: string): Promise<void> {
		const { data } = await this.octokit.repos.get({ owner, repo });
		const branch = data.default_branch ?? defaultBranch;

		await this.octokit.repos.createOrUpdateFileContents({
			owner,
			repo,
			path: "README.md",
			message: "Initial commit",
			content: Buffer.from(`# ${repo}\n\nAuto-initialized by TARS.\n`).toString("base64"),
			branch,
		});
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

	async listLabels(owner: string, repo: string): Promise<string[]> {
		try {
			const { data } = await this.octokit.issues.listLabelsForRepo({ owner, repo });
			return data.map((l) => l.name);
		} catch {
			return [];
		}
	}

	async getIssueTemplates(owner: string, repo: string): Promise<IssueTemplate[]> {
		try {
			const { data } = await this.octokit.repos.getContent({
				owner,
				repo,
				path: ".github/ISSUE_TEMPLATE",
			});
			if (!Array.isArray(data)) return [];
			const templates: IssueTemplate[] = [];
			for (const item of data) {
				if (item.type !== "file") continue;
				const name = item.name.replace(/\.md$/, "").replace(/\.yaml$/, "").replace(/\.yml$/, "");
				try {
					const { data: fileData } = await this.octokit.repos.getContent({
						owner,
						repo,
						path: item.path,
					});
					if ("content" in fileData && typeof fileData.content === "string") {
						const body = Buffer.from(fileData.content, "base64").toString("utf8");
						templates.push({ name, body });
					}
				} catch {
					// skip unreadable templates
				}
			}
			return templates;
		} catch {
			return [];
		}
	}

	async listRecentCommits(owner: string, repo: string, limit = 10): Promise<string[]> {
		try {
			const { data } = await this.octokit.repos.listCommits({ owner, repo, per_page: limit });
			return data.map((c) => `${c.sha.slice(0, 7)}: ${c.commit.message.split("\n")[0]}`);
		} catch {
			return [];
		}
	}

	async listRelatedIssues(owner: string, repo: string, query: string, limit = 10): Promise<Array<{ number: number; title: string; state: string }>> {
		try {
			const { data } = await this.octokit.request("GET /search/issues", {
				q: `repo:${owner}/${repo} is:issue ${query} in:title`,
				per_page: limit,
			});
			return data.items.map((i) => ({ number: i.number, title: i.title, state: i.state }));
		} catch {
			return [];
		}
	}

	async listOpenIssues(owner: string, repo: string): Promise<import("../../ports/github-service.js").OpenIssue[]> {
		try {
			const { data } = await this.octokit.issues.listForRepo({ owner, repo, state: "open" });
			return data.map((i) => ({
				number: i.number,
				title: i.title,
				body: i.body ?? "",
				state: i.state,
				labels: i.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
				assignees: i.assignees?.map((a) => a.login).filter(Boolean) ?? [],
				html_url: i.html_url,
			}));
		} catch {
			return [];
		}
	}

	async listPendingInvitations(): Promise<import("../../ports/github-service.js").PendingInvitation[]> {
		try {
			const { data } = await this.octokit.repos.listInvitationsForAuthenticatedUser();
			return data.map((inv) => ({
				id: inv.id,
				repository: {
					full_name: inv.repository?.full_name ?? "",
					name: inv.repository?.name ?? "",
					owner: { login: inv.repository?.owner?.login ?? "" },
				},
				inviter: inv.inviter ? { login: inv.inviter.login } : null,
				permissions: inv.permissions ?? "read",
				created_at: inv.created_at,
				html_url: inv.html_url ?? "",
			}));
		} catch {
			return [];
		}
	}

	async acceptInvitation(invitationId: number): Promise<void> {
		await this.octokit.repos.acceptInvitationForAuthenticatedUser({ invitation_id: invitationId });
	}

	async updateIssueAssignees(owner: string, repo: string, issueNumber: number, assignees: string[]): Promise<void> {
		await this.octokit.issues.update({ owner, repo, issue_number: issueNumber, assignees });
	}

	async closeIssue(owner: string, repo: string, issueNumber: number): Promise<void> {
		await this.octokit.issues.update({ owner, repo, issue_number: issueNumber, state: "closed" });
	}

	async getAuthenticatedUser(): Promise<{ login: string } | null> {
		try {
			const { data } = await this.octokit.users.getAuthenticated();
			if (data.login) {
				return { login: data.login };
			}
			return null;
		} catch {
			return null;
		}
	}

	async listAccessibleRepositories(): Promise<import("../../ports/github-service.js").AccessibleRepo[]> {
		try {
			const { data } = await this.octokit.repos.listForAuthenticatedUser({ per_page: 100, sort: "updated" });
			return data.map((repo) => ({
				owner: repo.owner?.login ?? "",
				repo: repo.name ?? "",
				fullName: repo.full_name ?? "",
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
				state: "all",
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
}
