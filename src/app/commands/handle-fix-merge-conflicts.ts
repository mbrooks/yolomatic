import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { ExecutionService } from "../../ports/execution-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { TaskControlService, TaskRegistration } from "../../ports/task-control-service.js";
import type { GitHubEventSource } from "../../github-events/model.js";
import type { SessionState } from "../../session/store.js";
import { isAdmin } from "../../domain/workflow/policy.js";
import { validatePRSessionMapping } from "../../pr-review/session-invariant.js";
import { issueSessionKey } from "./workflow-helpers.js";
import { MergeConflictReworkService, reportConflictResolutionResult } from "./merge-conflict-rework.js";

export interface FixMergeConflictsPayload {
	source?: GitHubEventSource;
	action: string;
	owner: string;
	repo: string;
	prNumber: number;
	/** Initial PR snapshot resolved by the router. Re-fetched before use. */
	pr: { head: { ref: string }; state: string; merged: boolean };
	senderLogin: string;
	comment: { id?: number; body: string; user: { login: string; type?: string } };
	/** Issue number mapped to the PR by the router, or `null` when unmapped. */
	mappedIssueNumber: number | null;
}

/**
 * Handles the authenticated `/yolomatic fix-merge-conflicts` command posted on
 * a PR timeline. Re-fetches the PR, confirms it is open and unmerged, verifies
 * the session/PR/branch mapping invariant, and either reports a no-op when
 * the PR is already mergeable, or runs a worker rebase/rework iteration (shared
 * with session delivery) to resolve conflicts against the base branch.
 *
 * The command shares the issue session's task-admission key so it cannot
 * overlap an active implementation, refinement, or PR-review iteration.
 */
export class HandleFixMergeConflicts {
	private readonly rework: MergeConflictReworkService;

	constructor(
		private readonly deps: {
			sessions: SessionRepository;
			workspaces: WorkspaceService;
			executor: ExecutionService;
			github: GitHubService;
			tasks: TaskControlService;
			githubUsername: string;
			adminGithubUsername?: string;
			defaultBranch?: string;
			resolveDefaultBranch?: (owner: string, repo: string) => string;
			mergeabilityPollDelayMs?: number;
			mergeabilityPollMaxAttempts?: number;
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

	async execute(payload: FixMergeConflictsPayload): Promise<void> {
		if (payload.action !== "created") {
			process.stdout.write(`[fix-merge-conflicts] ignored: action is ${payload.action}\n`);
			return;
		}

		const { owner, repo, prNumber } = payload;

		if (payload.senderLogin === this.deps.githubUsername) {
			process.stdout.write(`[fix-merge-conflicts] ignored: command from ${this.deps.githubUsername}\n`);
			return;
		}

		if (payload.comment.user.type === "Bot") {
			process.stdout.write(`[fix-merge-conflicts] ignored: bot comment from ${payload.senderLogin}\n`);
			return;
		}

		const authorized =
			isAdmin(payload.senderLogin, this.deps.adminGithubUsername) ||
			(await this.deps.github.isCollaborator(owner, repo, payload.senderLogin));
		if (!authorized) {
			process.stdout.write(`[fix-merge-conflicts] ignored: ${payload.senderLogin} is not a repository collaborator\n`);
			await this.deps.github.postPRComment(owner, repo, prNumber, "Only repository collaborators can run `/yolomatic fix-merge-conflicts`.");
			return;
		}

		if (this.deps.tasks.isDraining()) {
			process.stdout.write(`[fix-merge-conflicts] ignored: draining mode\n`);
			await this.deps.github.postPRComment(owner, repo, prNumber, "Deploy in progress. The fix-merge-conflicts command will not run until restart.");
			return;
		}

		const pr = await this.deps.github.getPullRequest(owner, repo, prNumber);
		if (!pr) {
			process.stdout.write(`[fix-merge-conflicts] ignored: could not fetch PR #${prNumber}\n`);
			await this.deps.github.postPRComment(owner, repo, prNumber, "Yolomatic could not fetch this pull request. Please try again.");
			return;
		}

		if (pr.merged) {
			process.stdout.write(`[fix-merge-conflicts] ignored: PR #${prNumber} is merged\n`);
			await this.deps.github.postPRComment(owner, repo, prNumber, "This pull request is merged, so `/yolomatic fix-merge-conflicts` cannot run.");
			return;
		}

		if (pr.state !== "open") {
			process.stdout.write(`[fix-merge-conflicts] ignored: PR #${prNumber} is ${pr.state}\n`);
			await this.deps.github.postPRComment(owner, repo, prNumber, "This pull request is closed, so `/yolomatic fix-merge-conflicts` cannot run.");
			return;
		}

		const issueNumber = payload.mappedIssueNumber;
		const session = issueNumber ? await this.deps.sessions.get(owner, repo, issueNumber, "implementation") : null;
		if (!issueNumber || !session) {
			process.stdout.write(`[fix-merge-conflicts] ignored: PR #${prNumber} is not associated with a Yolomatic session\n`);
			await this.deps.github.postPRComment(owner, repo, prNumber, "This pull request is not associated with a Yolomatic session, so `/yolomatic fix-merge-conflicts` cannot run.");
			return;
		}

		const mappingError = validatePRSessionMapping(session, prNumber, pr.head.ref);
		if (mappingError) {
			process.stdout.write(`[fix-merge-conflicts] ignored: ${mappingError}\n`);
			await this.deps.github.postPRComment(
				owner,
				repo,
				prNumber,
				[
					"`/yolomatic fix-merge-conflicts` cannot run on this PR.",
					"",
					mappingError,
				].join("\n"),
			);
			return;
		}

		const key = issueSessionKey(owner, repo, issueNumber);
		if (this.deps.tasks.isActive(key)) {
			process.stdout.write(`[fix-merge-conflicts] ignored: ${key} is already active\n`);
			await this.deps.github.postPRComment(owner, repo, prNumber, "Yolomatic is busy on this issue. The fix-merge-conflicts command cannot overlap an active session.");
			return;
		}

		const registration = this.deps.tasks.register(key, () => {}, async () => {});
		if (registration === null) {
			process.stdout.write(`[fix-merge-conflicts] ignored: ${key} task key is already claimed\n`);
			await this.deps.github.postPRComment(owner, repo, prNumber, "Yolomatic is busy on this issue. The fix-merge-conflicts command cannot overlap an active session.");
			return;
		}

		try {
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "working");
			const result = await this.rework.resolveConflicts(owner, repo, issueNumber, prNumber, session);
			await reportConflictResolutionResult(
				{ github: this.deps.github, sessions: this.deps.sessions, maxConflictAttempts: this.deps.maxConflictAttempts },
				owner,
				repo,
				prNumber,
				issueNumber,
				result,
			);
		} finally {
			this.deps.tasks.unregister(key, registration);
		}
	}

}

export { type SessionState, type TaskRegistration };