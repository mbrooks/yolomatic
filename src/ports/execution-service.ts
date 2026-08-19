import type { ExecutionResult, PRReviewComment, PriorDiscussionComment, RefinementResult } from "../executor/index.js";
import type { SessionState } from "../session/store.js";

export interface LiveExecutionSession {
	steer(message: string): Promise<void>;
}

export interface ExecutionService {
	execute(
		state: SessionState,
		comment?: string,
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
		priorComments?: PriorDiscussionComment[],
	): Promise<ExecutionResult>;
	executePRReview(
		state: SessionState,
		prReview: { comments: PRReviewComment[]; reviewBody?: string },
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
	): Promise<ExecutionResult>;
}

/**
 * Port for executing an issue-refinement session. The composition root
 * constructs a concrete executor (the production Docker worker, or a fake in
 * tests) and injects it into {@link HandleIssueRefinement}; the handler no
 * longer depends on a specific executor class or casts to one.
 *
 * `repoSkillContent` is the raw repository `issue-refinement` skill body (or
 * `undefined` when no skill is present) and `steeringPrompt` is the optional
 * maintainer steering text trailing the refinement command. The executor owns
 * assembling the worker prompt from those inputs.
 */
export interface RefinementExecutionService {
	executeRefinement(
		state: SessionState,
		repoSkillContent: string | undefined,
		steeringPrompt?: string,
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
	): Promise<RefinementResult>;
}
