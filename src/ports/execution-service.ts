import type { ExecutionResult, PRReviewComment, PriorDiscussionComment } from "../executor/index.js";
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
