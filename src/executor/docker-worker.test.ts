import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkerMessage, type AnyWorkerProtocolMessage, type WorkerProtocolMessage } from "../worker/protocol.js";
import type { PendingWorkerRpcConnection, WorkerRpcConnection, WorkerRpcServer } from "../worker/rpc-server.js";

const { execFileMock, spawnMock, recordSessionLogMock } = vi.hoisted(() => ({
	execFileMock: vi.fn(),
	spawnMock: vi.fn(),
	recordSessionLogMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: execFileMock,
	spawn: spawnMock,
}));

vi.mock("../logging/session-log-store.js", () => ({
	recordSessionLog: recordSessionLogMock,
}));

import { DockerWorkerExecutor } from "./docker-worker.js";

describe("DockerWorkerExecutor", () => {
	const currentWorkerTransport = "websocket-v1";

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("launches a docker worker, streams logs, and exposes steering", async () => {
		const harness = await createHarness(418);
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, currentWorkerTransport, ""));

		spawnMock.mockImplementation((_cmd, args, options) => {
			const child = makeChildProcess();

			expect(args).toContain("run");
			expect(args).toContain("--mount");
			expect(args).not.toContain("GITHUB_TOKEN");
			expect(options.env.YEETOMATIC_SESSION_KEY).toBe("mbrooks/tars#418");
			expect(options.env.YEETOMATIC_SESSION_WS_URL).toContain("sessionKey=mbrooks%2Ftars%23418");

			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YEETOMATIC_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					const launch = message as WorkerProtocolMessage<"launch_config">;
					expect(launch.payload.session.workspacePath).toBe(harness.workspacePath);
					await connection.send(
						createWorkerMessage("ack", "mbrooks/tars#418", "ack-1", {
							ackMessageId: launch.messageId,
						}),
					);
					await connection.send(
						createWorkerMessage("event_batch", "mbrooks/tars#418", "events-1", {
							events: [
								{
									type: "session_log",
									entry: {
										timestamp: new Date().toISOString(),
										level: "info",
										message: "Prompt sent",
										details: { type: "prompt" },
									},
								},
							],
						}),
					);
					await connection.send(
						createWorkerMessage("complete", "mbrooks/tars#418", "complete-1", {
							result: {
								status: "complete",
								summary: "done",
								rawResponse: "YEETOMATIC_STATUS: complete\ndone",
							},
						}),
					);
				},
			);

			return child;
		});

		try {
			const result = await harness.executor.execute({
				issueNumber: 418,
				repo: "tars",
				owner: "mbrooks",
				title: "Implement dockerized worker runtime",
				body: "Body",
				status: "pending",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: harness.workspacePath,
				lastActivity: new Date().toISOString(),
				seeded: false,
			});

			expect(result.status).toBe("complete");
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"mbrooks/tars#418",
				expect.objectContaining({ message: "Launching worker container yeetomatic-session-mbrooks-tars-418" }),
			);
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"mbrooks/tars#418",
				expect.objectContaining({ message: "Prompt sent" }),
			);
		} finally {
			await harness.close();
		}
	});

	it("builds the worker image before the first session", async () => {
		const harness = await createHarness(419);
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YEETOMATIC_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("ack", "mbrooks/tars#419", "ack-build", {
							ackMessageId: message.messageId,
						}),
					);
					await connection.send(
						createWorkerMessage("complete", "mbrooks/tars#419", "complete-build", {
							result: {
								status: "complete",
								summary: "done",
								rawResponse: "YEETOMATIC_STATUS: complete\ndone",
							},
						}),
					);
				},
			);
			return child;
		});

		try {
			await harness.executor.execute({
				issueNumber: 419,
				repo: "tars",
				owner: "mbrooks",
				title: "Build image when missing",
				body: "Body",
				status: "pending",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: harness.workspacePath,
				lastActivity: new Date().toISOString(),
				seeded: false,
			});

			expect(execFileMock).toHaveBeenNthCalledWith(
				1,
				"docker",
				[
					"build",
					"--target",
					"worker",
					"--label",
					"io.yeetomatic.worker.transport=websocket-v1",
					"-t",
					"yeetomatic-worker:latest",
					"/repo",
				],
				expect.any(Object),
				expect.any(Function),
			);
		} finally {
			await harness.close();
		}
	});

	it("rebuilds an existing worker image instead of trusting its transport label", async () => {
		const harness = await createHarness(424);
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YEETOMATIC_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("ack", "mbrooks/tars#424", "ack-rebuild", {
							ackMessageId: message.messageId,
						}),
					);
					await connection.send(
						createWorkerMessage("complete", "mbrooks/tars#424", "complete-rebuild", {
							result: {
								status: "complete",
								summary: "done",
								rawResponse: "YEETOMATIC_STATUS: complete\ndone",
							},
						}),
					);
				},
			);
			return child;
		});

		try {
			await harness.executor.execute({
				issueNumber: 424,
				repo: "tars",
				owner: "mbrooks",
				title: "Rebuild stale worker image",
				body: "Body",
				status: "pending",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: harness.workspacePath,
				lastActivity: new Date().toISOString(),
				seeded: false,
			});

			expect(execFileMock).toHaveBeenNthCalledWith(
				1,
				"docker",
				[
					"build",
					"--target",
					"worker",
					"--label",
					"io.yeetomatic.worker.transport=websocket-v1",
					"-t",
					"yeetomatic-worker:latest",
					harness.projectRoot,
				],
				expect.any(Object),
				expect.any(Function),
			);
		} finally {
			await harness.close();
		}
	});

	it("normalizes helper values, builds worker URLs, and rejects workspaces outside the mount root", async () => {
		const workerRpcServer = createFakeWorkerRpcServer();

		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "yeetomatic-worker:latest",
			workerWorkspaceMountSource: "named-volume",
			workerControlBaseUrl: "https://control.example.test/base",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			workerOllamaHost: "http://custom-host:11434",
			soulPath: "/app/SOUL.md",
		});

		expect((executor as any).buildMountSpec("named-volume", "/workspaces")).toContain("type=volume");
		expect((executor as any).resolveWorkerOllamaHost()).toBe("http://custom-host:11434");
		expect((executor as any).appendOutput("a".repeat(3990), "b".repeat(50))).toHaveLength(4000);
		expect((executor as any).buildWorkerSessionUrl("mbrooks/tars#1", "token-1")).toBe(
			"wss://control.example.test/yeetomatic-worker/ws?sessionKey=mbrooks%2Ftars%231&token=token-1",
		);
		expect(() => (executor as any).resolveWorkerWorkspacePath("/other/place")).toThrow("outside configured WORKSPACES_DIR");
	});

	it("falls back to raw or translated OLLAMA_HOST values", async () => {
		const workerRpcServer = createFakeWorkerRpcServer();
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "yeetomatic-worker:latest",
			workerWorkspaceMountSource: "named-volume",
			workerControlBaseUrl: "http://host.docker.internal:6767",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			soulPath: "/app/SOUL.md",
		});

		delete process.env.OLLAMA_HOST;
		expect((executor as any).resolveWorkerOllamaHost()).toBeUndefined();

		process.env.OLLAMA_HOST = "not-a-url";
		expect((executor as any).resolveWorkerOllamaHost()).toBe("not-a-url");

		process.env.OLLAMA_HOST = "http://127.0.0.1:11434";
		expect((executor as any).resolveWorkerOllamaHost()).toBe("http://host.docker.internal:11434/");

		delete process.env.OLLAMA_HOST;
	});

	it("uses shared container networking without rewriting loopback hosts", async () => {
		const workerRpcServer = createFakeWorkerRpcServer();
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "yeetomatic-worker:latest",
			workerWorkspaceMountSource: "/workspace-root",
			workerControlBaseUrl: "http://127.0.0.1:6767",
			workerDockerNetworkMode: "container:yeetomatic",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			soulPath: "/app/SOUL.md",
		});

		process.env.OLLAMA_HOST = "http://127.0.0.1:11434";

		try {
			expect((executor as any).resolveWorkerOllamaHost()).toBe("http://127.0.0.1:11434/");
			expect((executor as any).buildWorkerSessionUrl("mbrooks/tars#1", "token-1")).toBe(
				"ws://127.0.0.1:6767/yeetomatic-worker/ws?sessionKey=mbrooks%2Ftars%231&token=token-1",
			);

			const args = await (executor as any).buildDockerRunArgs("worker-1");
			expect(args).toContain("--network");
			expect(args).toContain("container:yeetomatic");
			expect(args).not.toContain("--add-host");
		} finally {
			delete process.env.OLLAMA_HOST;
		}
	});

	it("resolves the mounted workspace volume name from the control-plane container", async () => {
		const workerRpcServer = createFakeWorkerRpcServer();
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/app/workspaces",
			workerImage: "yeetomatic-worker:latest",
			workerWorkspaceMountSource: "yeetomatic_workspaces",
			workerControlBaseUrl: "http://127.0.0.1:6767",
			workerDockerNetworkMode: "container:yeetomatic",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			soulPath: "/app/SOUL.md",
		});

		const originalHostname = process.env.HOSTNAME;
		process.env.HOSTNAME = "container-123";
		execFileMock.mockImplementation((_cmd, _args, _options, callback) =>
			callback(
				null,
				JSON.stringify([
					{ Destination: "/app/workspaces", Type: "volume", Name: "yeetomatic_yeetomatic_workspaces" },
				]),
				"",
			),
		);

		try {
			const args = await (executor as any).buildDockerRunArgs("worker-1");
			expect(args).toContain("type=volume,src=yeetomatic_yeetomatic_workspaces,dst=/app/workspaces");
			expect(execFileMock).toHaveBeenCalledWith(
				"docker",
				["inspect", "--format", "{{json .Mounts}}", "container-123"],
				expect.any(Object),
				expect.any(Function),
			);
		} finally {
			process.env.HOSTNAME = originalHostname;
		}
	});

	it("includes explicit model env vars in docker args", async () => {
		const workerRpcServer = createFakeWorkerRpcServer();
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "yeetomatic-worker:latest",
			workerWorkspaceMountSource: "/workspace-root",
			workerControlBaseUrl: "http://control-plane.test",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			soulPath: "/app/SOUL.md",
		});

		process.env.PI_AGENT_PROVIDER = "ollama";
		process.env.PI_AGENT_MODEL = "glm-test";

		try {
			const args = await (executor as any).buildDockerRunArgs("worker-1");
			expect(args).toContain("PI_AGENT_PROVIDER=ollama");
			expect(args).toContain("PI_AGENT_MODEL=glm-test");
		} finally {
			delete process.env.PI_AGENT_PROVIDER;
			delete process.env.PI_AGENT_MODEL;
		}
	});

	it("propagates worker errors", async () => {
		const harness = await createHarness(420);
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, currentWorkerTransport, ""));

		spawnMock.mockImplementation((_cmd, args, options) => {
			const child = makeChildProcess();
			expect(args).toContain("-e");
			expect(args).toContain("OLLAMA_HOST=http://host.docker.internal:11434/");

			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YEETOMATIC_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("error", "mbrooks/tars#420", "error-1", {
							message: "worker blew up",
						}),
					);
				},
			);

			return child;
		});

		process.env.OLLAMA_HOST = "http://127.0.0.1:11434";

		try {
			await expect(
				harness.executor.execute({
					issueNumber: 420,
					repo: "tars",
					owner: "mbrooks",
					title: "Feedback task",
					body: "Body",
					status: "pending",
					sessionPath: "/tmp/session.jsonl",
					workspacePath: harness.workspacePath,
					lastActivity: new Date().toISOString(),
					seeded: false,
				}, "Please retry."),
			).rejects.toThrow("worker blew up");
		} finally {
			delete process.env.OLLAMA_HOST;
			await harness.close();
		}
	});

	it("sends stop control when aborted", async () => {
		const harness = await createHarness(421);
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, currentWorkerTransport, ""));

		let sawStop = false;
		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();

			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YEETOMATIC_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type === "launch_config") {
						await connection.send(
							createWorkerMessage("ack", "mbrooks/tars#421", "ack-launch", {
								ackMessageId: message.messageId,
							}),
						);
						return;
					}
					if (message.type === "control") {
						sawStop = message.payload.action === "stop";
						await connection.send(
							createWorkerMessage("ack", "mbrooks/tars#421", "ack-stop", {
								ackMessageId: message.messageId,
							}),
						);
						await connection.send(
							createWorkerMessage("complete", "mbrooks/tars#421", "complete-stop", {
								result: {
									status: "cancelled",
									summary: "stopped",
									rawResponse: "",
								},
							}),
						);
					}
				},
			);

			return child;
		});

		const abortController = new AbortController();

		try {
			const run = harness.executor.execute({
				issueNumber: 421,
				repo: "tars",
				owner: "mbrooks",
				title: "Abort task",
				body: "Body",
				status: "pending",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: harness.workspacePath,
				lastActivity: new Date().toISOString(),
				seeded: false,
			}, undefined, abortController.signal);
			setTimeout(() => abortController.abort(), 20);
			const result = await run;
			expect(result.status).toBe("cancelled");
			expect(sawStop).toBe(true);
		} finally {
			await harness.close();
		}
	});

	it("rejects connections with an unexpected session key", async () => {
		const harness = await createHarness(422);
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, currentWorkerTransport, ""));

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			void connectWorkerSession(harness.workerRpcServer, options.env.YEETOMATIC_SESSION_WS_URL as string).then(async (connection) => {
				await connection.send(
					createWorkerMessage("hello", "mbrooks/tars#999", "hello-wrong-session", {
						workerVersion: "test",
						pid: 321,
					}),
				);
			});
			return child;
		});

		try {
			await expect(
				harness.executor.execute({
					issueNumber: 422,
					repo: "tars",
					owner: "mbrooks",
					title: "Wrong session key",
					body: "Body",
					status: "pending",
					sessionPath: "/tmp/session.jsonl",
					workspacePath: harness.workspacePath,
					lastActivity: new Date().toISOString(),
					seeded: false,
				}),
			).rejects.toThrow("Worker connection closed unexpectedly.");
		} finally {
			await harness.close();
		}
	});

	it("rejects connections with an unsupported protocol version", async () => {
		const harness = await createHarness(423);
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, currentWorkerTransport, ""));

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			void connectWorkerSession(harness.workerRpcServer, options.env.YEETOMATIC_SESSION_WS_URL as string).then(async (connection) => {
				await connection.send({
					...createWorkerMessage("hello", "mbrooks/tars#423", "hello-bad-version", {
						workerVersion: "test",
						pid: 321,
					}),
					protocolVersion: 99,
				});
			});
			return child;
		});

		try {
			await expect(
				harness.executor.execute({
					issueNumber: 423,
					repo: "tars",
					owner: "mbrooks",
					title: "Bad protocol version",
					body: "Body",
					status: "pending",
					sessionPath: "/tmp/session.jsonl",
					workspacePath: harness.workspacePath,
					lastActivity: new Date().toISOString(),
					seeded: false,
				}),
			).rejects.toThrow("Worker connection closed unexpectedly.");
		} finally {
			await harness.close();
		}
	});

	it("removes a stopped conflicting container and retries the worker launch", async () => {
		const harness = await createHarness(425);
		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			if (args[0] === "inspect") {
				callback(null, "exited\n", "");
				return;
			}
			callback(null, "", "");
		});

		spawnMock
			.mockImplementationOnce(() => makeConflictingChildProcess(425))
			.mockImplementationOnce((_cmd, _args, options) => {
				const child = makeChildProcess();
				void connectMockWorker(
					harness.workerRpcServer,
					options.env.YEETOMATIC_SESSION_WS_URL as string,
					async (connection, message) => {
						if (message.type !== "launch_config") return;
						await connection.send(
							createWorkerMessage("ack", "mbrooks/tars#425", "ack-retry", {
								ackMessageId: message.messageId,
							}),
						);
						await connection.send(
							createWorkerMessage("complete", "mbrooks/tars#425", "complete-retry", {
								result: {
									status: "complete",
									summary: "recovered",
									rawResponse: "YEETOMATIC_STATUS: complete\nrecovered",
								},
							}),
						);
					},
				);
				return child;
			});

		try {
			const result = await harness.executor.execute(makeSessionState(425, harness.workspacePath));

			expect(result.status).toBe("complete");
			expect(spawnMock).toHaveBeenCalledTimes(2);
			expect(execFileMock).toHaveBeenCalledWith(
				"docker",
				["inspect", "--format", "{{.State.Status}}", "yeetomatic-session-mbrooks-tars-425"],
				expect.any(Object),
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenCalledWith(
				"docker",
				["rm", "yeetomatic-session-mbrooks-tars-425"],
				expect.any(Object),
				expect.any(Function),
			);
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"mbrooks/tars#425",
				expect.objectContaining({
					message: "Removed stopped conflicting worker container yeetomatic-session-mbrooks-tars-425; retrying launch",
				}),
			);
		} finally {
			await harness.close();
		}
	});

	it("does not remove or retry a conflicting container that is still running", async () => {
		const harness = await createHarness(426);
		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			if (args[0] === "inspect") {
				callback(null, "running\n", "");
				return;
			}
			callback(null, "", "");
		});
		spawnMock.mockImplementation(() => makeConflictingChildProcess(426));

		try {
			await expect(harness.executor.execute(makeSessionState(426, harness.workspacePath))).rejects.toThrow(
				'The container name "/yeetomatic-session-mbrooks-tars-426" is already in use',
			);
			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(execFileMock).not.toHaveBeenCalledWith(
				"docker",
				["rm", "yeetomatic-session-mbrooks-tars-426"],
				expect.any(Object),
				expect.any(Function),
			);
		} finally {
			await harness.close();
		}
	});

	it("does not retry when the conflicting container cannot be inspected", async () => {
		const harness = await createHarness(428);
		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			if (args[0] === "inspect") {
				callback(new Error("inspect failed"), "", "");
				return;
			}
			callback(null, "", "");
		});
		spawnMock.mockImplementation(() => makeConflictingChildProcess(428));

		try {
			await expect(harness.executor.execute(makeSessionState(428, harness.workspacePath))).rejects.toThrow(
				'The container name "/yeetomatic-session-mbrooks-tars-428" is already in use',
			);
			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"mbrooks/tars#428",
				expect.objectContaining({
					message: "Could not inspect conflicting worker container yeetomatic-session-mbrooks-tars-428",
				}),
			);
		} finally {
			await harness.close();
		}
	});

	it("does not retry when the stopped conflicting container cannot be removed", async () => {
		const harness = await createHarness(429);
		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			if (args[0] === "inspect") {
				callback(null, "exited\n", "");
				return;
			}
			if (args[0] === "rm") {
				callback(new Error("remove failed"), "", "");
				return;
			}
			callback(null, "", "");
		});
		spawnMock.mockImplementation(() => makeConflictingChildProcess(429));

		try {
			await expect(harness.executor.execute(makeSessionState(429, harness.workspacePath))).rejects.toThrow(
				'The container name "/yeetomatic-session-mbrooks-tars-429" is already in use',
			);
			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"mbrooks/tars#429",
				expect.objectContaining({
					message: "Could not remove stopped conflicting worker container yeetomatic-session-mbrooks-tars-429",
				}),
			);
		} finally {
			await harness.close();
		}
	});

	it("stops retrying after three recovered name-conflict retries", async () => {
		const harness = await createHarness(427);
		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			if (args[0] === "inspect") {
				callback(null, "exited\n", "");
				return;
			}
			callback(null, "", "");
		});
		spawnMock.mockImplementation(() => makeConflictingChildProcess(427));

		try {
			await expect(harness.executor.execute(makeSessionState(427, harness.workspacePath))).rejects.toThrow(
				"Worker container launch failed after 4 attempts (3 retries).",
			);
			expect(spawnMock).toHaveBeenCalledTimes(4);
			expect(
				execFileMock.mock.calls.filter((call) => call[1][0] === "rm"),
			).toHaveLength(3);
		} finally {
			await harness.close();
		}
	});

	it("refuses to launch when the worktree origin URL contains credentials", async () => {
		const harness = await createHarness(430);
		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				callback(null, "https://x-access-token:ghp_secret@github.com/mbrooks/tars.git\n", "");
				return;
			}
			callback(null, currentWorkerTransport, "");
			return;
		});

		spawnMock.mockImplementation(() => makeChildProcess());

		try {
			await expect(harness.executor.execute(makeSessionState(430, harness.workspacePath))).rejects.toThrow(
				/remote origin URL contains credentials/,
			);
			expect(spawnMock).not.toHaveBeenCalled();
			expect(execFileMock).toHaveBeenCalledWith("git", ["remote", "get-url", "origin"], expect.any(Object), expect.any(Function));
		} finally {
			await harness.close();
		}
	});

	it("launches after verifying the worktree origin URL is token-free", async () => {
		const harness = await createHarness(431);
		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				callback(null, "https://github.com/mbrooks/tars.git\n", "");
				return;
			}
			callback(null, currentWorkerTransport, "");
			return;
		});

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YEETOMATIC_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("ack", "mbrooks/tars#431", "ack-safe", { ackMessageId: message.messageId }),
					);
					await connection.send(
						createWorkerMessage("complete", "mbrooks/tars#431", "complete-safe", {
							result: { status: "complete", summary: "done", rawResponse: "YEETOMATIC_STATUS: complete\ndone" },
						}),
					);
				},
			);
				return child;
		});

		try {
			const result = await harness.executor.execute(makeSessionState(431, harness.workspacePath));
			expect(result.status).toBe("complete");
			expect(execFileMock).toHaveBeenCalledWith("git", ["remote", "get-url", "origin"], expect.any(Object), expect.any(Function));
		} finally {
			await harness.close();
		}
	});
});

