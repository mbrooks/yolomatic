import type { GitHubService, PullRequestInfo } from "../../ports/github-service.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { SessionState } from "../../session/store.js";
import { expectedBranchForIssue } from "../../pr-review/session-invariant.js";

export interface RecoveredPR {
	number: number;
	html_url: string;
}

export type PRDiscoveryResult =
	| { status: "found"; pr: RecoveredPR }
	| { status: "none" }
	| { status: "ambiguous"; count: number };

export type PRRecoveryResult =
	| { ok: true; pr: RecoveredPR; source: "preserved" | "discovered" }
	| { ok: false; reason: string };

export interface PRRecoveryDeps {
	github: GitHubService;
	sessions: SessionRepository;
}

/**
 * Validate that a pull request is the deterministic, recoverable PR for an
 * implementation session. Returns `null` when the PR can be trusted, or a
 * human-readable reason when it must not be reused.
 *
 * The PR must:
 *   - have the exact expected head branch `yolomatic/issue-{issueNumber}`;
 *   - target the repository's configured default branch;
 *   - be open and not merged; and
 *   - match the session's already-associated PR number (when one is stored).
 */
export function validateRecoveryCandidate(
	session: { issueNumber: number; prNumber?: number },
	prNumber: number,
	pr: PullRequestInfo,
	expectedBase: string,
): string | null {
	const expectedHead = expectedBranchForIssue(session.issueNumber);
	if (pr.head.ref !== expectedHead) {
		return `PR #${prNumber} head branch '${pr.head.ref}' is not the expected '${expectedHead}'.`;
	}
	const baseRef = pr.base?.ref ?? "";
	if (baseRef !== expectedBase) {
		return `PR #${prNumber} base branch '${baseRef || "(missing)"}' is not the configured default branch '${expectedBase}'.`;
	}
	if (pr.state !== "open") {
		return `PR #${prNumber} is not open (state: ${pr.state}).`;
	}
	if (pr.merged) {
		return `PR #${prNumber} is merged.`;
	}
	if (session.prNumber !== undefined && session.prNumber !== prNumber) {
		return `Session is associated with PR #${session.prNumber}, not PR #${prNumber}.`;
	}
	return null;
}

/**
 * Reconcile the durable PR association for an implementation session.
 *
 * If the session already records a PR number, validate it against GitHub. A
 * valid, open, unmerged PR with the exact issue head and configured base is
 * reused without a listing. A stale or missing association is cleared, and
 * the routine then searches GitHub for exactly one open PR with the
 * deterministic head/base. Exactly one valid PR is persisted and returned;
 * zero, multiple, or invalid mappings produce an actionable refusal.
 */
export class PRRecovery {
	constructor(private readonly deps: PRRecoveryDeps) {}

	async recover(state: SessionState, defaultBranch: string): Promise<PRRecoveryResult> {
		const { owner, repo, issueNumber } = state;
		const expectedHead = expectedBranchForIssue(issueNumber);
		const listHead = `${owner}:${expectedHead}`;

		if (state.prNumber !== undefined) {
			const pr = await this.deps.github.getPullRequest(owner, repo, state.prNumber);
			if (pr) {
				const error = validateRecoveryCandidate(state, state.prNumber, pr, defaultBranch);
				if (error === null) {
					return {
						ok: true,
						pr: { number: state.prNumber, html_url: state.prUrl ?? "" },
						source: "preserved",
					};
				}
			}
			// Preserved metadata is stale or no longer matches; clear it before
			// discovery so a restarted session never trusts a bad mapping.
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, state.status, {
				prNumber: undefined,
				prUrl: undefined,
			});
		}

		// Discovery must validate candidates against a session with no stored
		// association; the stale mapping was just cleared above.
		const discoveryState: SessionState = { ...state, prNumber: undefined, prUrl: undefined };
		const discovery = await this.discover(discoveryState, defaultBranch);
		if (discovery.status === "found") {
			await this.deps.sessions.associatePR(owner, repo, issueNumber, discovery.pr.number, discovery.pr.html_url);
			return { ok: true, pr: discovery.pr, source: "discovered" };
		}
		if (discovery.status === "none") {
			return {
				ok: false,
				reason: `No open pull request found for ${listHead} against ${defaultBranch}.`,
			};
		}
		return {
			ok: false,
			reason: `Multiple open pull requests (${discovery.count}) found for ${listHead} against ${defaultBranch}; cannot pick one safely.`,
		};
	}

	/**
	 * Search GitHub for open PRs with the deterministic issue head and the
	 * configured base, then validate each candidate. Returns the single valid
	 * PR, `none` when no candidate validates, or `ambiguous` when more than one
	 * validates. Never guesses; callers must refuse on `none`/`ambiguous`.
	 */
	async discover(state: SessionState, defaultBranch: string): Promise<PRDiscoveryResult> {
		const { owner, repo, issueNumber } = state;
		const expectedHead = expectedBranchForIssue(issueNumber);
		const listHead = `${owner}:${expectedHead}`;
		const candidates = await this.deps.github.listPullRequests(owner, repo, {
			head: listHead,
			base: defaultBranch,
			state: "open",
		});
		const valid: RecoveredPR[] = [];
		for (const candidate of candidates) {
			const pr = await this.deps.github.getPullRequest(owner, repo, candidate.number);
			if (!pr) continue;
			if (validateRecoveryCandidate(state, candidate.number, pr, defaultBranch) === null) {
				valid.push({ number: candidate.number, html_url: candidate.html_url });
			}
		}
		if (valid.length === 1) return { status: "found", pr: valid[0] };
		if (valid.length === 0) return { status: "none" };
		return { status: "ambiguous", count: valid.length };
	}
}