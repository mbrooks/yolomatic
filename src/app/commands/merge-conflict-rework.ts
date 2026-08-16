import type { ExecutionService } from "../../ports/execution-service.js";
import type { GitHubService, PullRequestInfo } from "../../ports/github-service.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { SessionState } from "../../session/store.js";
import { generateCommitMessage } from "../../workspace/commit-message.js";

export type ConflictResolutionOutcome =
	| "clean"
	| "conflict-failed"
	| "unknown-mergeability";

export interface ConflictResolutionResult {
	outcome: ConflictResolutionOutcome;
	/** Number of worker rebase/rework iterations actually run. */
	attempts: number;
	/** Conflicted file paths when the outcome is `conflict-failed`. */
	conflictedFiles: string[];
}

/**
 * Reusable merge-conflict rework behavior shared by session delivery and the
 * on-demand `/yolomatic fix-merge-conflicts` PR command. Wraps the
 * GitHub mergeability poll, the worker-driven `git rebase origin/main`
 * iteration, and the commit/push that follows a successful rework.
 */
export class MergeConflictReworkService {
	constructor(
		private readonly deps: {
			github: GitHubService;
			executor: ExecutionService;
			workspaces: WorkspaceService;
			/** Delay between mergeability polls when GitHub reports `mergeable: null`. */
			mergeabilityPollDelayMs?: number;
			/** Max polls while `mergeable` is `null` before giving up (~30s default). */
			mergeabilityPollMaxAttempts?: number;
			/** Max worker-driven rebase/rework attempts before failing. */
			maxConflictAttempts?: number;
		},
	) {}

	hasConflicts(info: PullRequestInfo): boolean {
		return info.mergeable === false || info.mergeableState === "dirty";
	}

	async markReadyIfDraft(owner: string, repo: string, prNumber: number, info: PullRequestInfo): Promise<void> {
		if (info.draft === true) {
			await this.deps.github.markPullRequestReadyForReview(owner, repo, prNumber);
		}
	}

	/**
	 * Poll `getPullRequest` until `mergeable` is non-null, bounded by
	 * `mergeabilityPollMaxAttempts` with `mergeabilityPollDelayMs` between tries.
	 */
	async pollMergeability(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo | null> {
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

	async listConflictedFiles(owner: string, repo: string, issueNumber: number): Promise<string[]> {
		const status = await this.deps.workspaces.getGitStatus(owner, repo, issueNumber).catch(() => "");
		if (!status) return [];
		const files: string[] = [];
		for (const raw of status.split(/\r?\n/u)) {
			const match = /^(DD|AU|UD|UA|DU|AA|UU) (.+)$/u.exec(raw.trim());
			if (match) files.push(match[2]!.trim());
		}
		return files;
	}

	/**
	 * Launch a worker iteration with a steering comment that tells the worker
	 * to `git rebase origin/main`, resolve conflict markers, and leave the
	 * worktree clean. After success, commit and push the rebased branch.
	 * Returns `true` when the branch was pushed and should be re-checked.
	 */
	async runConflictRework(
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

		const branchName = current.branch ?? `yolomatic/issue-${issueNumber}`;
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

	/**
	 * Drive the full conflict-resolution loop for a PR: poll mergeability, and
	 * if conflicting, run up to `maxConflictAttempts` rework iterations, pushing
	 * and re-checking after each. When the PR ends up mergeable, marks it ready
	 * for review if it is still a draft. Returns the outcome and the number of
	 * rework attempts actually run.
	 */
	async resolveConflicts(
		owner: string,
		repo: string,
		issueNumber: number,
		prNumber: number,
		current: SessionState,
	): Promise<ConflictResolutionResult> {
		const info = await this.pollMergeability(owner, repo, prNumber);
		if (!info || info.mergeable === null || info.mergeable === undefined) {
			return { outcome: "unknown-mergeability", attempts: 0, conflictedFiles: [] };
		}

		if (!this.hasConflicts(info)) {
			await this.markReadyIfDraft(owner, repo, prNumber, info);
			return { outcome: "clean", attempts: 0, conflictedFiles: [] };
		}

		const maxAttempts = this.deps.maxConflictAttempts ?? 2;
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			const reworked = await this.runConflictRework(owner, repo, issueNumber, prNumber, current, attempt, maxAttempts);
			if (!reworked) {
				const files = await this.listConflictedFiles(owner, repo, issueNumber);
				return { outcome: "conflict-failed", attempts: attempt, conflictedFiles: files };
			}

			const recheck = await this.pollMergeability(owner, repo, prNumber);
			if (recheck && recheck.mergeable !== null && recheck.mergeable !== undefined && !this.hasConflicts(recheck)) {
				await this.markReadyIfDraft(owner, repo, prNumber, recheck);
				return { outcome: "clean", attempts: attempt, conflictedFiles: [] };
			}
		}

		const files = await this.listConflictedFiles(owner, repo, issueNumber);
		return { outcome: "conflict-failed", attempts: maxAttempts, conflictedFiles: files };
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
	}
}