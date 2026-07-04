import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { emitSessionLogEvent } from "../logging/log-events.js";
import { WorkerMessageParser, encodeWorkerMessage } from "./framing.js";
import { createWorkerMessage, type WorkerProtocolMessage } from "./protocol.js";

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

describe("runWorkerRuntime", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("handshakes, forwards session logs, handles steering, and sends completion", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-worker-runtime-"));
		const socketPath = path.join(dir, "session.sock");
		const sessionKey = "mbrooks/tars#12";
		const parser = new WorkerMessageParser();
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

		const server = net.createServer((socket) => {
			socket.on("data", (chunk) => {
				for (const message of parser.push(chunk)) {
					seenMessages.push(message);
					if (message.type === "hello") {
						socket.write(
							encodeWorkerMessage(
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
							),
						);
					}
					if (message.type === "ack" && (message as WorkerProtocolMessage<"ack">).payload.ackMessageId === "launch-1") {
						setTimeout(() => {
							socket.write(
								encodeWorkerMessage(
									createWorkerMessage("control", sessionKey, "control-1", {
										action: "steer",
										message: "Please adjust course",
									}),
								),
							);
						}, 25);
					}
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));

		try {
			await runWorkerRuntime({
				socketPath,
				sessionKey,
				soulPath: "/tmp/SOUL.md",
				workerVersion: "test",
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
			await rm(dir, { recursive: true, force: true });
		}

		expect(mockSession.steer).toHaveBeenCalledWith("Please adjust course");
		expect(seenMessages.some((message) => message.type === "event_batch")).toBe(true);
		expect(seenMessages.some((message) => message.type === "complete")).toBe(true);
	});

	it("rejects invalid launch metadata from the server", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-worker-runtime-bad-"));
		const socketPath = path.join(dir, "session.sock");
		const parser = new WorkerMessageParser();

		const server = net.createServer((socket) => {
			socket.on("data", (chunk) => {
				for (const message of parser.push(chunk)) {
					if (message.type !== "hello") continue;
					socket.write(
						encodeWorkerMessage(
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
						),
					);
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));

		try {
			await expect(
				runWorkerRuntime({
					socketPath,
					sessionKey: "mbrooks/tars#99",
					soulPath: "/tmp/SOUL.md",
				}),
			).rejects.toThrow("Unexpected session key");
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects unsupported protocol versions from the server", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-worker-runtime-version-"));
		const socketPath = path.join(dir, "session.sock");
		const parser = new WorkerMessageParser();

		const server = net.createServer((socket) => {
			socket.on("data", (chunk) => {
				for (const message of parser.push(chunk)) {
					if (message.type !== "hello") continue;
					socket.write(
						encodeWorkerMessage({
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
						} as WorkerProtocolMessage<"launch_config">),
					);
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));

		try {
			await expect(
				runWorkerRuntime({
					socketPath,
					sessionKey: "mbrooks/tars#100",
					soulPath: "/tmp/SOUL.md",
				}),
			).rejects.toThrow("Unsupported protocol version");
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("aborts execution when TARS sends stop", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-worker-runtime-stop-"));
		const socketPath = path.join(dir, "session.sock");
		const parser = new WorkerMessageParser();
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

		const server = net.createServer((socket) => {
			socket.on("data", (chunk) => {
				for (const message of parser.push(chunk)) {
					results.push(message);
					if (message.type === "hello") {
						socket.write(
							encodeWorkerMessage(
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
							),
						);
					}
					if (message.type === "ack" && (message as WorkerProtocolMessage<"ack">).payload.ackMessageId === "launch-stop") {
						setTimeout(() => {
							socket.write(
								encodeWorkerMessage(
									createWorkerMessage("control", "mbrooks/tars#55", "control-stop", {
										action: "stop",
									}),
								),
							);
						}, 25);
					}
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));

		try {
			await runWorkerRuntime({
				socketPath,
				sessionKey: "mbrooks/tars#55",
				soulPath: "/tmp/SOUL.md",
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
			await rm(dir, { recursive: true, force: true });
		}

		expect(results.some((message) => message.type === "complete")).toBe(true);
	});

	it("reports steer-before-session as a worker error", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-worker-runtime-steer-"));
		const socketPath = path.join(dir, "session.sock");
		const parser = new WorkerMessageParser();
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

		const server = net.createServer((socket) => {
			socket.on("data", (chunk) => {
				for (const message of parser.push(chunk)) {
					results.push(message);
					if (message.type === "hello") {
						socket.write(
							encodeWorkerMessage(
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
							),
						);
					}
					if (message.type === "ack" && (message as WorkerProtocolMessage<"ack">).payload.ackMessageId === "launch-steer") {
						setTimeout(() => {
							socket.write(
								encodeWorkerMessage(
									createWorkerMessage("control", "mbrooks/tars#56", "control-steer", {
										action: "steer",
										message: "too soon",
									}),
								),
							);
						}, 25);
					}
					if (message.type === "error") {
						releaseExecution();
					}
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));

		try {
			await runWorkerRuntime({
				socketPath,
				sessionKey: "mbrooks/tars#56",
				soulPath: "/tmp/SOUL.md",
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
			await rm(dir, { recursive: true, force: true });
		}

		const workerError = results.find((message) => message.type === "error");
		expect(workerError).toBeDefined();
		expect((workerError as WorkerProtocolMessage<"error">).payload.message).toContain(
			"Worker received steer before session became available",
		);
	});
});
