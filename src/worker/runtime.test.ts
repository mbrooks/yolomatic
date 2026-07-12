import { afterEach, describe, expect, it, vi } from "vitest";

import { emitSessionLogEvent } from "../logging/log-events.js";
import { createWorkerMessage, type WorkerProtocolMessage } from "./protocol.js";
import { decodeWorkerWebSocketMessage, sendWorkerWebSocketMessage } from "./websocket-transport.js";

const wsTestHarness = vi.hoisted(() => {
	class TinyEmitter {
		private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

		on(event: string, listener: (...args: any[]) => void): this {
			const listeners = this.listeners.get(event) ?? new Set();
			listeners.add(listener);
			this.listeners.set(event, listeners);
			return this;
		}

		once(event: string, listener: (...args: any[]) => void): this {
			const wrapped = (...args: any[]) => {
				this.off(event, wrapped);
				listener(...args);
			};
			return this.on(event, wrapped);
		}

		off(event: string, listener: (...args: any[]) => void): this {
			this.listeners.get(event)?.delete(listener);
			return this;
		}

		emit(event: string, ...args: any[]): boolean {
			const listeners = this.listeners.get(event);
			if (!listeners || listeners.size === 0) return false;
			for (const listener of [...listeners]) {
				listener(...args);
			}
			return true;
		}

		listenerCount(event: string): number {
			return this.listeners.get(event)?.size ?? 0;
		}
	}

	class FakeWebSocket extends TinyEmitter {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;

		readyState = FakeWebSocket.CONNECTING;
		peer?: FakeWebSocket;
		private readonly bufferedMessages: Buffer[] = [];

		link(peer: FakeWebSocket): void {
			this.peer = peer;
			peer.peer = this;
		}

		override on(event: string, listener: (...args: any[]) => void): this {
			super.on(event, listener);
			if (event === "message") {
				for (const payload of this.bufferedMessages.splice(0)) {
					listener(payload);
				}
			}
			return this;
		}

		open(): void {
			if (this.readyState !== FakeWebSocket.CONNECTING) return;
			this.readyState = FakeWebSocket.OPEN;
			this.emit("open");
		}

		send(data: string | Buffer, callback?: (error?: Error) => void): void {
			queueMicrotask(() => {
				if (this.readyState !== FakeWebSocket.OPEN || !this.peer || this.peer.readyState !== FakeWebSocket.OPEN) {
					callback?.(new Error("socket is not open"));
					return;
				}
				const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
				if (this.peer.listenerCount("message") === 0) {
					this.peer.bufferedMessages.push(payload);
				} else {
					this.peer.emit("message", payload);
				}
				callback?.();
			});
		}

		close(code = 1000, reason?: string): void {
			if (this.readyState === FakeWebSocket.CLOSED) return;
			this.readyState = FakeWebSocket.CLOSING;
			const peer = this.peer;
			queueMicrotask(() => {
				this.readyState = FakeWebSocket.CLOSED;
				this.emit("close", code, Buffer.from(reason ?? "", "utf8"));
				if (peer && peer.readyState !== FakeWebSocket.CLOSED) {
					peer.readyState = FakeWebSocket.CLOSED;
					peer.emit("close", code, Buffer.from(reason ?? "", "utf8"));
				}
			});
		}

		terminate(): void {
			this.close(1006, "terminated");
		}
	}

	type ConnectionContext = {
		client: FakeWebSocket;
		server: FakeWebSocket;
		url: string;
	};

	let connectionHandler: ((connection: ConnectionContext) => void) | undefined;
	const activeConnections: ConnectionContext[] = [];

	class MockWebSocket extends FakeWebSocket {
		constructor(url: string) {
			super();
			const server = new FakeWebSocket();
			this.link(server);
			const context = { client: this, server, url };
			activeConnections.push(context);
			queueMicrotask(() => {
				connectionHandler?.(context);
				server.open();
				this.open();
			});
		}
	}

	return {
		MockWebSocket,
		setConnectionHandler(handler?: (connection: ConnectionContext) => void) {
			connectionHandler = handler;
		},
		reset() {
			connectionHandler = undefined;
			for (const connection of activeConnections.splice(0)) {
				connection.client.terminate();
				connection.server.terminate();
			}
		},
	};
});

