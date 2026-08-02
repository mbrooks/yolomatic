import type { ExecutionResult } from "../../executor/index.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { SessionState } from "../../session/store.js";
import { generateCommitMessage } from "../../workspace/commit-message.js";
import { ExecuteSessionReporter } from "./execute-session-reporter.js";
import { appendAdminLink, resolveAdminIssueUrl } from "./comment-links.js";

export class ExecuteSessionDelivery {
	constructor(
		private readonly deps: {
			sessions: SessionRepository;
			workspaces: WorkspaceService;
			github: GitHubService;
			defaultBranch?: string;
			resolveDefaultBranch?: (owner: string, repo: string) => string;
			reporter: ExecuteSessionReporter;
			issueAdminLinkInCommentsEnabled?: boolean;
			adminBaseUrl?: string;
		},
	) {}

	private adminIssueUrl(owner: string, repo: string, issueNumber: number): string | undefined {
		return resolveAdminIssueUrl(this.deps.adminBaseUrl, this.deps.issueAdminLinkInCommentsEnabled, owner, repo, issueNumber);
	}

	private withLink(owner: string, repo: string, issueNumber: number, body: string): string {
		return appendAdminLink(body, this.adminIssueUrl(owner, repo, issueNumber));
	}

	async deliverCompletion(
		current: SessionState,
		result: ExecutionResult,
	): Promise<void> {
		const { owner, repo, issueNumber } = current;
		let prUrl: string | undefined;
		let deliveryOutcome: "pr-created" | "pr-existed" | "no-changes" = "no-changes";

		try {
			const worktreePath = current.workspacePath;
			const preStatus = await this.deps.workspaces.getGitStatus(owner, repo, issueNumber).catch(() => "(unknown)");
			process.stdout.write(`[execute] pre-commit status for ${repo}#${issueNumber} at ${worktreePath}:\n${preStatus}\n`);

			const pushed = await this.deps.workspaces.commitAndPush(
				owner,
				repo,
				issueNumber,
				generateCommitMessage(current.labels, issueNumber, result.summary),
			);

			if (!pushed) {
				const postStatus = await this.deps.workspaces.getGitStatus(owner, repo, issueNumber).catch(() => "(unknown)");
				process.stdout.write(`[execute] commitAndPush returned false for ${repo}#${issueNumber}. worktree=${worktreePath}\nstatus=${postStatus}\n`);

				await this.deps.github.postComment(
					owner,
					repo,
					issueNumber,
					this.withLink(owner, repo, issueNumber, [
						"**Yeetomatic Complete**",
						"",
						"Summary:",
						result.summary || "No summary provided.",
						"",
						"No code changes were necessary.",
						"",
						"<details>",
						"<summary>Delivery diagnostics</summary>",
						"",
						`Worktree: \`${worktreePath}\``,
						"",
						"Git status:",
						"```",
						postStatus || "(clean)",
						"```",
						"</details>",
					].join("\n")),
				);

				await this.deps.sessions.updateStatus(owner, repo, issueNumber, "complete");
				return;
			}

			const postStatus = await this.deps.workspaces.getGitStatus(owner, repo, issueNumber).catch(() => "(unknown)");
			process.stdout.write(`[execute] post-commit status for ${repo}#${issueNumber}: ${postStatus}\n`);

			const prResult = await this.createPR(owner, repo, issueNumber, current.title, result, current);
			prUrl = prResult.url;
			deliveryOutcome = prResult.outcome;
		} catch (error) {
			await this.deps.reporter.handleDeliveryFailure(owner, repo, issueNumber, current, error);
			return;
		}

		await this.deps.sessions.updateStatus(owner, repo, issueNumber, "complete");
		process.stdout.write(`[execute] marked complete ${repo}#${issueNumber}\n`);

		if (deliveryOutcome === "pr-created" && prUrl) {
			await this.deps.github.addLabels(owner, repo, issueNumber, ["yeetomatic-pr-created"]);
			await this.deps.github.postComment(
				owner,
				repo,
				issueNumber,
				this.withLink(owner, repo, issueNumber, [
					"**Yeetomatic Complete**",
					"",
					`PR created: ${prUrl}`,
					"",
					"Summary:",
					result.summary || "No summary provided.",
					"",
					"Ready for review.",
				].join("\n")),
			);
		} else if (deliveryOutcome === "pr-existed" && prUrl) {
			await this.deps.github.addLabels(owner, repo, issueNumber, ["yeetomatic-pr-created"]);
			await this.deps.github.postComment(
				owner,
				repo,
				issueNumber,
				this.withLink(owner, repo, issueNumber, [
					"**Yeetomatic Complete**",
					"",
					`PR already exists: ${prUrl}`,
					"",
					"Summary:",
					result.summary || "No summary provided.",
					"",
					"Ready for review.",
				].join("\n")),
			);
		} else {
			await this.deps.github.postComment(
				owner,
				repo,
				issueNumber,
				this.withLink(owner, repo, issueNumber, [
					"**Yeetomatic Complete**",
					"",
					"Summary:",
					result.summary || "No summary provided.",
					"",
					"No code changes were necessary.",
				].join("\n")),
			);
		}
	}

