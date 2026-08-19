import type { Octokit } from "@octokit/rest";
import type {
	CreatedIssue,
	IssueTemplate,
	OpenIssue,
} from "../../../ports/github-service.js";
import type {
	GatewayIssueComment,
	GatewayIssueDetail,
	GatewayIssueUpdateFields,
} from "../../../ports/github-gateway-service.js";
import { mapIssueComment, mapIssueLabels } from "./shared/mappers.js";
import { buildStatefulUpdateFields } from "./shared/update-payloads.js";

/**
 * Focused delegate for issue reads, updates, comments, labels, templates, and
 * issue search. Preserves the method-specific null/empty fallbacks and the
 * special 404 handling for `setLabels` (empty-label-on-unlabeled-issue) and
 * `removeLabel`.
 */
export class IssueDelegate {
	constructor(private readonly octokit: Octokit) {}

	async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<number> {
		const response = await this.octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body });
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

	async getIssue(
		owner: string,
		repo: string,
		issueNumber: number,
	): Promise<{ state: string; title?: string; body?: string } | null> {
		try {
			const { data } = await this.octokit.issues.get({ owner, repo, issue_number: issueNumber });
			return { state: data.state, title: data.title ?? undefined, body: data.body ?? undefined };
		} catch {
			return null;
		}
	}

	async getIssueDetail(owner: string, repo: string, issueNumber: number): Promise<GatewayIssueDetail | null> {
		try {
			const { data } = await this.octokit.issues.get({ owner, repo, issue_number: issueNumber });
			return {
				number: data.number,
				title: data.title,
				body: data.body ?? "",
				state: data.state === "closed" ? "closed" : "open",
				labels: mapIssueLabels(data.labels),
				assignees: data.assignees?.map((a) => a.login).filter(Boolean) ?? [],
				html_url: data.html_url,
				created_at: data.created_at,
				updated_at: data.updated_at,
			};
		} catch {
			return null;
		}
	}

	async createIssue(
		owner: string,
		repo: string,
		title: string,
		body: string,
		labels?: string[],
		assignees?: string[],
	): Promise<CreatedIssue> {
		const { data } = await this.octokit.issues.create({ owner, repo, title, body, labels, assignees });
		return { number: data.number, html_url: data.html_url };
	}

	async fileSelfReport(title: string, body: string, labels: string[]): Promise<string> {
		const { SelfMonitor } = await import("../../../self-monitor/index.js");
		const { owner, repo } = SelfMonitor.getTargetRepo();
		const response = await this.octokit.issues.create({ owner, repo, title, body, labels });
		return response.data.html_url;
	}

	async listIssueComments(owner: string, repo: string, issueNumber: number): Promise<GatewayIssueComment[]> {
		try {
			const { data } = await this.octokit.issues.listComments({
				owner,
				repo,
				issue_number: issueNumber,
				per_page: 100,
			});
			return data.map((comment) => mapIssueComment(comment));
		} catch {
			return [];
		}
	}

	async listOpenIssues(owner: string, repo: string): Promise<OpenIssue[]> {
		try {
			const { data } = await this.octokit.issues.listForRepo({ owner, repo, state: "open" });
			return data.map((i) => ({
				number: i.number,
				title: i.title,
				body: i.body ?? "",
				state: i.state,
				labels: mapIssueLabels(i.labels),
				assignees: i.assignees?.map((a) => a.login).filter(Boolean) ?? [],
				html_url: i.html_url,
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

	async listRelatedIssues(
		owner: string,
		repo: string,
		query: string,
		limit = 10,
	): Promise<Array<{ number: number; title: string; state: string }>> {
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

	async updateIssueAssignees(owner: string, repo: string, issueNumber: number, assignees: string[]): Promise<void> {
		await this.octokit.issues.update({ owner, repo, issue_number: issueNumber, assignees });
	}

	async closeIssue(owner: string, repo: string, issueNumber: number): Promise<void> {
		await this.octokit.issues.update({ owner, repo, issue_number: issueNumber, state: "closed" });
	}

	async updateIssueBody(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
		await this.octokit.issues.update({ owner, repo, issue_number: issueNumber, body });
	}

	async updateIssueTitle(owner: string, repo: string, issueNumber: number, title: string): Promise<void> {
		await this.octokit.issues.update({ owner, repo, issue_number: issueNumber, title });
	}

	async updateIssue(
		owner: string,
		repo: string,
		issueNumber: number,
		fields: GatewayIssueUpdateFields,
	): Promise<void> {
		const update = buildStatefulUpdateFields(fields);
		if (fields.assignees !== undefined) update.assignees = fields.assignees;
		if (fields.labels !== undefined) update.labels = fields.labels;
		if (Object.keys(update).length === 0) return;
		await this.octokit.issues.update({ owner, repo, issue_number: issueNumber, ...update });
	}

	async setLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
		try {
			await this.octokit.issues.setLabels({ owner, repo, issue_number: issueNumber, labels });
		} catch (error) {
			const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
			if (status === 404 && labels.length === 0) {
				// Setting an empty label list on an unlabeled issue 404s; treat as success.
				return;
			}
			throw error;
		}
	}
}
