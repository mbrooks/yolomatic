import type { ExecutionResult } from "../../executor/index.js";
import type { ExecutionService } from "../../ports/execution-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { SessionState } from "../../session/store.js";
import { generateCommitMessage } from "../../workspace/commit-message.js";
import { ExecuteSessionReporter } from "./execute-session-reporter.js";
import { MergeConflictReworkService } from "./merge-conflict-rework.js";
import { appendAdminLink, resolveAdminIssueUrl } from "./comment-links.js";

/** Shared fallback for `getGitStatus` failures so delivery diagnostics still print. */
const UNKNOWN_GIT_STATUS = (): string => "(unknown)";
/** Shared fallback for `getGitDiff` failures so PR body building still succeeds. */
const EMPTY_GIT_DIFF = (): string => "";

export const PR_COMMANDS_COMMENT_MARKER = "\u003c!-- yolomatic: pr-commands --\u003e";

/**
 * Builds the static comment posted once on a Yolomatic-created PR listing
 * the available `/yolomatic` commands on PRs. The hidden marker lets
 * Yolomatic detect that the comment has already been posted so it is never
 * duplicated on edits or later events.
 */
export function buildPRCommandsComment(): string {
	return [
		PR_COMMANDS_COMMENT_MARKER,
		"**Yolomatic PR commands**",
		"",
		"- `/yolomatic fix-merge-conflicts` — ask Yolomatic to rebase this PR onto the default branch and resolve merge conflicts (authorized maintainers only).",
		"- `/yolomatic stop` — stop the active Yolomatic session for this PR (authorized maintainers only).",
		"",
		"These commands work on this PR's timeline for both webhook-delivered and polled events.",
	].join("\n");
}

