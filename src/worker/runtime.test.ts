import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
const executeRefinement = vi.fn();
const mockSession = {
	steer: vi.fn(async () => undefined),
};

vi.mock("../executor/index.js", () => ({
	PiAgentExecutor: vi.fn(() => ({
		executeWithOverride,
		executeRefinement,
	})),
}));

import { PiAgentExecutor } from "../executor/index.js";
import { sessionStorageKey } from "../session/store.js";
import { runWorkerRuntime } from "./runtime.js";
import { callGitHubGateway } from "./github-gateway-client.js";

describe("runWorkerRuntime", () => {
	afterEach(() => {
		wsTestHarness.reset();
		vi.clearAllMocks();
	});

	it("handshakes, forwards session logs, handles steering, and sends completion", async () => {
		const sessionKey = "github-mbrooks-yolomatic-issue-12-implementation";
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
				rawResponse: "YOLO_STATUS: complete\ndone",
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
								repo: "yolomatic",
								issueNumber: 12,
								workspacePath: "/workspaces/mbrooks-yolomatic/.worktrees/issue-12",
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
		expect(PiAgentExecutor).toHaveBeenCalledWith({
			soulPath: "/tmp/SOUL.md",
			trustedExtensionPath: "/tmp/.pi/extensions/github-issues.ts",
		});
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
							repo: "yolomatic",
							issueNumber: 99,
							workspacePath: "/workspaces/mbrooks-yolomatic/.worktrees/issue-99",
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
				sessionKey: "github-mbrooks-yolomatic-issue-99-implementation",
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
						sessionKey: "github-mbrooks-yolomatic-issue-100-implementation",
						messageId: "launch-version",
						payload: {
							session: {
								owner: "mbrooks",
								repo: "yolomatic",
								issueNumber: 100,
								workspacePath: "/workspaces/mbrooks-yolomatic/.worktrees/issue-100",
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
				sessionKey: "github-mbrooks-yolomatic-issue-100-implementation",
				soulPath: "/tmp/SOUL.md",
			}),
		).rejects.toThrow("Unsupported protocol version");
	});

	it("aborts execution when Yolomatic sends stop", async () => {
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
						createWorkerMessage("launch_config", "github-mbrooks-yolomatic-issue-55-implementation", "launch-stop", {
							session: {
								owner: "mbrooks",
								repo: "yolomatic",
								issueNumber: 55,
								workspacePath: "/workspaces/mbrooks-yolomatic/.worktrees/issue-55",
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
							createWorkerMessage("control", "github-mbrooks-yolomatic-issue-55-implementation", "control-stop", {
								action: "stop",
							}),
						);
					}, 25);
				}
			});
		});

		await runWorkerRuntime({
			wsUrl: "ws://worker.test/session-55",
			sessionKey: "github-mbrooks-yolomatic-issue-55-implementation",
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
						createWorkerMessage("launch_config", "github-mbrooks-yolomatic-issue-56-implementation", "launch-steer", {
							session: {
								owner: "mbrooks",
								repo: "yolomatic",
								issueNumber: 56,
								workspacePath: "/workspaces/mbrooks-yolomatic/.worktrees/issue-56",
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
							createWorkerMessage("control", "github-mbrooks-yolomatic-issue-56-implementation", "control-steer", {
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
			sessionKey: "github-mbrooks-yolomatic-issue-56-implementation",
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
				sessionKey: "github-mbrooks-yolomatic-issue-57-implementation",
				soulPath: "/tmp/SOUL.md",
			}),
		).rejects.toThrow("Worker RPC connection closed before launch config arrived");
	});

	it("routes gateway tool calls to the control plane and resolves the tool_response", async () => {
		const sessionKey = "github-mbrooks-yolomatic-issue-77-implementation";
		const seenToolRequests: string[] = [];

		executeWithOverride.mockImplementation(async () => {
			const data = await callGitHubGateway("get_authenticated_user", {});
			expect(data).toEqual({ login: "yolomatic-bot" });
			return {
				status: "complete",
				summary: "done",
				rawResponse: "YOLO_STATUS: complete\ndone",
			};
		});

		wsTestHarness.setConnectionHandler(({ server }) => {
			server.on("message", async (raw: Buffer) => {
				const message = decodeWorkerWebSocketMessage(raw);
				if (message.type === "hello") {
					await sendWorkerWebSocketMessage(
						server as never,
						createWorkerMessage("launch_config", sessionKey, "launch-gw", {
							session: {
								owner: "mbrooks",
								repo: "yolomatic",
								issueNumber: 77,
								workspacePath: "/workspaces/mbrooks-yolomatic/.worktrees/issue-77",
								title: "Gateway round trip",
								body: "Body",
							},
							prompt: { kind: "override", text: "custom prompt" },
						}),
					);
					return;
				}
				if (message.type === "tool_request") {
					seenToolRequests.push(message.messageId);
					await sendWorkerWebSocketMessage(
						server as never,
						createWorkerMessage("tool_response", sessionKey, "resp-gw", {
							requestMessageId: message.messageId,
							ok: true,
							data: { login: "yolomatic-bot" },
						}),
					);
				}
			});
		});

		await runWorkerRuntime({
			wsUrl: "ws://worker.test/session-77",
			sessionKey,
			soulPath: "/tmp/SOUL.md",
		});

		expect(seenToolRequests).toHaveLength(1);
	});

	it("surfaces gateway scope errors from the control plane as thrown errors", async () => {
		const sessionKey = "github-mbrooks-yolomatic-issue-78-implementation";

		executeWithOverride.mockImplementation(async () => {
			await expect(callGitHubGateway("fetch_pr", { pr_number: 999 })).rejects.toThrow(
				"GitHub scope error: pr_number 999 is not associated",
			);
			return {
				status: "complete",
				summary: "done",
				rawResponse: "YOLO_STATUS: complete\ndone",
			};
		});

		wsTestHarness.setConnectionHandler(({ server }) => {
			server.on("message", async (raw: Buffer) => {
				const message = decodeWorkerWebSocketMessage(raw);
				if (message.type === "hello") {
					await sendWorkerWebSocketMessage(
						server as never,
						createWorkerMessage("launch_config", sessionKey, "launch-scope", {
							session: {
								owner: "mbrooks",
								repo: "yolomatic",
								issueNumber: 78,
								workspacePath: "/workspaces/mbrooks-yolomatic/.worktrees/issue-78",
								title: "Scope error",
								body: "Body",
							},
							prompt: { kind: "override", text: "custom prompt" },
						}),
					);
					return;
				}
				if (message.type === "tool_request") {
					await sendWorkerWebSocketMessage(
						server as never,
						{
							...createWorkerMessage("tool_response", sessionKey, "resp-scope", {
								requestMessageId: message.messageId,
								ok: false,
								error: "pr_number 999 is not associated",
							}),
							payload: {
								requestMessageId: message.messageId,
								ok: false,
								error: "pr_number 999 is not associated",
								scopeError: true,
							},
						} as WorkerProtocolMessage<"tool_response">,
					);
				}
			});
		});

		await runWorkerRuntime({
			wsUrl: "ws://worker.test/session-78",
			sessionKey,
			soulPath: "/tmp/SOUL.md",
		});
	});

	it("runs yolostrap.sh before constructing the executor when the script is present", async () => {
		const workspacePath = await mkdtemp(path.join(os.tmpdir(), "yolomatic-worker-init-"));
		const markerPath = path.join(workspacePath, "init-marker.txt");
		await writeFile(
			path.join(workspacePath, "yolostrap.sh"),
			`#!/usr/bin/env bash\nset -euo pipefail\nprintf 'ran' > "${markerPath}"\n`,
		);
		const sessionKey = "github-mbrooks-yolomatic-issue-801-implementation";
		let executorConstructed = false;

		executeWithOverride.mockImplementation(async (_state, _prompt, _signal, onSessionCreated) => {
			executorConstructed = true;
			onSessionCreated?.(mockSession);
			expect(markerPath).not.toBe("");
			return { status: "complete", summary: "done", rawResponse: "YOLO_STATUS: complete\ndone" };
		});

		wsTestHarness.setConnectionHandler(({ server }) => {
			server.on("message", async (raw: Buffer) => {
				const message = decodeWorkerWebSocketMessage(raw);
				if (message.type !== "hello") return;
				await sendWorkerWebSocketMessage(
					server as never,
					createWorkerMessage("launch_config", sessionKey, "launch-init", {
						session: {
							owner: "mbrooks",
							repo: "yolomatic",
							issueNumber: 801,
							workspacePath,
							title: "Init runs",
							body: "Body",
						},
						prompt: { kind: "override", text: "custom prompt" },
					}),
				);
			});
		});

		try {
			await runWorkerRuntime({
				wsUrl: "ws://worker.test/session-801",
				sessionKey,
				soulPath: "/tmp/SOUL.md",
			});
			expect(executorConstructed).toBe(true);
			await expect(readFile(markerPath, "utf8")).resolves.toBe("ran");
		} finally {
			await rm(workspacePath, { recursive: true, force: true });
		}
	});

	it("skips the init step and proceeds to the executor when yolostrap.sh is absent", async () => {
		const workspacePath = await mkdtemp(path.join(os.tmpdir(), "yolomatic-worker-noinit-"));
		const sessionKey = "github-mbrooks-yolomatic-issue-802-implementation";
		let executorConstructed = false;

		executeWithOverride.mockImplementation(async (_state, _prompt, _signal, onSessionCreated) => {
			executorConstructed = true;
			onSessionCreated?.(mockSession);
			return { status: "complete", summary: "done", rawResponse: "YOLO_STATUS: complete\ndone" };
		});

		wsTestHarness.setConnectionHandler(({ server }) => {
			server.on("message", async (raw: Buffer) => {
				const message = decodeWorkerWebSocketMessage(raw);
				if (message.type !== "hello") return;
				await sendWorkerWebSocketMessage(
					server as never,
					createWorkerMessage("launch_config", sessionKey, "launch-noinit", {
						session: {
							owner: "mbrooks",
							repo: "yolomatic",
							issueNumber: 802,
							workspacePath,
							title: "No init",
							body: "Body",
						},
						prompt: { kind: "override", text: "custom prompt" },
					}),
				);
			});
		});

		try {
			await runWorkerRuntime({
				wsUrl: "ws://worker.test/session-802",
				sessionKey,
				soulPath: "/tmp/SOUL.md",
			});
			expect(executorConstructed).toBe(true);
		} finally {
			await rm(workspacePath, { recursive: true, force: true });
		}
	});

	it("aborts the runtime with a worker error when yolostrap.sh exits non-zero", async () => {
		const workspacePath = await mkdtemp(path.join(os.tmpdir(), "yolomatic-worker-badinit-"));
		await writeFile(
			path.join(workspacePath, "yolostrap.sh"),
			"#!/usr/bin/env bash\nset -euo pipefail\necho 'nope' >&2\nexit 7\n",
		);
		const sessionKey = "github-mbrooks-yolomatic-issue-803-implementation";
		const seenMessages: Array<ReturnType<typeof createWorkerMessage>> = [];
		let executorConstructed = false;

		executeWithOverride.mockImplementation(async () => {
			executorConstructed = true;
			return { status: "complete", summary: "done", rawResponse: "YOLO_STATUS: complete\ndone" };
		});

		wsTestHarness.setConnectionHandler(({ server }) => {
			server.on("message", async (raw: Buffer) => {
				const message = decodeWorkerWebSocketMessage(raw);
				seenMessages.push(message);
				if (message.type !== "hello") return;
				await sendWorkerWebSocketMessage(
					server as never,
					createWorkerMessage("launch_config", sessionKey, "launch-bad", {
						session: {
							owner: "mbrooks",
							repo: "yolomatic",
							issueNumber: 803,
							workspacePath,
							title: "Bad init",
							body: "Body",
						},
						prompt: { kind: "override", text: "custom prompt" },
					}),
				);
			});
		});

		try {
			await expect(
				runWorkerRuntime({
					wsUrl: "ws://worker.test/session-803",
					sessionKey,
					soulPath: "/tmp/SOUL.md",
				}),
			).rejects.toThrow(/Init script exited with code 7/);
			expect(executorConstructed).toBe(false);
			const workerError = seenMessages.find((message) => message.type === "error");
			expect(workerError).toBeDefined();
			expect((workerError as WorkerProtocolMessage<"error">).payload.message).toMatch(/Init script exited with code 7/);
		} finally {
			await rm(workspacePath, { recursive: true, force: true });
		}
	});

	it("forwards refinement LLM logs under the refinement session key", async () => {
		const sessionKey = "github-mbrooks-yolomatic-issue-200-refinement";
		const seenMessages: Array<ReturnType<typeof createWorkerMessage>> = [];
		let capturedState: { kind?: string; owner: string; repo: string; issueNumber: number } | undefined;

		executeRefinement.mockImplementation(async (state, _prompt, _signal, onSessionCreated) => {
			capturedState = state;
			onSessionCreated?.(mockSession);
			// Mirror the executor's key derivation so the test reproduces the bug:
			// the executor records under sessionStorageKey(...state.kind ?? "implementation").
			const key = sessionStorageKey(state.owner, state.repo, state.issueNumber, state.kind ?? "implementation");
			emitSessionLogEvent(key, {
				timestamp: new Date().toISOString(),
				level: "assistant",
				message: "thinking…",
				details: { type: "thinking" },
			});
			emitSessionLogEvent(key, {
				timestamp: new Date().toISOString(),
				level: "assistant",
				message: "response",
				details: { type: "response" },
			});
			emitSessionLogEvent(key, {
				timestamp: new Date().toISOString(),
				level: "assistant",
				message: "tool call",
				details: { type: "tool_execution_start" },
			});
			return {
				proposedTaskBody: "body",
				summary: "done",
				investigation: "investigation",
			};
		});

		wsTestHarness.setConnectionHandler(({ server }) => {
			server.on("message", async (raw: Buffer) => {
				const message = decodeWorkerWebSocketMessage(raw);
				seenMessages.push(message);
				if (message.type === "hello") {
					await sendWorkerWebSocketMessage(
						server as never,
						createWorkerMessage("launch_config", sessionKey, "launch-refinement", {
							session: {
								owner: "mbrooks",
								repo: "yolomatic",
								issueNumber: 200,
								workspacePath: "/workspaces/mbrooks-yolomatic/.worktrees/issue-200",
								title: "Refine me",
								body: "Body",
								kind: "refinement",
							},
							prompt: { kind: "issue-refinement", text: "custom prompt" },
						}),
					);
					return;
				}
			});
		});

		await runWorkerRuntime({
			wsUrl: "ws://worker.test/session-200",
			sessionKey,
			soulPath: "/tmp/SOUL.md",
		});

		// The state forwarded to the executor must carry the refinement kind so the
		// executor records LLM events under the refinement key (matching the
		// runtime's sessionLogKey). Without `kind`, capturedState would default to
		// the implementation key and no event_batch would be forwarded.
		expect(capturedState?.kind).toBe("refinement");

		const eventBatches = seenMessages.filter((message) => message.type === "event_batch");
		expect(eventBatches.length).toBeGreaterThan(0);
		const forwardedEntries = eventBatches.flatMap(
			(message) => (message as WorkerProtocolMessage<"event_batch">).payload.events,
		);
		expect(forwardedEntries.some((event) => event.type === "session_log")).toBe(true);
		const logEntries = forwardedEntries.filter((event) => event.type === "session_log");
		expect(logEntries.some((event) => event.entry.details?.type === "thinking")).toBe(true);
		expect(logEntries.some((event) => event.entry.details?.type === "response")).toBe(true);
		expect(logEntries.some((event) => event.entry.details?.type === "tool_execution_start")).toBe(true);
	});

	it("skips the init step on issue-refinement launches even when yolostrap.sh is present", async () => {
		const workspacePath = await mkdtemp(path.join(os.tmpdir(), "yolomatic-worker-refinement-skip-"));
		const markerPath = path.join(workspacePath, "init-marker.txt");
		await writeFile(
			path.join(workspacePath, "yolostrap.sh"),
			`#!/usr/bin/env bash\nset -euo pipefail\nprintf 'ran' > "${markerPath}"\n`,
		);
		const sessionKey = "github-mbrooks-yolomatic-issue-201-refinement";
		const seenMessages: Array<ReturnType<typeof createWorkerMessage>> = [];

		executeRefinement.mockImplementation(async (_state, _prompt, _signal, onSessionCreated) => {
			onSessionCreated?.(mockSession);
			return {
				proposedTaskBody: "body",
				summary: "done",
				investigation: "investigation",
			};
		});

		wsTestHarness.setConnectionHandler(({ server }) => {
			server.on("message", async (raw: Buffer) => {
				const message = decodeWorkerWebSocketMessage(raw);
				seenMessages.push(message);
				if (message.type !== "hello") return;
				await sendWorkerWebSocketMessage(
					server as never,
					createWorkerMessage("launch_config", sessionKey, "launch-refinement-skip", {
						session: {
							owner: "mbrooks",
							repo: "yolomatic",
							issueNumber: 201,
							workspacePath,
							title: "Refine without init",
							body: "Body",
							kind: "refinement",
						},
						prompt: { kind: "issue-refinement", text: "custom prompt" },
					}),
				);
			});
		});

		try {
			await runWorkerRuntime({
				wsUrl: "ws://worker.test/session-201",
				sessionKey,
				soulPath: "/tmp/SOUL.md",
			});

			expect(executeRefinement).toHaveBeenCalled();
			// The init script must not have run: no marker file is written.
			await expect(readFile(markerPath, "utf8")).rejects.toThrow();
			// No env_init session_log events should be forwarded to the control plane.
			const eventBatches = seenMessages.filter((message) => message.type === "event_batch");
			const forwardedEntries = eventBatches.flatMap(
				(message) => (message as WorkerProtocolMessage<"event_batch">).payload.events,
			);
			const envInitEvents = forwardedEntries.filter(
				(event) =>
					event.type === "session_log" &&
					event.entry.details?.type === "env_init",
			);
			expect(envInitEvents).toHaveLength(0);
		} finally {
			await rm(workspacePath, { recursive: true, force: true });
		}
	});
});
