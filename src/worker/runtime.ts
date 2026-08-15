import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import WebSocket, { type RawData } from "ws";

import { PiAgentExecutor, type RefinementResult } from "../executor/index.js";
import { sessionStorageKey } from "../session/store.js";
import { onSessionLogEvent } from "../logging/log-events.js";
import { recordSessionLog } from "../logging/session-log-store.js";
import { runEnvironmentInit } from "./env-init.js";
import { createWorkerMessage, WORKER_PROTOCOL_VERSION, type WorkerProtocolMessage } from "./protocol.js";
import { setGitHubGatewayTransport, type GatewayCallResult } from "./github-gateway-client.js";
import { decodeWorkerWebSocketMessage, sendWorkerWebSocketMessage } from "./websocket-transport.js";
import { runtimeSettingsFromEnv } from "../runtime-settings.js";

export interface WorkerRuntimeOptions {
	wsUrl: string;
	sessionKey: string;
	soulPath: string;
	workerVersion?: string;
}

export async function runWorkerRuntime(options: WorkerRuntimeOptions): Promise<void> {
	const ws = new WebSocket(options.wsUrl);
	const nextMessageId = createMessageIdFactory();
	const sendMessage = (message: WorkerProtocolMessage): Promise<void> => sendWorkerWebSocketMessage(ws, message);

	const abortController = new AbortController();
	let liveSession: { steer(message: string): Promise<void> } | undefined;
	let heartbeat: NodeJS.Timeout | undefined;
	let logListenerCleanup: (() => void) | undefined;
	let tempDir: string | undefined;

	const pendingToolResponses = new Map<string, { resolve: (result: GatewayCallResult) => void; reject: (error: Error) => void } | undefined>();
	const nextToolRequestId = createMessageIdFactory();

	const stopHeartbeat = () => {
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = undefined;
		}
	};

	const startHeartbeat = () => {
		if (heartbeat) return;
		heartbeat = setInterval(() => {
			void sendMessage(
				createWorkerMessage("heartbeat", options.sessionKey, nextMessageId(), {
					state: abortController.signal.aborted ? "stopping" : "running",
					pid: process.pid,
					timestamp: new Date().toISOString(),
				}),
			);
		}, 5000);
		heartbeat.unref?.();
	};

	const cleanup = async () => {
		stopHeartbeat();
		logListenerCleanup?.();
		setGitHubGatewayTransport(undefined);
		for (const pending of pendingToolResponses.values()) {
			pending?.reject(new Error("Worker session ended before GitHub gateway responded"));
		}
		pendingToolResponses.clear();
		if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
			ws.close();
		} else {
			ws.terminate();
		}
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
	};

	try {
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});

		await sendMessage(
			createWorkerMessage("hello", options.sessionKey, nextMessageId(), {
				workerVersion: options.workerVersion ?? "dev",
				pid: process.pid,
			}),
		);

		const launchConfig = await waitForLaunchConfig(ws, options.sessionKey);
		await sendMessage(
			createWorkerMessage("ack", options.sessionKey, nextMessageId(), {
				ackMessageId: launchConfig.messageId,
			}),
		);

		const state = launchConfig.payload.session;
		const sessionLogKey = sessionStorageKey(state.owner, state.repo, state.issueNumber, state.kind ?? "implementation");
		logListenerCleanup = onSessionLogEvent((key, entry) => {
			if (key !== sessionLogKey) return;
			void sendMessage(
				createWorkerMessage("event_batch", options.sessionKey, nextMessageId(), {
					events: [{ type: "session_log", entry }],
				}),
			);
		});

		// Refinement launches use a temporary worktree that is discarded after the
		// refinement attempt, so spending model-budget time on a repository init
		// script there is wasteful and can fail the attempt for reasons unrelated
		// to refinement. The skip is a hard skip keyed on the refinement prompt
		// kind, independent of YOLO_WORKER_INIT_SKIP; every other launch
		// kind runs the init step exactly as before.
		if (launchConfig.payload.prompt.kind !== "issue-refinement") {
			await runEnvironmentInit({
				workspacePath: state.workspacePath,
				log: (entry) => {
					recordSessionLog(sessionLogKey, entry);
				},
				signal: abortController.signal,
			});
		}

		tempDir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-worker-"));

		setGitHubGatewayTransport({
			async call(request) {
				const requestMessageId = nextToolRequestId();
				const responsePromise = new Promise<GatewayCallResult>((resolve, reject) => {
					pendingToolResponses.set(requestMessageId, { resolve, reject });
				});
				try {
					await sendMessage(
						createWorkerMessage("tool_request", options.sessionKey, requestMessageId, request),
					);
				} catch (error) {
					pendingToolResponses.delete(requestMessageId);
					throw error instanceof Error ? error : new Error(String(error));
				}
				return responsePromise;
			},
		});

		const executor = new PiAgentExecutor({
			soulPath: options.soulPath,
			trustedExtensionPath: path.join(
				path.dirname(options.soulPath),
				".pi",
				"extensions",
				"github-issues.ts",
			),
			// The worker process environment is the worker's configuration boundary:
			// read the migrated model/logging keys once here and inject them so the
			// executor and logger never read process.env directly.
			runtimeSettings: runtimeSettingsFromEnv(process.env),
		});

		ws.on("message", (raw) => {
			const message = decodeWorkerWebSocketMessage(raw);
			if (message.type === "tool_response") {
				const payload = message.payload as import("./protocol.js").WorkerToolResponsePayload;
				const pending = pendingToolResponses.get(payload.requestMessageId);
				if (pending) {
					pendingToolResponses.delete(payload.requestMessageId);
					pending.resolve({
						ok: payload.ok,
						data: payload.data,
						error: payload.error,
						scopeError: (payload as { scopeError?: boolean }).scopeError,
					});
				}
				return;
			}
			if (message.type !== "control") return;
			void handleControlMessage(
				message as WorkerProtocolMessage<"control">,
				options.sessionKey,
				nextMessageId,
				sendMessage,
				abortController,
				() => liveSession,
			).catch(
				async (error) => {
					const err = error instanceof Error ? error : new Error(String(error));
					await sendMessage(
						createWorkerMessage("error", options.sessionKey, nextMessageId(), {
							message: err.message,
							stack: err.stack,
						}),
					).catch(() => undefined);
				},
			);
		});

		startHeartbeat();
		const isRefinement = launchConfig.payload.prompt.kind === "issue-refinement";
		let refinementResult: RefinementResult | undefined;
		let executionResult: import("../executor/index.js").ExecutionResult | undefined;
		if (isRefinement) {
			refinementResult = await executor.executeRefinement(
				{
					issueNumber: state.issueNumber,
					repo: state.repo,
					owner: state.owner,
					title: state.title,
					body: state.body,
					status: "working",
					sessionPath: path.join(tempDir, "session.jsonl"),
					workspacePath: state.workspacePath,
					lastActivity: new Date().toISOString(),
					seeded: false,
					sessionTag: state.sessionTag,
					kind: state.kind,
				},
				launchConfig.payload.prompt.text,
				abortController.signal,
				(session) => {
					liveSession = session;
				},
			);
		} else {
			executionResult = await executor.executeWithOverride(
				{
					issueNumber: state.issueNumber,
					repo: state.repo,
					owner: state.owner,
					title: state.title,
					body: state.body,
					status: "working",
					sessionPath: path.join(tempDir, "session.jsonl"),
					workspacePath: state.workspacePath,
					lastActivity: new Date().toISOString(),
					seeded: false,
					sessionTag: state.sessionTag,
					kind: state.kind,
				},
				launchConfig.payload.prompt.text,
				abortController.signal,
				(session) => {
					liveSession = session;
				},
			);
		}

		await sendMessage(
			createWorkerMessage("complete", options.sessionKey, nextMessageId(), {
				result: refinementResult ?? executionResult!,
			}),
		);
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		await sendMessage(
			createWorkerMessage("error", options.sessionKey, nextMessageId(), {
				message: err.message,
				stack: err.stack,
			}),
		).catch(() => undefined);
		throw err;
	} finally {
		await cleanup();
	}
}