export class ExecuteSessionDelivery {
	private readonly rework: MergeConflictReworkService;

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
	) {
		this.rework = new MergeConflictReworkService({
			github: deps.github,
			executor: deps.executor,
			workspaces: deps.workspaces,
			mergeabilityPollDelayMs: deps.mergeabilityPollDelayMs,
			mergeabilityPollMaxAttempts: deps.mergeabilityPollMaxAttempts,
			maxConflictAttempts: deps.maxConflictAttempts,
		});
	}

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
			const preStatus = await this.deps.workspaces.getGitStatus(owner, repo, issueNumber).catch(UNKNOWN_GIT_STATUS);
			process.stdout.write(`[execute] pre-commit status for ${repo}#${issueNumber} at ${worktreePath}:\n${preStatus}\n`);

			const pushed = await this.deps.workspaces.commitAndPush(
				owner,
				repo,
				issueNumber,
				generateCommitMessage(current.labels, issueNumber, result.summary),
			);

			if (!pushed) {
				const postStatus = await this.deps.workspaces.getGitStatus(owner, repo, issueNumber).catch(UNKNOWN_GIT_STATUS);
				process.stdout.write(`[execute] commitAndPush returned false for ${repo}#${issueNumber}. worktree=${worktreePath}\nstatus=${postStatus}\n`);

				await this.deps.github.postComment(
					owner,
					repo,
					issueNumber,
					this.withLink(owner, repo, issueNumber, [
						"**Yolomatic Complete**",
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

			const postStatus = await this.deps.workspaces.getGitStatus(owner, repo, issueNumber).catch(UNKNOWN_GIT_STATUS);
			process.stdout.write(`[execute] post-commit status for ${repo}#${issueNumber}: ${postStatus}\n`);

			const prResult = await this.createPR(owner, repo, issueNumber, current.title, result, current);
			prUrl = prResult.url;
			prNumber = prResult.number;
			deliveryOutcome = prResult.outcome;

			if (deliveryOutcome !== "no-changes" && prNumber !== undefined) {
				await this.postPRCommandsCommentOnce(owner, repo, prNumber);
			}

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
			await this.deps.github.addLabels(owner, repo, issueNumber, ["yolomatic-pr-created"]);
			await this.deps.github.postComment(
				owner,
				repo,
				issueNumber,
				this.withLink(owner, repo, issueNumber, [
					"**Yolomatic Complete**",
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
			await this.deps.github.addLabels(owner, repo, issueNumber, ["yolomatic-pr-created"]);
			await this.deps.github.postComment(
				owner,
				repo,
				issueNumber,
				this.withLink(owner, repo, issueNumber, [
					"**Yolomatic Complete**",
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
					"**Yolomatic Complete**",
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
		const head = `yolomatic/issue-${issueNumber}`;

		const gitDiff = await this.deps.workspaces.getGitDiff(owner, repo, issueNumber).catch(EMPTY_GIT_DIFF);
		const prBody = this.buildPRBody(issueNumber, current, result, gitDiff);

		try {
			const pr = await this.deps.github.createPullRequest(
				owner,
				repo,
				`Yolomatic: ${issueTitle}`,
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
			// The PR may already exist ("A pull request already exists") or may have
			// been created on GitHub's side before an ambiguous follow-up error
			// (network blip, ready-for-review 404, etc.). Reconcile against the
			// deterministic head/base before failing or duplicating.
			const existing = await this.findExistingPR(owner, repo, head, base);
			if (existing) {
				await this.deps.sessions.associatePR(owner, repo, issueNumber, existing.number, existing.html_url);
				return { url: existing.html_url, number: existing.number, outcome: "pr-existed" };
			}
			if (message.includes("No commits between")) {
				return { outcome: "no-changes" };
			}
			throw error;
		}
		return { outcome: "no-changes" };
	}

	/**
	 * Search for exactly one open, unmerged PR with the exact issue head and
	 * configured base. Returns the validated PR, or `null` when zero or more
	 * than one match (ambiguous). Never guesses; callers must fail on null.
	 */
	private async findExistingPR(
		owner: string,
		repo: string,
		head: string,
		base: string,
	): Promise<{ number: number; html_url: string } | null> {
		const candidates = await this.deps.github.listPullRequests(owner, repo, {
			head: `${owner}:${head}`,
			base,
			state: "open",
		});
		const valid: Array<{ number: number; html_url: string }> = [];
		for (const candidate of candidates) {
			const pr = await this.deps.github.getPullRequest(owner, repo, candidate.number);
			if (!pr) continue;
			if (
				pr.head.ref === head &&
				pr.base?.ref === base &&
				pr.state === "open" &&
				!pr.merged
			) {
				valid.push({ number: candidate.number, html_url: candidate.html_url });
			}
		}
		if (valid.length === 1) return valid[0];
		return null;
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
		const info = await this.rework.pollMergeability(owner, repo, prNumber);
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

		if (!this.rework.hasConflicts(info)) {
			await this.rework.markReadyIfDraft(owner, repo, prNumber, info);
			return "clean";
		}

		const maxAttempts = this.deps.maxConflictAttempts ?? 2;
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			const reworked = await this.rework.runConflictRework(owner, repo, issueNumber, prNumber, current, attempt, maxAttempts);
			if (!reworked) {
				const files = await this.rework.listConflictedFiles(owner, repo, issueNumber);
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

			const recheck = await this.rework.pollMergeability(owner, repo, prNumber);
			if (recheck && recheck.mergeable !== null && recheck.mergeable !== undefined && !this.rework.hasConflicts(recheck)) {
				await this.rework.markReadyIfDraft(owner, repo, prNumber, recheck);
				return "clean";
			}
		}

		const files = await this.rework.listConflictedFiles(owner, repo, issueNumber);
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

	/**
	 * Posts the static PR-commands comment on a freshly created Yolomatic PR.
	 * Skips the post when an existing comment carrying the marker is already
	 * present on the PR timeline, so the comment is never duplicated on edits
	 * or later events.
	 */
	private async postPRCommandsCommentOnce(owner: string, repo: string, prNumber: number): Promise<void> {
		try {
			const comments = await this.deps.github.listIssueComments(owner, repo, prNumber);
			if (comments.some((comment) => comment.body.includes(PR_COMMANDS_COMMENT_MARKER))) {
				process.stdout.write(`[execute] pr-commands comment already present for ${owner}/${repo}#${prNumber}
`);
				return;
			}
		} catch (error) {
			process.stdout.write(
				`[execute] listIssueComments failed for pr-commands check on ${owner}/${repo}#${prNumber}: ${
					error instanceof Error ? error.message : String(error)
			}\n`,
			);
		}
		await this.deps.github.postPRComment(owner, repo, prNumber, buildPRCommandsComment());
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
			"**Yolomatic could not deliver this pull request.**",
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
