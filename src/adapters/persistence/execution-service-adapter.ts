import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExecutionService } from "../../ports/execution-service.js";
import type { ExecutionResult, PiAgentExecutor, PRReviewComment } from "../../executor/index.js";
import type { SessionState } from "../../session/store.js";

export class ExecutionServiceAdapter implements ExecutionService {
	constructor(private readonly executor: PiAgentExecutor) {}

	execute(
		state: SessionState,
		comment?: string,
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: AgentSession) => void,
		onActivity?: () => void,
	): Promise<ExecutionResult> {
		return this.executor.execute(state, comment, undefined, abortSignal, onSessionCreated, undefined, onActivity);
	}

	executePRReview(
		state: SessionState,
		prReview: { comments: PRReviewComment[]; reviewBody?: string },
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: AgentSession) => void,
		onActivity?: () => void,
	): Promise<ExecutionResult> {
		return this.executor.execute(state, undefined, prReview, abortSignal, onSessionCreated, undefined, onActivity);
	}
}
