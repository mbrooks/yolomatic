import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ExecutionResult, RefinementResult } from "../results.js";
import { parseRefinementResult } from "../results.js";
import { recordSessionLog } from "../../logging/session-log-store.js";
import type { LiveExecutionSession } from "../../ports/execution-service.js";
import type { SessionState } from "../../session/store.js";
import {
	WORKER_PROTOCOL_VERSION,
	createWorkerMessage,
	type AnyWorkerProtocolMessage,
	type WorkerAckPayload,
	type WorkerCompletePayload,
	type WorkerControlPayload,
	type WorkerErrorPayload,
	type WorkerEventBatchPayload,
	type WorkerProtocolMessage,
	type WorkerToolRequestPayload,
	type WorkerToolResponsePayload,
} from "../../worker/protocol.js";
import { WORKER_RPC_PATH, type WorkerRpcConnection, type WorkerRpcServer } from "../../worker/rpc-server.js";
import type { WorkerGitHubGateway } from "../../worker/github-gateway.js";
import type { WorkerTemplate } from "../../worker/templates.js";

import type { DockerWorkerContainerHandle, DockerWorkerLaunchPlan, DockerWorkerLauncher } from "./docker-worker-launcher.js";

const execFileAsync = promisify(execFile);

function createMessageIdFactory(): () => string {
	let counter = 0;
	return () => `msg-${++counter}`;
}

export interface WorkerSessionSupervisorOptions {
	workerRpcServer: WorkerRpcServer;
	workerControlBaseUrl: string;
	launcher: DockerWorkerLauncher;
	/** Scoped GitHub gateway used to serve worker tool_request calls. */
	githubGateway?: () => WorkerGitHubGateway | undefined;
}

export class WorkerSessionSupervisor {
	constructor(private readonly options: WorkerSessionSupervisorOptions) {}

	async runSession(params: {
		state: SessionState;
		prompt: { kind: "issue" | "comment" | "pr-review" | "issue-refinement"; text: string };
		sessionKey: string;
		containerName: string;
		workspacePathInWorker: string;
		workerTemplate: WorkerTemplate;
		abortSignal?: AbortSignal;
		onSessionCreated?: (session: LiveExecutionSession) => void;
		onActivity?: () => void;
	}): Promise<ExecutionResult | RefinementResult> {
		const pendingConnection = this.options.workerRpcServer.createPendingConnection(params.sessionKey);
		const workerSessionUrl = this.buildWorkerSessionUrl(params.sessionKey, pendingConnection.token);
		const plan = await this.options.launcher.createLaunchPlan({
			sessionKey: params.sessionKey,
			workerSessionUrl,
			containerName: params.containerName,
			workerTemplate: params.workerTemplate,
			promptKind: params.prompt.kind,
			repo: { owner: params.state.owner, repo: params.state.repo },
		});

		let connection: WorkerRpcConnection | undefined;
		let abortTimer: NodeJS.Timeout | undefined;
		const pendingAcks = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
		const nextMessageId = createMessageIdFactory();
		let settled = false;

		const dockerHandle = this.options.launcher.launchContainer(plan, params.sessionKey, params.workerTemplate);

		const cleanupPendingAcks = (error: Error) => {
			for (const pending of pendingAcks.values()) {
				pending.reject(error);
			}
			pendingAcks.clear();
		};

		const sendMessage = (message: WorkerProtocolMessage, expectAck = false): Promise<void> => {
			if (!connection?.isOpen()) {
				return Promise.reject(new Error("Worker RPC connection is not connected"));
			}

			const sendPromise = connection.send(message);
			if (!expectAck) {
				return sendPromise;
			}

			return new Promise<void>((resolve, reject) => {
				pendingAcks.set(message.messageId, { resolve, reject });
				void sendPromise.catch((error) => {
					pendingAcks.delete(message.messageId);
					reject(error instanceof Error ? error : new Error(String(error)));
				});
			});
		};

		const sendControl = async (payload: WorkerControlPayload): Promise<void> => {
			const message = createWorkerMessage("control", params.sessionKey, nextMessageId(), payload);
			await sendMessage(message, true);
		};

		let executionResolve!: (result: ExecutionResult | RefinementResult) => void;
		let executionReject!: (error: Error) => void;
		const executionPromise = new Promise<ExecutionResult | RefinementResult>((resolve, reject) => {
			executionResolve = resolve;
			executionReject = reject;
		});

		const requestStop = async (): Promise<void> => {
			if (settled) return;
			try {
				await sendControl({ action: "stop" });
			} catch {
				// Fall through to docker stop below.
			}
			abortTimer = setTimeout(() => {
				void execFileAsync("docker", ["stop", params.containerName], { cwd: plan.cwd }).catch(() => undefined);
			}, 5000);
			abortTimer.unref?.();
		};

		const onAbort = () => {
			void requestStop();
		};
		params.abortSignal?.addEventListener("abort", onAbort);

		try {
			connection = await Promise.race([pendingConnection.waitForConnection(), dockerHandle.dockerExitPromise]);
			connection.onMessage((message) => {
				if (message.protocolVersion !== WORKER_PROTOCOL_VERSION) {
					connection?.close(1002, `Unsupported worker protocol version ${message.protocolVersion}`);
					return;
				}
				if (message.sessionKey !== params.sessionKey) {
					connection?.close(1008, `Unexpected session key ${message.sessionKey}`);
					return;
				}
				void this.handleWorkerMessage(
					message,
					params.state,
					params.prompt,
					params.sessionKey,
					params.workspacePathInWorker,
					sendMessage,
					nextMessageId,
					pendingAcks,
					params.onSessionCreated,
					params.onActivity,
					(result) => {
						settled = true;
						dockerHandle.markSettled();
						executionResolve(result);
					},
					(error) => {
						settled = true;
						dockerHandle.markSettled();
						executionReject(error);
					},
				).catch((error) => {
					settled = true;
					dockerHandle.markSettled();
					executionReject(error instanceof Error ? error : new Error(String(error)));
				});
			});
			connection.onClose(() => {
				connection = undefined;
				if (!settled) {
					const details = dockerHandle.getOutputTail();
					executionReject(
						new Error(
							details
								? `Worker connection closed unexpectedly.\n${details}`
								: "Worker connection closed unexpectedly.",
						),
					);
				}
			});
			connection.onError((error) => {
				if (!settled) {
					executionReject(error);
				}
			});

			return await Promise.race([executionPromise, dockerHandle.dockerExitPromise]);
		} finally {
			params.abortSignal?.removeEventListener("abort", onAbort);
			if (abortTimer) {
				clearTimeout(abortTimer);
			}
			cleanupPendingAcks(new Error("Worker session ended before acknowledgement"));
			connection?.close();
			pendingConnection.dispose();
		}
	}