	private async createPR(
		owner: string,
		repo: string,
		issueNumber: number,
		issueTitle: string,
		result: import("../../executor/index.js").ExecutionResult,
		current: import("../../session/store.js").SessionState,
	): Promise<{ url?: string; outcome: "pr-created" | "pr-existed" | "no-changes" }> {
		const base = this.deps.resolveDefaultBranch?.(owner, repo) ?? this.deps.defaultBranch ?? "main";
		const head = `yeetomatic/issue-${issueNumber}`;

		const gitDiff = await this.deps.workspaces.getGitDiff(owner, repo, issueNumber).catch(() => "");
		const prBody = this.buildPRBody(issueNumber, current, result, gitDiff);

		try {
			const pr = await this.deps.github.createPullRequest(
				owner,
				repo,
				`Yeetomatic: ${issueTitle}`,
				prBody,
				head,
				base,
			);
			if (pr) {
				await this.deps.sessions.associatePR(owner, repo, issueNumber, pr.number, pr.html_url);
				return { url: pr.html_url, outcome: "pr-created" };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("A pull request already exists")) {
				const existing = await this.deps.github.listPullRequests(owner, repo, {
					head: `${owner}:${head}`,
					base,
					state: "open",
				});
				if (existing.length > 0) {
					const pr = existing[0];
					await this.deps.sessions.associatePR(owner, repo, issueNumber, pr.number, pr.html_url);
					return { url: pr.html_url, outcome: "pr-existed" };
				}
			}
			if (message.includes("No commits between")) {
				return { outcome: "no-changes" };
			}
			throw error;
		}
		return { outcome: "no-changes" };
	}

	private buildPRBody(
		issueNumber: number,
		current: import("../../session/store.js").SessionState,
		result: import("../../executor/index.js").ExecutionResult,
		gitDiff: string,
	): string {
		const issueContext = current.body
			? `## Issue Context\n\n**Title:** ${current.title}\n\n${current.body.slice(0, 2000)}${current.body.length > 2000 ? "\n\n..." : ""}`
			: `## Issue Context\n\n**Title:** ${current.title}`;

		const summarySection = result.summary
			? `## Summary\n\n${result.summary}`
			: "";

		const changesSection = gitDiff
			? `## Changes\n\n\`\`\`diff\n${gitDiff.slice(0, 5000)}${gitDiff.length > 5000 ? "\n... (truncated)" : ""}\n\`\`\``
			: "";

		const parts = [
			`Fixes #${issueNumber}`,
			summarySection,
			issueContext,
			changesSection,
		].filter(Boolean);

		return parts.join("\n\n");
	}
}