async function createHarness(issueNumber: number): Promise<{
	executor: DockerWorkerExecutor;
	projectRoot: string;
	workspacePath: string;
	workerRpcServer: FakeWorkerRpcServer;
	close: () => Promise<void>;
}> {
	const workspacesRoot = await mkdtemp(path.join(os.tmpdir(), `yeetomatic-docker-worker-${issueNumber}-`));
	const workspacePath = path.join(workspacesRoot, "mbrooks-tars", ".worktrees", `issue-${issueNumber}`);
	await mkdir(workspacePath, { recursive: true });

	const workerRpcServer = createFakeWorkerRpcServer();
	const projectRoot = issueNumber === 419 ? "/repo" : workspacesRoot;
	const executor = new DockerWorkerExecutor({
		projectRoot,
		workspacesDir: workspacesRoot,
		workerImage: "yeetomatic-worker:latest",
		workerWorkspaceMountSource: workspacesRoot,
		workerControlBaseUrl: "http://control-plane.test",
		workerDockerNetworkMode: undefined,
		workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
		soulPath: "/app/SOUL.md",
	});

	return {
		executor,
		projectRoot,
		workspacePath,
		workerRpcServer,
		close: async () => {
			await workerRpcServer.close();
			await rm(workspacesRoot, { recursive: true, force: true });
		},
	};
}

