import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExecutionResult, PRReviewComment } from "../executor/index.js";
import type { SessionState } from "../session/store.js";

export interface ExecutionService {
	execute(
		state: SessionState,
		comment?: string,
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: AgentSession) => void,
		onActivity?: () => void,
	): Promise<ExecutionResult>;
	executePRReview(
		state: SessionState,
		prReview: { comments: PRReviewComment[]; reviewBody?: string },
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: AgentSession) => void,
		onActivity?: () => void,
	): Promise<ExecutionResult>;
}