vi.mock("ws", () => ({
	default: wsTestHarness.MockWebSocket,
}));

const executeWithOverride = vi.fn();
const mockSession = {
	steer: vi.fn(async () => undefined),
};

vi.mock("../executor/index.js", () => ({
	PiAgentExecutor: vi.fn(() => ({
		executeWithOverride,
	})),
}));

import { runWorkerRuntime } from "./runtime.js";
import { PiAgentExecutor } from "../executor/index.js";

describe("runWorkerRuntime", () => {
	afterEach(() => {
		wsTestHarness.reset();
		vi.clearAllMocks();
	});

	it("handshakes, forwards session logs, handles steering, and sends completion", async () => {
		const sessionKey = "mbrooks/tars#12";
		const seenMessages: Array<ReturnType<typeof createWorkerMessage>> = [];
		let resolvePrompt!: () => void;
		const promptReleased = new Promise<void>((resolve) => {
			resolvePrompt = resolve;
		});
		mockSession.steer.mockImplementation(async () => {
			resolvePrompt();
		});

		executeWithOverride.mockImplementation(async (_state, prompt, _signal, onSessionCreated) => {
			onSessionCreated?.(mockSession);
			expect(prompt).toBe("custom prompt");
			emitSessionLogEvent(sessionKey, {
				timestamp: new Date().toISOString(),
				level: "assistant",
				message: "streamed output",
				details: { type: "response" },
			});
			await promptReleased;
			return {
				status: "complete",
				summary: "done",
				rawResponse: "TARS_STATUS: complete\ndone",
			};
		});

		wsTestHarness.setConnectionHandler(({ server }) => {
			server.on("message", async (raw: Buffer) => {
				const message = decodeWorkerWebSocketMessage(raw);
				seenMessages.push(message);
				if (message.type === "hello") {
					await sendWorkerWebSocketMessage(
						server as never,
						createWorkerMessage("launch_config", sessionKey, "launch-1", {
							session: {
								owner: "mbrooks",
								repo: "tars",
								issueNumber: 12,
								workspacePath: "/workspaces/mbrooks-tars/.worktrees/issue-12",
								title: "Issue title",
								body: "Issue body",
							},
							prompt: { kind: "override", text: "custom prompt" },
						}),
					);
					return;
				}

				if (message.type === "ack" && (message as WorkerProtocolMessage<"ack">).payload.ackMessageId === "launch-1") {
					setTimeout(() => {
						void sendWorkerWebSocketMessage(
							server as never,
							createWorkerMessage("control", sessionKey, "control-1", {
								action: "steer",
								message: "Please adjust course",
							}),
						);
					}, 25);
				}
			});
		});

		await runWorkerRuntime({
			wsUrl: "ws://worker.test/session-12",
			sessionKey,
			soulPath: "/tmp/SOUL.md",
			workerVersion: "test",
		});

		expect(mockSession.steer).toHaveBeenCalledWith("Please adjust course");
		expect(seenMessages.some((message) => message.type === "event_batch")).toBe(true);
		expect(seenMessages.some((message) => message.type === "complete")).toBe(true);
	});

	it("rejects invalid launch metadata from the server", async () => {
		wsTestHarness.setConnectionHandler(({ server }) => {
			server.on("message", async (raw: Buffer) => {
				const message = decodeWorkerWebSocketMessage(raw);
				if (message.type !== "hello") return;
				await sendWorkerWebSocketMessage(
					server as never,
					createWorkerMessage("launch_config", "other/session#1", "launch-bad", {
						session: {
							owner: "mbrooks",
							repo: "tars",
							issueNumber: 99,
							workspacePath: "/workspaces/mbrooks-tars/.worktrees/issue-99",
							title: "Bad session",
							body: "Body",
						},
						prompt: { kind: "override", text: "custom prompt" },
					}),
				);
			});
		});

		await expect(
			runWorkerRuntime({
				wsUrl: "ws://worker.test/session-99",
				sessionKey: "mbrooks/tars#99",
				soulPath: "/tmp/SOUL.md",
			}),
		).rejects.toThrow("Unexpected session key");
	});

	it("rejects unsupported protocol versions from the server", async () => {
		wsTestHarness.setConnectionHandler(({ server }) => {
			server.on("message", async (raw: Buffer) => {
				const message = decodeWorkerWebSocketMessage(raw);
				if (message.type !== "hello") return;
				await sendWorkerWebSocketMessage(
					server as never,
					{
						type: "launch_config",
						protocolVersion: 99,
						sessionKey: "mbrooks/tars#100",
						messageId: "launch-version",
						payload: {
							session: {
								owner: "mbrooks",
								repo: "tars",
								issueNumber: 100,
								workspacePath: "/workspaces/mbrooks-tars/.worktrees/issue-100",
								title: "Bad version",
								body: "Body",
							},
							prompt: { kind: "override", text: "custom prompt" },
						},
					} as WorkerProtocolMessage<"launch_config">,
				);
			});
		});

		await expect(
			runWorkerRuntime({
				wsUrl: "ws://worker.test/session-100",
				sessionKey: "mbrooks/tars#100",
				soulPath: "/tmp/SOUL.md",
			}),
		).rejects.toThrow("Unsupported protocol version");
	});

	it("aborts execution when TARS sends stop", async () => {
		const results: Array<ReturnType<typeof createWorkerMessage>> = [];

		executeWithOverride.mockImplementation(async (_state, _prompt, signal, onSessionCreated) => {
			onSessionCreated?.(mockSession);
			await new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return {
				status: "cancelled",
				summary: "stopped",
				rawResponse: "",
			};
		});

		wsTestHarness.setConnectionHandler(({ server }) => {
			server.on("message", async (raw: Buffer) => {
				const message = decodeWorkerWebSocketMessage(raw);
				results.push(message);
				if (message.type === "hello") {
					await sendWorkerWebSocketMessage(
						server as never,
						createWorkerMessage("launch_config", "mbrooks/tars#55", "launch-stop", {
							session: {
								owner: "mbrooks",
								repo: "tars",
								issueNumber: 55,
								workspacePath: "/workspaces/mbrooks-tars/.worktrees/issue-55",
								title: "Stop worker",
								body: "Body",
							},
							prompt: { kind: "override", text: "custom prompt" },
						}),
					);
					return;
				}

				if (message.type === "ack" && (message as WorkerProtocolMessage<"ack">).payload.ackMessageId === "launch-stop") {
					setTimeout(() => {
						void sendWorkerWebSocketMessage(
							server as never,
							createWorkerMessage("control", "mbrooks/tars#55", "control-stop", {
								action: "stop",
							}),
						);
					}, 25);
				}
			});
		});

		await runWorkerRuntime({
			wsUrl: "ws://worker.test/session-55",
			sessionKey: "mbrooks/tars#55",
			soulPath: "/tmp/SOUL.md",
		});

		expect(results.some((message) => message.type === "complete")).toBe(true);
	});

	it("reports steer-before-session as a worker error", async () => {
		const results: Array<ReturnType<typeof createWorkerMessage>> = [];
		let releaseExecution!: () => void;
		const executionReleased = new Promise<void>((resolve) => {
			releaseExecution = resolve;
		});

		executeWithOverride.mockImplementation(async () => {
			await executionReleased;
			return {
				status: "cancelled",
				summary: "stopped",
				rawResponse: "",
			};
		});

		wsTestHarness.setConnectionHandler(({ server }) => {
			server.on("message", async (raw: Buffer) => {
				const message = decodeWorkerWebSocketMessage(raw);
				results.push(message);
				if (message.type === "hello") {
					await sendWorkerWebSocketMessage(
						server as never,
						createWorkerMessage("launch_config", "mbrooks/tars#56", "launch-steer", {
							session: {
								owner: "mbrooks",
								repo: "tars",
								issueNumber: 56,
								workspacePath: "/workspaces/mbrooks-tars/.worktrees/issue-56",
								title: "Steer too early",
								body: "Body",
							},
							prompt: { kind: "override", text: "custom prompt" },
						}),
					);
					return;
				}

				if (message.type === "ack" && (message as WorkerProtocolMessage<"ack">).payload.ackMessageId === "launch-steer") {
					setTimeout(() => {
						void sendWorkerWebSocketMessage(
							server as never,
							createWorkerMessage("control", "mbrooks/tars#56", "control-steer", {
								action: "steer",
								message: "too soon",
							}),
						);
					}, 25);
				}
				if (message.type === "error") {
					releaseExecution();
				}
			});
		});

		await runWorkerRuntime({
			wsUrl: "ws://worker.test/session-56",
			sessionKey: "mbrooks/tars#56",
			soulPath: "/tmp/SOUL.md",
		});

		const workerError = results.find((message) => message.type === "error");
		expect(workerError).toBeDefined();
		expect((workerError as WorkerProtocolMessage<"error">).payload.message).toContain(
			"Worker received steer before session became available",
		);
	});

	it("rejects when the websocket closes before launch config arrives", async () => {
		wsTestHarness.setConnectionHandler(({ server }) => {
			server.on("message", (raw: Buffer) => {
				const message = decodeWorkerWebSocketMessage(raw);
				if (message.type === "hello") {
					setTimeout(() => {
						server.close();
					}, 0);
				}
			});
		});

		await expect(
			runWorkerRuntime({
				wsUrl: "ws://worker.test/session-57",
				sessionKey: "mbrooks/tars#57",
				soulPath: "/tmp/SOUL.md",
			}),
		).rejects.toThrow("Worker RPC connection closed before launch config arrived");
	});

	it("forwards llmLoggerConfig from the launch config into the PiAgentExecutor", async () => {
		const sessionKey = "mbrooks/tars#58";
		executeWithOverride.mockImplementation(async () => ({
			status: "complete",
			summary: "done",
			rawResponse: "TARS_STATUS: complete\ndone",
		}));

		wsTestHarness.setConnectionHandler(({ server }) => {
			server.on("message", async (raw: Buffer) => {
				const message = decodeWorkerWebSocketMessage(raw);
				if (message.type === "hello") {
					await sendWorkerWebSocketMessage(
						server as never,
						createWorkerMessage("launch_config", sessionKey, "launch-cfg", {
							session: {
								owner: "mbrooks",
								repo: "tars",
								issueNumber: 58,
								workspacePath: "/workspaces/mbrooks-tars/.worktrees/issue-58",
								title: "Configured",
								body: "Body",
							},
							prompt: { kind: "override", text: "custom prompt" },
							llmLoggerConfig: {
								logLevel: "error",
								logPrompts: false,
								logThoughts: false,
								logTools: true,
								logResponses: true,
							},
						}),
					);
				}
			});
		});

		await runWorkerRuntime({
			wsUrl: "ws://worker.test/session-58",
			sessionKey,
			soulPath: "/tmp/SOUL.md",
		});

		expect(PiAgentExecutor).toHaveBeenCalledWith(
			expect.objectContaining({
				soulPath: "/tmp/SOUL.md",
				llmLoggerConfig: expect.objectContaining({ logLevel: "error", logPrompts: false }),
			}),
		);
	});
});