function makeChildProcess(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
	const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	return child;
}

function makeConflictingChildProcess(issueNumber: number): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
	const child = makeChildProcess();
	queueMicrotask(() => {
		child.stderr.emit(
			"data",
			Buffer.from(
				`docker: Error response from daemon: Conflict. The container name "/yeetomatic-session-mbrooks-tars-${issueNumber}" is already in use by container "existing".`,
			),
		);
		child.emit("exit", 125, null);
	});
	return child;
}

function makeSessionState(issueNumber: number, workspacePath: string) {
	return {
		issueNumber,
		repo: "tars",
		owner: "mbrooks",
		title: "Recover a conflicting worker container",
		body: "Body",
		status: "pending" as const,
		sessionPath: "/tmp/session.jsonl",
		workspacePath,
		lastActivity: new Date().toISOString(),
		seeded: false,
	};
}

async function connectMockWorker(
	workerRpcServer: FakeWorkerRpcServer,
	url: string,
	onMessage: (connection: FakeWorkerRpcConnection, message: AnyWorkerProtocolMessage) => Promise<void>,
): Promise<void> {
	const connection = await connectWorkerSession(workerRpcServer, url);
	connection.onMessage((message) => {
		void onMessage(connection, message);
	});

	await connection.send(
		createWorkerMessage("hello", new URL(url).searchParams.get("sessionKey") ?? "", "hello-1", {
			workerVersion: "test",
			pid: 123,
		}),
	);
}

