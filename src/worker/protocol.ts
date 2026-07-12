import type { ExecutionResult } from "../executor/results.js";
import type { LlmLoggerConfig } from "../logging/llm-logger.js";
import type { SessionLogEntry } from "../logging/session-log-store.js";

export const WORKER_PROTOCOL_VERSION = 1;

export interface WorkerSessionState {
	owner: string;
	repo: string;
	issueNumber: number;
	workspacePath: string;
	title: string;
	body: string;
	sessionTag?: string;
}

export interface WorkerPromptPayload {
	kind: "issue" | "comment" | "pr-review" | "override";
	text: string;
}

export interface WorkerLaunchConfigPayload {
	session: WorkerSessionState;
	prompt: WorkerPromptPayload;
	limits?: {
		maxRuntimeSeconds?: number;
	};
	llmLoggerConfig?: LlmLoggerConfig;
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
	result: ExecutionResult;
}

export interface WorkerErrorPayload {
	message: string;
	stack?: string;
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
