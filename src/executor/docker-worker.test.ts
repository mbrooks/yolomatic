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
			expect(options.env.TARS_SESSION_KEY).toBe("mbrooks/tars#418");
			expect(options.env.TARS_SESSION_WS_URL).toContain("sessionKey=mbrooks%2Ftars%23418");

			void connectMockWorker(
				harness.workerRpcServer,
				options.env.TARS_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					const launch = message as WorkerProtocolMessage<"launch_config">;
					expect(launch.payload.session.workspacePath).toBe("/workspaces/mbrooks-tars/.worktrees/issue-418");
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
								rawResponse: "TARS_STATUS: complete\ndone",
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
				expect.objectContaining({ message: "Launching worker container tars-session-mbrooks-tars-418" }),
			);
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"mbrooks/tars#418",
				expect.objectContaining({ message: "Prompt sent" }),
			);
		} finally {
			await harness.close();
		}
	});

	it("builds the worker image when it is missing", async () => {
		const harness = await createHarness(419);
		execFileMock
			.mockImplementationOnce((_cmd, _args, _options, callback) => callback(new Error("missing image")))
			.mockImplementationOnce((_cmd, _args, _options, callback) => callback(null, "", ""));

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.TARS_SESSION_WS_URL as string,
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
								rawResponse: "TARS_STATUS: complete\ndone",
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
				2,
				"docker",
				[
					"build",
					"--target",
					"worker",
					"--label",
					"io.tars.worker.transport=websocket-v1",
					"-t",
					"tars-worker:latest",
					"/repo",
				],
				expect.any(Object),
				expect.any(Function),
			);
		} finally {
			await harness.close();
		}
	});

	it("rebuilds the worker image when the transport label is stale", async () => {
		const harness = await createHarness(424);
		execFileMock
			.mockImplementationOnce((_cmd, _args, _options, callback) => callback(null, "socket-v1", ""))
			.mockImplementationOnce((_cmd, _args, _options, callback) => callback(null, "", ""));

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.TARS_SESSION_WS_URL as string,
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
								rawResponse: "TARS_STATUS: complete\ndone",
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
				2,
				"docker",
				[
					"build",
					"--target",
					"worker",
					"--label",
					"io.tars.worker.transport=websocket-v1",
					"-t",
					"tars-worker:latest",
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
			workerImage: "tars-worker:latest",
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
			"wss://control.example.test/tars-worker/ws?sessionKey=mbrooks%2Ftars%231&token=token-1",
		);
		expect(() => (executor as any).resolveWorkerWorkspacePath("/other/place")).toThrow("outside configured WORKSPACES_DIR");
	});

	it("falls back to raw or translated OLLAMA_HOST values", async () => {
		const workerRpcServer = createFakeWorkerRpcServer();
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "tars-worker:latest",
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
			workerImage: "tars-worker:latest",
			workerWorkspaceMountSource: "/workspace-root",
			workerControlBaseUrl: "http://127.0.0.1:6767",
			workerDockerNetworkMode: "container:tars",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			soulPath: "/app/SOUL.md",
		});

		process.env.OLLAMA_HOST = "http://127.0.0.1:11434";

		try {
			expect((executor as any).resolveWorkerOllamaHost()).toBe("http://127.0.0.1:11434/");
			expect((executor as any).buildWorkerSessionUrl("mbrooks/tars#1", "token-1")).toBe(
				"ws://127.0.0.1:6767/tars-worker/ws?sessionKey=mbrooks%2Ftars%231&token=token-1",
			);

			const args = await (executor as any).buildDockerRunArgs("worker-1");
			expect(args).toContain("--network");
			expect(args).toContain("container:tars");
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
			workerImage: "tars-worker:latest",
			workerWorkspaceMountSource: "tars_workspaces",
			workerControlBaseUrl: "http://127.0.0.1:6767",
			workerDockerNetworkMode: "container:tars",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			soulPath: "/app/SOUL.md",
		});

		const originalHostname = process.env.HOSTNAME;
		process.env.HOSTNAME = "container-123";
		execFileMock.mockImplementation((_cmd, _args, _options, callback) =>
			callback(
				null,
				JSON.stringify([
					{ Destination: "/app/workspaces", Type: "volume", Name: "tars_tars_workspaces" },
				]),
				"",
			),
		);

		try {
			const args = await (executor as any).buildDockerRunArgs("worker-1");
			expect(args).toContain("type=volume,src=tars_tars_workspaces,dst=/workspaces");
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
			workerImage: "tars-worker:latest",
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
				options.env.TARS_SESSION_WS_URL as string,
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
				options.env.TARS_SESSION_WS_URL as string,
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
			void connectWorkerSession(harness.workerRpcServer, options.env.TARS_SESSION_WS_URL as string).then(async (connection) => {
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
			void connectWorkerSession(harness.workerRpcServer, options.env.TARS_SESSION_WS_URL as string).then(async (connection) => {
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
});

async function createHarness(issueNumber: number): Promise<{
	executor: DockerWorkerExecutor;
	projectRoot: string;
	workspacePath: string;
	workerRpcServer: FakeWorkerRpcServer;
	close: () => Promise<void>;
}> {
	const workspacesRoot = await mkdtemp(path.join(os.tmpdir(), `tars-docker-worker-${issueNumber}-`));
	const workspacePath = path.join(workspacesRoot, "mbrooks-tars", ".worktrees", `issue-${issueNumber}`);
	await mkdir(workspacePath, { recursive: true });

	const workerRpcServer = createFakeWorkerRpcServer();
	const projectRoot = issueNumber === 419 ? "/repo" : workspacesRoot;
	const executor = new DockerWorkerExecutor({
		projectRoot,
		workspacesDir: workspacesRoot,
		workerImage: "tars-worker:latest",
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