async function connectWorkerSession(
	workerRpcServer: FakeWorkerRpcServer,
	url: string,
): Promise<FakeWorkerRpcConnection> {
	const parsedUrl = new URL(url);
	const token = parsedUrl.searchParams.get("token");
	const sessionKey = decodeURIComponent(parsedUrl.searchParams.get("sessionKey") ?? "");
	if (!token) {
		throw new Error("Missing worker RPC token");
	}

	return workerRpcServer.connectPending(token, sessionKey);
}

class FakeWorkerRpcConnection implements WorkerRpcConnection {
	private readonly messageListeners = new Set<(message: AnyWorkerProtocolMessage) => void>();
	private readonly closeListeners = new Set<() => void>();
	private readonly errorListeners = new Set<(error: Error) => void>();
	private readonly bufferedMessages: AnyWorkerProtocolMessage[] = [];
	private open = true;
	peer?: FakeWorkerRpcConnection;

	send(message: WorkerProtocolMessage): Promise<void> {
		return Promise.resolve().then(() => {
			if (!this.open || !this.peer?.open) {
				throw new Error("Worker RPC connection is not connected");
			}
			if (this.peer.messageListeners.size === 0) {
				this.peer.bufferedMessages.push(message as AnyWorkerProtocolMessage);
				return;
			}
			for (const listener of this.peer.messageListeners) {
				listener(message as AnyWorkerProtocolMessage);
			}
		});
	}

