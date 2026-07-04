import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { PiAgentExecutor } from "../executor/index.js";
import { sessionKey as buildSessionKey } from "../domain/session/model.js";
import { onSessionLogEvent } from "../logging/log-events.js";
import { WorkerMessageParser, encodeWorkerMessage } from "./framing.js";
import {
	WORKER_PROTOCOL_VERSION,
	createWorkerMessage,
	type WorkerAckPayload,
	type WorkerProtocolMessage,
} from "./protocol.js";

export interface WorkerRuntimeOptions {
	socketPath: string;
	sessionKey: string;
	soulPath: string;
	workerVersion?: string;
}

export async function runWorkerRuntime(options: WorkerRuntimeOptions): Promise<void> {
	const parser = new WorkerMessageParser();
	const socket = net.createConnection(options.socketPath);
	const nextMessageId = createMessageIdFactory();
const sendMessage = (message: WorkerProtocolMessage): Promise<void> =>
		new Promise((resolve, reject) => {
			socket.write(encodeWorkerMessage(message), (error) => {
				if (error) reject(error);
				else resolve();
			});
		});

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
		socket.destroy();
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
	};

	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});

		await sendMessage(
			createWorkerMessage("hello", options.sessionKey, nextMessageId(), {
				workerVersion: options.workerVersion ?? "dev",
				pid: process.pid,
			}),
		);

		const launchConfig = await waitForLaunchConfig(socket, parser, options.sessionKey);
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

		tempDir = await mkdtemp(path.join(os.tmpdir(), "tars-worker-"));
		const executor = new PiAgentExecutor({ soulPath: options.soulPath });

		socket.on("data", (chunk) => {
			for (const message of parser.push(chunk)) {
				if (message.type !== "control") continue;
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
			}
		});

		startHeartbeat();
		const result = await executor.executeWithOverride(
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

		await sendMessage(
			createWorkerMessage("complete", options.sessionKey, nextMessageId(), {
				result,
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
	socket: net.Socket,
	parser: WorkerMessageParser,
	sessionKey: string,
): Promise<WorkerProtocolMessage<"launch_config">> {
	return new Promise((resolve, reject) => {
		const onData = (chunk: Buffer) => {
			for (const message of parser.push(chunk)) {
				if (message.protocolVersion !== WORKER_PROTOCOL_VERSION) {
					reject(new Error(`Unsupported protocol version ${message.protocolVersion}`));
					return;
				}
				if (message.sessionKey !== sessionKey) {
					reject(new Error(`Unexpected session key ${message.sessionKey}`));
					return;
				}
				if (message.type === "launch_config") {
					socket.off("data", onData);
					resolve(message as WorkerProtocolMessage<"launch_config">);
					return;
				}
			}
		};

		socket.on("data", onData);
		socket.once("error", reject);
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
