import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { ExecutionService } from "../../ports/execution-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { TaskControlService, TaskRegistration } from "../../ports/task-control-service.js";
import type { GitHubEventSource } from "../../github-events/model.js";
import type { SessionState } from "../../session/store.js";
import { validatePRSessionMapping } from "../../pr-review/session-invariant.js";
import { issueSessionKey } from "./workflow-helpers.js";
import {
	MergeConflictReworkService,
	reportConflictResolutionResult,
} from "./merge-conflict-rework.js";

export interface AutoRebasePushPayload {
	source: GitHubEventSource;
	owner: string;
	repo: string;
	/** Full ref name, e.g. `refs/heads/main`. */
	ref: string;
	before: string;
	after: string;
}

const START_COMMENT =
	"Automatic conflict resolution has started: a new commit landed on the default branch and this pull request now conflicts. " +
	"Yolomatic is running `git rebase origin/main` to resolve the conflicts.";

/**
 * Handles a `push` to a managed repository's default branch. Enumerates the
 * open PRs Yolomatic owns for that `owner/repo` (sessions whose head branch is
 * `yolomatic/issue-{number}` and that have a stored PR number), and for each
 * PR that now reports merge conflicts, posts a start comment and runs the same
 * worker-driven `git rebase origin/main` rework iteration used by
 * `/yolomatic fix-merge-conflicts` and initial delivery.
 *
 * The flow reuses the issue session's task-admission key so an automatic
 * rebase never overlaps an active implementation, refinement, or PR-review
 * iteration. It is skipped entirely while the control plane is draining.
 * Mergeable (or unknown-mergeability) PRs are left untouched.
 */
export class HandleAutoRebaseOnPush {
	private readonly rework: MergeConflictReworkService;

	constructor(
		private readonly deps: {
			sessions: SessionRepository;
			workspaces: WorkspaceService;
			executor: ExecutionService;
			github: GitHubService;
			tasks: TaskControlService;
			githubUsername: string;
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

	async execute(payload: AutoRebasePushPayload): Promise<void> {
		const { owner, repo, ref } = payload;
		const defaultBranch = this.deps.resolveDefaultBranch?.(owner, repo) ?? this.deps.defaultBranch ?? "main";
		if (ref !== `refs/heads/${defaultBranch}`) {
			process.stdout.write(`[auto-rebase] ignored: ${ref} is not the default branch (${defaultBranch}) for ${owner}/${repo}\n`);
			return;
		}

		if (this.deps.tasks.isDraining()) {
			process.stdout.write(`[auto-rebase] ignored: draining mode for ${owner}/${repo}\n`);
			return;
		}

		const allSessions = await this.deps.sessions.getAll();
		// Candidate enumeration is keyed on the stored PR association only.
		// Production sessions do not persist a `branch` field (createSession and
		// associatePR never set it), so filtering on session.branch would silently
		// drop every real session. The Yolomatic-ownership / branch invariant is
		// enforced per-PR against the live PR head ref by validatePRSessionMapping
		// in processCandidate, mirroring HandleFixMergeConflicts.
		const candidates = allSessions.filter(
			(session) =>
				session.owner === owner &&
				session.repo === repo &&
				session.prNumber !== undefined,
		);

		if (candidates.length === 0) {
			process.stdout.write(`[auto-rebase] no Yolomatic-owned PRs for ${owner}/${repo}\n`);
			return;
		}

		// Restrict to PRs that are currently open (not merged, not closed) using a
		// single repo-wide listing, so merged/closed PRs that linger in the session
		// store are excluded before any per-PR `getPullRequest` round-trip. This
		// matches the design intent in `design/github-workflow.md` ("Enumerate
		// Yolomatic-owned open PRs") and avoids repeated
		// `[auto-rebase] ignored: PR #X is merged` noise on every default-branch push.
		const openPrNumbers = await this.deps.github.listOpenPullRequests(owner, repo);
		const openPrSet = new Set(openPrNumbers);
		const openCandidates = candidates.filter(
			(session) => session.prNumber !== undefined && openPrSet.has(session.prNumber),
		);

		if (openCandidates.length === 0) {
			process.stdout.write(`[auto-rebase] no open Yolomatic-owned PRs for ${owner}/${repo}\n`);
			return;
		}

		for (const session of openCandidates) {
			try {
				await this.processCandidate(owner, repo, session);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				process.stdout.write(
					`[auto-rebase] failed for ${owner}/${repo}#${session.issueNumber} (PR #${session.prNumber ?? "unknown"}): ${message}\n`,
				);
			}
		}
	}

	private async processCandidate(owner: string, repo: string, session: SessionState): Promise<void> {
		const prNumber = session.prNumber;
		if (prNumber === undefined) return;

		// A single mergeability poll serves as the PR fetch, the open/unmerged
		// guard, the session/branch invariant check, and the conflict gate.
		const info = await this.rework.pollMergeability(owner, repo, prNumber);
		if (!info) {
			process.stdout.write(`[auto-rebase] ignored: could not fetch PR #${prNumber}\n`);
			return;
		}
		if (info.merged || info.state !== "open") {
			// Defensive fallback: the candidate was reported open by listOpenPullRequests
		// but is now merged/closed (race between listing and polling). Skip silently
		// rather than emitting per-PR noise; the open-PR listing is the authoritative
		// filter per the design.
			return;
		}

		const mappingError = validatePRSessionMapping(session, prNumber, info.head.ref);
		if (mappingError) {
			process.stdout.write(`[auto-rebase] ignored: ${mappingError}\n`);
			return;
		}

		const key = issueSessionKey(owner, repo, session.issueNumber);
		if (this.deps.tasks.isActive(key)) {
			process.stdout.write(`[auto-rebase] ignored: ${key} is already active\n`);
			return;
		}

		// Gate: only act on PRs that currently conflict. Mergeable or
		// unknown-mergeability PRs are left untouched (no comment, no worker).
		if (info.mergeable === null || info.mergeable === undefined) {
			process.stdout.write(`[auto-rebase] ignored: PR #${prNumber} mergeability unknown\n`);
			return;
		}
		if (!this.rework.hasConflicts(info)) {
			process.stdout.write(`[auto-rebase] ignored: PR #${prNumber} is already mergeable\n`);
			return;
		}

		const registration = this.deps.tasks.register(key, () => {}, async () => {});
		if (registration === null) {
			process.stdout.write(`[auto-rebase] ignored: ${key} task key is already claimed\n`);
			return;
		}

		try {
			await this.deps.github.postPRComment(owner, repo, prNumber, START_COMMENT);
			await this.deps.sessions.updateStatus(owner, repo, session.issueNumber, "working");
			const result = await this.rework.resolveConflicts(owner, repo, session.issueNumber, prNumber, session);
			await reportConflictResolutionResult(
				{ github: this.deps.github, sessions: this.deps.sessions, maxConflictAttempts: this.deps.maxConflictAttempts },
				owner,
				repo,
				prNumber,
				session.issueNumber,
				result,
			);
		} finally {
			this.deps.tasks.unregister(key, registration);
		}
	}
}

export { type SessionState, type TaskRegistration };