async function waitForLaunchConfig(
	ws: WebSocket,
	sessionKey: string,
): Promise<WorkerProtocolMessage<"launch_config">> {
	return new Promise((resolve, reject) => {
		const onMessage = (raw: RawData) => {
			try {
				const message = decodeWorkerWebSocketMessage(raw);
				if (message.protocolVersion !== WORKER_PROTOCOL_VERSION) {
					reject(new Error(`Unsupported protocol version ${message.protocolVersion}`));
					return;
				}
				if (message.sessionKey !== sessionKey) {
					reject(new Error(`Unexpected session key ${message.sessionKey}`));
					return;
				}
				if (message.type === "launch_config") {
					ws.off("message", onMessage);
					resolve(message as WorkerProtocolMessage<"launch_config">);
				}
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		};

		ws.on("message", onMessage);
		ws.once("error", reject);
		ws.once("close", () => reject(new Error("Worker RPC connection closed before launch config arrived")));
	});
}

async function handleControlMessage(
	message: WorkerProtocolMessage<"control">,
	sessionKey: string,
	nextMessageId: () => string,
	sendMessage: (message: WorkerProtocolMessage) => Promise<void>,
	abortController: AbortController,
	getSession: () => { steer(message: string): Promise<void> } | undefined,
): Promise<void> {
	await sendMessage(
		createWorkerMessage("ack", sessionKey, nextMessageId(), {
			ackMessageId: message.messageId,
		}),
	);

	if (message.payload.action === "steer") {
		const session = getSession();
		if (!session) {
			throw new Error("Worker received steer before session became available");
		}
		await session.steer(message.payload.message ?? "");
		return;
	}

	abortController.abort();
}

function createMessageIdFactory(): () => string {
	let counter = 0;
	return () => `worker-msg-${++counter}`;
}
