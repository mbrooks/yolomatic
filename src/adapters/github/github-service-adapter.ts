import { Octokit } from "@octokit/rest";
import type {
	CreatedPR,
	GitHubService,
	IssueTemplate,
	PullRequestInfo,
	ReviewComment,
} from "../../ports/github-service.js";
import { createOctokit } from "./octokit.js";

export class GitHubServiceAdapter implements GitHubService {
	private readonly octokit: Octokit;

	constructor(options: { githubToken: string; octokit?: Octokit }) {
		this.octokit = options.octokit ?? createOctokit(options.githubToken);
	}

	async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<number> {
		const response = await this.octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body });
		return response.data.id;
	}

	async postPRComment(owner: string, repo: string, prNumber: number, body: string): Promise<number> {
		const response = await this.octokit.issues.createComment({ owner, repo, issue_number: prNumber, body });
		return response.data.id;
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

	async updatePullRequestBranch(owner: string, repo: string, prNumber: number, expectedHeadSha?: string): Promise<void> {
		try {
			await this.octokit.pulls.updateBranch({
				owner,
				repo,
				pull_number: prNumber,
				...(expectedHeadSha ? { expected_head_sha: expectedHeadSha } : {}),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/(merge conflict|422|409|cannot be merged|non-fast-forward|unresolvable)/i.test(message)) {
				throw new Error(
					`[github] update-branch failed for ${owner}/${repo}#${prNumber}: ${message}. ` +
						`Resolve the conflict manually before relaunching the worker.`,
				);
			}
			throw error;
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

	async getIssue(owner: string, repo: string, issueNumber: number): Promise<{ state: string; body?: string } | null> {
		try {
			const { data } = await this.octokit.issues.get({ owner, repo, issue_number: issueNumber });
			return { state: data.state, body: data.body ?? undefined };
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
			content: Buffer.from(`# ${repo}\n\nAuto-initialized by Yeetomatic.\n`).toString("base64"),
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

	async updateIssueBody(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
		await this.octokit.issues.update({ owner, repo, issue_number: issueNumber, body });
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
				visibility: this.normalizeVisibility(repo.visibility, repo.private),
			}));
		} catch {
			return [];
		}
	}

	async getRepository(owner: string, repo: string): Promise<import("../../ports/github-service.js").RepositoryInfo | null> {
		try {
			const { data } = await this.octokit.repos.get({ owner, repo });
			return {
				owner: data.owner?.login ?? owner,
				repo: data.name ?? repo,
				fullName: data.full_name ?? `${owner}/${repo}`,
				visibility: this.normalizeVisibility(data.visibility, data.private),
			};
		} catch {
			return null;
		}
	}

	async getCollaboratorPermissionLevel(
		owner: string,
		repo: string,
		username: string,
	): Promise<import("../../ports/github-service.js").CollaboratorPermission | null> {
		try {
			const { data } = await this.octokit.repos.getCollaboratorPermissionLevel({ owner, repo, username });
			const permission = data?.permission;
			if (
				permission === "admin" ||
				permission === "maintain" ||
				permission === "write" ||
				permission === "triage" ||
				permission === "read"
			) {
				return permission;
			}
			return null;
		} catch {
			return null;
		}
	}

	async isCollaborator(owner: string, repo: string, username: string): Promise<boolean> {
		try {
			const response = await this.octokit.repos.checkCollaborator({ owner, repo, username });
			return response?.status === 204;
		} catch {
			return false;
		}
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