	private buildWorkerSessionUrl(sessionKey: string, token: string): string {
		const url = new URL(this.options.workerControlBaseUrl);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.pathname = WORKER_RPC_PATH;
		url.search = "";
		url.searchParams.set("sessionKey", sessionKey);
		url.searchParams.set("token", token);
		return url.toString();
	}

	private async handleWorkerMessage(
		message: AnyWorkerProtocolMessage,
		state: SessionState,
		prompt: { kind: "issue" | "comment" | "pr-review" | "issue-refinement"; text: string },
		sessionKey: string,
		workspacePathInWorker: string,
		sendMessage: (message: WorkerProtocolMessage, expectAck?: boolean) => Promise<void>,
		nextMessageId: () => string,
		pendingAcks: Map<string, { resolve: () => void; reject: (error: Error) => void }>,
		onSessionCreated: ((session: LiveExecutionSession) => void) | undefined,
		onActivity: (() => void) | undefined,
		onComplete: (result: ExecutionResult | RefinementResult) => void,
		onError: (error: Error) => void,
	): Promise<void> {
		switch (message.type) {
			case "hello": {
				const launchConfig = createWorkerMessage("launch_config", sessionKey, nextMessageId(), {
					session: {
						owner: state.owner,
						repo: state.repo,
						issueNumber: state.issueNumber,
						kind: state.kind ?? "implementation",
						workspacePath: workspacePathInWorker,
						title: state.title,
						body: state.body,
						sessionTag: state.sessionTag,
					},
					prompt,
					limits: { maxRuntimeSeconds: 7200 },
				});
				await sendMessage(launchConfig, true);
				onSessionCreated?.({
					steer: async (content: string) => {
						await sendMessage(
							createWorkerMessage("control", sessionKey, nextMessageId(), {
								action: "steer",
								message: content,
							}),
							true,
						);
					},
				});
				return;
			}

			case "ack": {
				const payload = message.payload as WorkerAckPayload;
				const pending = pendingAcks.get(payload.ackMessageId);
				if (pending) {
					pendingAcks.delete(payload.ackMessageId);
					pending.resolve();
				}
				return;
			}

			case "event_batch": {
				this.persistWorkerEvents(sessionKey, message.payload as WorkerEventBatchPayload, onActivity);
				return;
			}

			case "tool_request": {
				await this.handleToolRequest(
					message as WorkerProtocolMessage<"tool_request">,
					state,
					sessionKey,
					sendMessage,
					nextMessageId,
				);
				return;
			}

			case "heartbeat": {
				onActivity?.();
				return;
			}

			case "complete": {
				const payload = message.payload as WorkerCompletePayload;
				if (prompt.kind === "issue-refinement") {
					const raw = payload.result as Partial<RefinementResult>;
					const refined = parseRefinementResult(
						typeof raw.proposedTaskBody === "string"
							? JSON.stringify({
									proposedTaskBody: raw.proposedTaskBody,
									summary: raw.summary ?? "",
									investigation: raw.investigation ?? "",
									...(typeof raw.proposedTitle === "string" ? { proposedTitle: raw.proposedTitle } : {}),
								})
							: "",
					);
					if (!refined) {
						onError(new Error("Worker returned an invalid refinement result."));
						return;
					}
					// Token usage is computed by the worker's executor and survives
					// only on the raw completion payload; without it the control plane
					// records unavailable usage and the dashboard renders "unknown".
					if (typeof raw.usage === "object" && raw.usage !== null) {
						refined.usage = raw.usage;
					}
					onComplete(refined);
					return;
				}
				onComplete(payload.result as ExecutionResult);
				return;
			}

			case "error": {
				const payload = message.payload as WorkerErrorPayload;
				onError(new Error(payload.stack ? `${payload.message}\n${payload.stack}` : payload.message));
				return;
			}

			default: {
				return;
			}
		}
	}