	onMessage(listener: (message: AnyWorkerProtocolMessage) => void): () => void {
		this.messageListeners.add(listener);
		for (const message of this.bufferedMessages.splice(0)) {
			listener(message);
		}
		return () => {
			this.messageListeners.delete(listener);
		};
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => {
			this.closeListeners.delete(listener);
		};
	}

	onError(listener: (error: Error) => void): () => void {
		this.errorListeners.add(listener);
		return () => {
			this.errorListeners.delete(listener);
		};
	}

	isOpen(): boolean {
		return this.open;
	}

	close(): void {
		if (!this.open) return;
		this.open = false;
		queueMicrotask(() => {
			for (const listener of this.closeListeners) {
				listener();
			}
			if (this.peer?.open) {
				this.peer.open = false;
				for (const listener of this.peer.closeListeners) {
					listener();
				}
			}
		});
	}

	emitError(error: Error): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}
}

type FakePendingConnection = PendingWorkerRpcConnection & {
	sessionKey: string;
	serverConnection: FakeWorkerRpcConnection;
	workerConnection: FakeWorkerRpcConnection;
	resolveConnection: (connection: WorkerRpcConnection) => void;
	rejectConnection: (error: Error) => void;
	connected: boolean;
};

type FakeWorkerRpcServer = ReturnType<typeof createFakeWorkerRpcServer>;

