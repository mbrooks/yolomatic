import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import WebSocket, { type RawData } from "ws";

import { PiAgentExecutor, type RefinementResult } from "../executor/index.js";
import { sessionKey as buildSessionKey } from "../domain/session/model.js";
import { onSessionLogEvent } from "../logging/log-events.js";
import { createWorkerMessage, WORKER_PROTOCOL_VERSION, type WorkerProtocolMessage } from "./protocol.js";
import { decodeWorkerWebSocketMessage, sendWorkerWebSocketMessage } from "./websocket-transport.js";

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
		const sessionLogKey = buildSessionKey(state.owner, state.repo, state.issueNumber);
		logListenerCleanup = onSessionLogEvent((key, entry) => {
			if (key !== sessionLogKey) return;
			void sendMessage(
				createWorkerMessage("event_batch", options.sessionKey, nextMessageId(), {
					events: [{ type: "session_log", entry }],
				}),
			);
		});

		tempDir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worker-"));
		const executor = new PiAgentExecutor({ soulPath: options.soulPath });

		ws.on("message", (raw) => {
			const message = decodeWorkerWebSocketMessage(raw);
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