	private persistWorkerEvents(sessionKey: string, payload: WorkerEventBatchPayload, onActivity?: () => void): void {
		for (const event of payload.events) {
			if (event.type !== "session_log") continue;
			recordSessionLog(sessionKey, {
				level: event.entry.level,
				message: event.entry.message,
				details: event.entry.details,
			});
			onActivity?.();
		}
	}

	private async handleToolRequest(
		message: WorkerProtocolMessage<"tool_request">,
		state: SessionState,
		sessionKey: string,
		sendMessage: (message: WorkerProtocolMessage, expectAck?: boolean) => Promise<void>,
		nextMessageId: () => string,
	): Promise<void> {
		const request = message.payload as WorkerToolRequestPayload;
		// Acknowledge receipt immediately so the worker knows the request was
		// accepted; the result follows in a separate tool_response.
		await sendMessage(createWorkerMessage("ack", sessionKey, nextMessageId(), { ackMessageId: message.messageId }));

		const gateway = this.options.githubGateway?.();
		if (!gateway) {
			await this.sendToolResponse(sendMessage, sessionKey, nextMessageId, message.messageId, {
				requestMessageId: message.messageId,
				ok: false,
				error: "GitHub gateway is not enabled for this control plane",
			});
			return;
		}

		let response: import("../../worker/github-gateway.js").GatewayToolResponse;
		try {
			response = await gateway.handle(state, { tool: request.tool, params: request.params });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			response = { ok: false, error: msg };
		}

		const payload: WorkerToolResponsePayload = {
			requestMessageId: message.messageId,
			ok: response.ok,
			...(response.data !== undefined ? { data: response.data } : {}),
			...(response.error !== undefined ? { error: response.error } : {}),
			...(response.scopeError ? { scopeError: true } : {}),
		};

		recordSessionLog(sessionKey, {
			level: response.ok ? "tool" : response.scopeError ? "warn" : "error",
			message: `gateway ${request.tool} ${response.ok ? "done" : response.scopeError ? "scope-rejected" : "failed"}`,
			details: {
				type: "worker_gateway_tool",
				tool: request.tool,
				ok: response.ok,
				scopeError: response.scopeError ?? false,
				error: response.error ?? null,
			},
		});

		await this.sendToolResponse(sendMessage, sessionKey, nextMessageId, message.messageId, payload);
	}

	private async sendToolResponse(
		sendMessage: (message: WorkerProtocolMessage, expectAck?: boolean) => Promise<void>,
		sessionKey: string,
		nextMessageId: () => string,
		_requestMessageId: string,
		payload: WorkerToolResponsePayload,
	): Promise<void> {
		await sendMessage(createWorkerMessage("tool_response", sessionKey, nextMessageId(), payload));
	}
}
