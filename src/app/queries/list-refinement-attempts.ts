import type { RefinementAttempt, RefinementStore } from "../../refinement/store.js";
import { ok, type AppResult } from "../result.js";

export interface RefinementAttemptView {
	id: string;
	requester: string;
	instructionSource: string;
	repoCommit?: string;
	state: string;
	failureReason?: string;
	summary?: string;
	investigation?: string;
	createdAt: string;
	updatedAt: string;
}

export interface RefinementAttemptsView {
	attempts: RefinementAttemptView[];
}

/**
 * Lists durable issue-refinement attempts for an issue, newest first, for the
 * admin refinement activity view. Returns an empty list (not an error) for
 * issues that have never been refined so the UI can distinguish "no activity"
 * from "activity exists".
 */
export class ListRefinementAttempts {
	constructor(private readonly refinementStore: RefinementStore) {}

	async execute(owner: string, repo: string, issueNumber: number): Promise<AppResult<RefinementAttemptsView>> {
		const attempts = this.refinementStore.listAttemptsByIssue(owner, repo, issueNumber);
		return ok({ attempts: attempts.map(toView) });
	}
}

function toView(attempt: RefinementAttempt): RefinementAttemptView {
	return {
		id: attempt.id,
		requester: attempt.requester,
		instructionSource: attempt.instructionSource,
		repoCommit: attempt.repoCommit,
		state: attempt.state,
		failureReason: attempt.failureReason,
		summary: attempt.summary,
		investigation: attempt.investigation,
		createdAt: attempt.createdAt,
		updatedAt: attempt.updatedAt,
	};
}