function createFakeWorkerRpcServer() {
	let tokenCounter = 0;
	const pendingConnections = new Map<string, FakePendingConnection>();
	const activeConnections = new Set<FakeWorkerRpcConnection>();

	return {
		createPendingConnection(sessionKey: string): PendingWorkerRpcConnection {
			const token = `token-${++tokenCounter}`;
			const serverConnection = new FakeWorkerRpcConnection();
			const workerConnection = new FakeWorkerRpcConnection();
			serverConnection.peer = workerConnection;
			workerConnection.peer = serverConnection;

			let resolveConnection!: (connection: WorkerRpcConnection) => void;
			let rejectConnection!: (error: Error) => void;
			const connectionPromise = new Promise<WorkerRpcConnection>((resolve, reject) => {
				resolveConnection = resolve;
				rejectConnection = reject;
			});

			const pending: FakePendingConnection = {
				token,
				sessionKey,
				serverConnection,
				workerConnection,
				resolveConnection,
				rejectConnection,
				connected: false,
				waitForConnection: () => connectionPromise,
				dispose: (error = new Error(`Worker RPC connection was not established for ${sessionKey}`)) => {
					if (!pendingConnections.has(token)) return;
					pendingConnections.delete(token);
					if (!pending.connected) {
						rejectConnection(error);
					}
				},
			};

			pendingConnections.set(token, pending);
			return pending;
		},

		connectPending(token: string, sessionKey: string): FakeWorkerRpcConnection {
			const pending = pendingConnections.get(token);
			if (!pending || pending.sessionKey !== sessionKey) {
				throw new Error(`Unknown pending worker session ${sessionKey}`);
			}
			pendingConnections.delete(token);
			pending.connected = true;
			activeConnections.add(pending.serverConnection);
			activeConnections.add(pending.workerConnection);
			pending.resolveConnection(pending.serverConnection);
			return pending.workerConnection;
		},

		async close(): Promise<void> {
			for (const [token, pending] of pendingConnections) {
				pendingConnections.delete(token);
				if (!pending.connected) {
					pending.rejectConnection(new Error(`Worker RPC server closed before ${pending.sessionKey} connected`));
				}
			}
			for (const connection of activeConnections) {
				connection.close();
			}
			activeConnections.clear();
		},
	};
}
