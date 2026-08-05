import type { ExecutionResult } from "../../executor/index.js";
import type { ExecutionService } from "../../ports/execution-service.js";
import type { GitHubService, PullRequestInfo } from "../../ports/github-service.js";
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
			executor: ExecutionService;
			defaultBranch?: string;
			resolveDefaultBranch?: (owner: string, repo: string) => string;
			reporter: ExecuteSessionReporter;
			issueAdminLinkInCommentsEnabled?: boolean;
			adminBaseUrl?: string;
			resolveAdminBaseUrl?: () => string | undefined;
			resolveIssueAdminLinkInCommentsEnabled?: () => boolean | undefined;
			/** Delay between mergeability polls when GitHub reports `mergeable: null`. */
			mergeabilityPollDelayMs?: number;
			/** Max polls while `mergeable` is `null` before giving up (~30s default). */
			mergeabilityPollMaxAttempts?: number;
			/** Max worker-driven rebase/rework attempts before failing delivery. */
			maxConflictAttempts?: number;
		},
	) {}

	private adminIssueUrl(owner: string, repo: string, issueNumber: number): string | undefined {
		const adminBaseUrl = this.deps.resolveAdminBaseUrl?.() ?? this.deps.adminBaseUrl;
		const issueAdminLinkInCommentsEnabled =
			this.deps.resolveIssueAdminLinkInCommentsEnabled?.() ?? this.deps.issueAdminLinkInCommentsEnabled;
		return resolveAdminIssueUrl(adminBaseUrl, issueAdminLinkInCommentsEnabled, owner, repo, issueNumber);
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
		let prNumber: number | undefined;

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
			prNumber = prResult.number;
			deliveryOutcome = prResult.outcome;

			if (deliveryOutcome !== "no-changes" && prNumber !== undefined) {
				const gate = await this.runMergeabilityGate(owner, repo, issueNumber, prNumber, current);
				if (gate === "conflict-failed") {
					return;
				}
			}
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
	): Promise<{ url?: string; number?: number; outcome: "pr-created" | "pr-existed" | "no-changes" }> {
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
				true,
			);
			if (pr) {
				await this.deps.sessions.associatePR(owner, repo, issueNumber, pr.number, pr.html_url);
				return { url: pr.html_url, number: pr.number, outcome: "pr-created" };
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
					return { url: pr.html_url, number: pr.number, outcome: "pr-existed" };
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

	/**
	 * Gate the ready-for-review transition on GitHub mergeability. When the PR
	 * conflicts with the base branch, launch up to `maxConflictAttempts` worker
	 * iterations to `git rebase origin/main` and rework the conflicts. Returns
	 * `"clean"` when the PR is mergeable (and already flipped ready), or
	 * `"conflict-failed"` when delivery must fail with the PR left as a draft.
	 */
	private async runMergeabilityGate(
		owner: string,
		repo: string,
		issueNumber: number,
		prNumber: number,
		current: SessionState,
	): Promise<"clean" | "conflict-failed"> {
		const info = await this.pollMergeability(owner, repo, prNumber);
		if (!info || info.mergeable === null || info.mergeable === undefined) {
			await this.failConflictDelivery(
				owner,
				repo,
				issueNumber,
				prNumber,
				current,
				"GitHub could not compute mergeability for this pull request within the polling window.",
			);
			return "conflict-failed";
		}

		if (!this.hasConflicts(info)) {
			await this.markReadyIfDraft(owner, repo, prNumber, info);
			return "clean";
		}

		const maxAttempts = this.deps.maxConflictAttempts ?? 2;
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			const reworked = await this.runConflictRework(owner, repo, issueNumber, prNumber, current, attempt, maxAttempts);
			if (!reworked) {
				const files = await this.listConflictedFiles(owner, repo, issueNumber);
				await this.failConflictDelivery(
					owner,
					repo,
					issueNumber,
					prNumber,
					current,
					`Worker rework attempt ${attempt} of ${maxAttempts} did not produce a pushable branch.`,
					files,
				);
				return "conflict-failed";
			}

			const recheck = await this.pollMergeability(owner, repo, prNumber);
			if (recheck && recheck.mergeable !== null && recheck.mergeable !== undefined && !this.hasConflicts(recheck)) {
				await this.markReadyIfDraft(owner, repo, prNumber, recheck);
				return "clean";
			}
		}

		const files = await this.listConflictedFiles(owner, repo, issueNumber);
		await this.failConflictDelivery(
			owner,
			repo,
			issueNumber,
			prNumber,
			current,
			`Merge conflicts with the base branch could not be resolved after ${maxAttempts} rework attempt${maxAttempts === 1 ? "" : "s"}.`,
			files,
		);
		return "conflict-failed";
	}

	private hasConflicts(info: PullRequestInfo): boolean {
		return info.mergeable === false || info.mergeableState === "dirty";
	}

	private async markReadyIfDraft(owner: string, repo: string, prNumber: number, info: PullRequestInfo): Promise<void> {
		if (info.draft === true) {
			await this.deps.github.markPullRequestReadyForReview(owner, repo, prNumber);
		}
	}

	/**
	 * Poll `getPullRequest` until `mergeable` is non-null, bounded by
	 * `mergeabilityPollMaxAttempts` with `mergeabilityPollDelayMs` between tries.
	 */
	private async pollMergeability(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo | null> {
		const maxAttempts = this.deps.mergeabilityPollMaxAttempts ?? 30;
		const delayMs = this.deps.mergeabilityPollDelayMs ?? 1000;
		let info = await this.deps.github.getPullRequest(owner, repo, prNumber);
		for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
			if (!info || (info.mergeable !== null && info.mergeable !== undefined)) {
				return info;
			}
			await this.delay(delayMs);
			info = await this.deps.github.getPullRequest(owner, repo, prNumber);
		}
		return info;
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
	}

	/**
	 * Launch a worker iteration with a steering comment that tells the worker to
	 * `git rebase origin/main`, resolve conflict markers, and leave the worktree
	 * clean. After success, commit and push the rebased branch. Returns `true`
	 * when the branch was pushed and should be re-checked for mergeability.
	 */
	private async runConflictRework(
		owner: string,
		repo: string,
		issueNumber: number,
		prNumber: number,
		current: SessionState,
		attempt: number,
		maxAttempts: number,
	): Promise<boolean> {
		const expectedRemoteHead = (await this.deps.github.getPullRequest(owner, repo, prNumber))?.head.sha;
		const comment = [
			`Merge conflict rework attempt ${attempt} of ${maxAttempts}.`,
			"",
			"The pull request for this issue conflicts with the base branch.",
			"",
			"Run `git rebase origin/main` in the worktree, resolve all conflict markers, preserve the issue's intent, and leave the worktree clean (no unresolved conflicts).",
			"",
			"After resolving, finish the rebase. The control plane will commit, push, and re-check mergeability.",
		].join("\n");

		const reworkResult = await this.deps.executor.execute(current, comment);
		if (reworkResult.status === "failed" || reworkResult.status === "cancelled") {
			return false;
		}

		const branchName = current.branch ?? `yeetomatic/issue-${issueNumber}`;
		const commitMessage = generateCommitMessage(current.labels, issueNumber, reworkResult.summary);
		const pushed = await this.deps.workspaces.commitAndPushPath(
			current.workspacePath,
			branchName,
			commitMessage,
			undefined,
			expectedRemoteHead,
		);
		return pushed;
	}

	private async listConflictedFiles(owner: string, repo: string, issueNumber: number): Promise<string[]> {
		const status = await this.deps.workspaces.getGitStatus(owner, repo, issueNumber).catch(() => "");
		if (!status) return [];
		const files: string[] = [];
		for (const raw of status.split(/\r?\n/u)) {
			const match = /^(DD|AU|UD|UA|DU|AA|UU) (.+)$/u.exec(raw.trim());
			if (match) files.push(match[2]!.trim());
		}
		return files;
	}

	private async failConflictDelivery(
		owner: string,
		repo: string,
		issueNumber: number,
		prNumber: number,
		current: SessionState,
		reason: string,
		conflictedFiles: string[] = [],
	): Promise<void> {
		const fileList = conflictedFiles.length > 0
			? ["", "Conflicted files:", ...conflictedFiles.map((f) => `- \`${f}\``)].join("\n")
			: "";
		const prBody = [
			"**Yeetomatic could not deliver this pull request.**",
			"",
			reason,
			"",
			"A maintainer must resolve the merge conflicts manually. The PR remains a draft.",
			fileList,
		].filter(Boolean).join("\n");
		await this.deps.github.postPRComment(owner, repo, prNumber, prBody);
		await this.deps.reporter.handleDeliveryFailure(owner, repo, issueNumber, current, new Error(reason));
	}
}
