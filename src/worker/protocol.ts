import type { ExecutionResult, RefinementResult } from "../executor/results.js";
import type { SessionLogEntry } from "../logging/session-log-store.js";
import type { SessionKind } from "../session/store.js";

export const WORKER_PROTOCOL_VERSION = 1;

export interface WorkerSessionState {
	owner: string;
	repo: string;
	issueNumber: number;
	kind?: SessionKind;
	workspacePath: string;
	title: string;
	body: string;
	sessionTag?: string;
}

export interface WorkerPromptPayload {
	kind: "issue" | "comment" | "pr-review" | "override" | "issue-refinement";
	text: string;
}

export interface WorkerLaunchConfigPayload {
	session: WorkerSessionState;
	prompt: WorkerPromptPayload;
	limits?: {
		maxRuntimeSeconds?: number;
	};
}

export interface WorkerHelloPayload {
	workerVersion: string;
	pid: number;
}

export interface WorkerAckPayload {
	ackMessageId: string;
}

export interface WorkerSessionLogEvent {
	type: "session_log";
	entry: SessionLogEntry;
}

export interface WorkerEventBatchPayload {
	events: WorkerSessionLogEvent[];
}

export interface WorkerHeartbeatPayload {
	state: "starting" | "running" | "stopping";
	pid: number;
	timestamp: string;
}

export interface WorkerControlPayload {
	action: "pause" | "stop" | "steer";
	message?: string;
}

export interface WorkerCompletePayload {
	result: ExecutionResult | RefinementResult;
}

export interface WorkerErrorPayload {
	message: string;
	stack?: string;
}

/**
 * Worker -> control plane. Asks the control plane to run a scoped GitHub
 * operation on the worker's behalf. The control plane acks receipt and later
 * replies with a `tool_response` carrying the result (or a scope/error failure).
 */
export interface WorkerToolRequestPayload {
	tool: string;
	params: Record<string, unknown>;
}

/**
 * Control plane -> worker. Carries the result of a `tool_request`. The
 * `requestMessageId` correlates the response to the originating request.
 */
export interface WorkerToolResponsePayload {
	requestMessageId: string;
	ok: boolean;
	data?: unknown;
	error?: string;
}

type WorkerMessageMap = {
	hello: WorkerHelloPayload;
	launch_config: WorkerLaunchConfigPayload;
	ack: WorkerAckPayload;
	event_batch: WorkerEventBatchPayload;
	heartbeat: WorkerHeartbeatPayload;
	control: WorkerControlPayload;
	complete: WorkerCompletePayload;
	error: WorkerErrorPayload;
	tool_request: WorkerToolRequestPayload;
	tool_response: WorkerToolResponsePayload;
};

export type WorkerMessageType = keyof WorkerMessageMap;

export type WorkerProtocolMessage<TType extends WorkerMessageType = WorkerMessageType> = {
	type: TType;
	protocolVersion: number;
	sessionKey: string;
	messageId: string;
	payload: WorkerMessageMap[TType];
};

export type AnyWorkerProtocolMessage = {
	[TType in WorkerMessageType]: WorkerProtocolMessage<TType>;
}[WorkerMessageType];

export function createWorkerMessage<TType extends WorkerMessageType>(
	type: TType,
	sessionKey: string,
	messageId: string,
	payload: WorkerMessageMap[TType],
): WorkerProtocolMessage<TType> {
	return {
		type,
		protocolVersion: WORKER_PROTOCOL_VERSION,
		sessionKey,
		messageId,
		payload,
	};
}
