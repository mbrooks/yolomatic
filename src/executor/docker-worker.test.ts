import net from "node:net";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerMessageParser, encodeWorkerMessage } from "../worker/framing.js";
import { createWorkerMessage, type WorkerProtocolMessage } from "../worker/protocol.js";

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
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("launches a docker worker, streams logs, and exposes steering", async () => {
		const workspacesRoot = await mkdtemp(path.join(os.tmpdir(), "tars-docker-worker-ws-"));
		const workspacePath = path.join(workspacesRoot, "mbrooks-tars", ".worktrees", "issue-418");
		const runtimeDir = path.join("/tmp", `trt-${Date.now()}-418`);
		await mkdir(workspacePath, { recursive: true });

		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));

		spawnMock.mockImplementation((_cmd, args, options) => {
			const child = new EventEmitter() as EventEmitter & {
				stdout: EventEmitter;
				stderr: EventEmitter;
			};
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();

			expect(args).toContain("run");
			expect(args).toContain("--mount");
			expect(args).not.toContain("GITHUB_TOKEN");
			expect(options.env.TARS_SESSION_KEY).toBe("mbrooks/tars#418");

			setImmediate(() => {
				const parser = new WorkerMessageParser();
				const client = net.createConnection(path.join(runtimeDir, "github-mbrooks-tars-issue-418", "session.sock"));
				client.on("data", (chunk) => {
					for (const message of parser.push(chunk)) {
						if (message.type === "launch_config") {
							const launch = message as WorkerProtocolMessage<"launch_config">;
							expect(launch.payload.session.workspacePath).toBe("/workspaces/mbrooks-tars/.worktrees/issue-418");
							client.write(
								encodeWorkerMessage(
									createWorkerMessage("ack", "mbrooks/tars#418", "ack-1", {
										ackMessageId: launch.messageId,
									}),
								),
							);
							client.write(
								encodeWorkerMessage(
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
								),
							);
							client.write(
								encodeWorkerMessage(
									createWorkerMessage("complete", "mbrooks/tars#418", "complete-1", {
										result: {
											status: "complete",
											summary: "done",
											rawResponse: "TARS_STATUS: complete\ndone",
										},
									}),
								),
							);
						}
					}
				});
				client.on("connect", () => {
					client.write(
						encodeWorkerMessage(
							createWorkerMessage("hello", "mbrooks/tars#418", "hello-1", {
								workerVersion: "test",
								pid: 123,
							}),
						),
					);
				});
			});

			return child;
		});

		const executor = new DockerWorkerExecutor({
			projectRoot: workspacesRoot,
			workspacesDir: workspacesRoot,
			workerImage: "tars-worker:latest",
			workerRuntimeDir: runtimeDir,
			workerWorkspaceMountSource: "tars_workspaces",
			workerRuntimeMountSource: runtimeDir,
			soulPath: "/app/SOUL.md",
		});

		try {
			const result = await executor.execute({
				issueNumber: 418,
				repo: "tars",
				owner: "mbrooks",
				title: "Implement dockerized worker runtime",
				body: "Body",
				status: "pending",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: workspacePath,
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
			await rm(workspacesRoot, { recursive: true, force: true });
			await rm(runtimeDir, { recursive: true, force: true });
		}
	});

	it("builds the worker image when it is missing", async () => {
		const workspacesRoot = await mkdtemp(path.join(os.tmpdir(), "tars-docker-worker-build-"));
		const workspacePath = path.join(workspacesRoot, "mbrooks-tars", ".worktrees", "issue-419");
		const runtimeDir = path.join("/tmp", `trt-${Date.now()}-419`);
		await mkdir(workspacePath, { recursive: true });

		execFileMock
			.mockImplementationOnce((_cmd, _args, _options, callback) => callback(new Error("missing image")))
			.mockImplementationOnce((_cmd, _args, _options, callback) => callback(null, "", ""));

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();

			setImmediate(() => {
				const parser = new WorkerMessageParser();
				const client = net.createConnection(path.join(runtimeDir, "github-mbrooks-tars-issue-419", "session.sock"));
				client.on("data", (chunk) => {
					for (const message of parser.push(chunk)) {
						if (message.type === "launch_config") {
							const launch = message as WorkerProtocolMessage<"launch_config">;
							client.write(
								encodeWorkerMessage(
									createWorkerMessage("ack", "mbrooks/tars#419", "ack-build", {
										ackMessageId: launch.messageId,
									}),
								),
							);
							client.write(
								encodeWorkerMessage(
									createWorkerMessage("complete", "mbrooks/tars#419", "complete-build", {
										result: {
											status: "complete",
											summary: "done",
											rawResponse: "TARS_STATUS: complete\ndone",
										},
									}),
								),
							);
						}
					}
				});
				client.on("connect", () => {
					client.write(
						encodeWorkerMessage(
							createWorkerMessage("hello", "mbrooks/tars#419", "hello-build", {
								workerVersion: "test",
								pid: 456,
							}),
						),
					);
				});
			});

			return child;
		});

		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: workspacesRoot,
			workerImage: "tars-worker:latest",
			workerRuntimeDir: runtimeDir,
			workerWorkspaceMountSource: workspacesRoot,
			workerRuntimeMountSource: runtimeDir,
			soulPath: "/app/SOUL.md",
		});

		try {
			await executor.execute({
				issueNumber: 419,
				repo: "tars",
				owner: "mbrooks",
				title: "Build image when missing",
				body: "Body",
				status: "pending",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: workspacePath,
				lastActivity: new Date().toISOString(),
				seeded: false,
			});

			expect(execFileMock).toHaveBeenNthCalledWith(
				2,
				"docker",
				["build", "--target", "worker", "-t", "tars-worker:latest", "/repo"],
				expect.any(Object),
				expect.any(Function),
			);
		} finally {
			await rm(workspacesRoot, { recursive: true, force: true });
			await rm(runtimeDir, { recursive: true, force: true });
		}
	});

	it("normalizes helper values and rejects workspaces outside the mount root", () => {
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "tars-worker:latest",
			workerRuntimeDir: "/tmp/runtime",
			workerWorkspaceMountSource: "named-volume",
			workerRuntimeMountSource: "/tmp/runtime",
			workerOllamaHost: "http://custom-host:11434",
			soulPath: "/app/SOUL.md",
		});

		expect((executor as any).buildMountSpec("named-volume", "/workspaces")).toContain("type=volume");
		expect((executor as any).buildMountSpec("/tmp/runtime", "/tars-runtime")).toContain("type=bind");
		expect((executor as any).resolveWorkerOllamaHost()).toBe("http://custom-host:11434");
		expect((executor as any).appendOutput("a".repeat(3990), "b".repeat(50))).toHaveLength(4000);
		expect(() => (executor as any).resolveWorkerWorkspacePath("/other/place")).toThrow("outside configured WORKSPACES_DIR");
	});

	it("falls back to raw or missing OLLAMA_HOST values", () => {
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "tars-worker:latest",
			workerRuntimeDir: "/tmp/runtime",
			workerWorkspaceMountSource: "named-volume",
			workerRuntimeMountSource: "/tmp/runtime",
			soulPath: "/app/SOUL.md",
		});

		delete process.env.OLLAMA_HOST;
		expect((executor as any).resolveWorkerOllamaHost()).toBeUndefined();

		process.env.OLLAMA_HOST = "not-a-url";
		expect((executor as any).resolveWorkerOllamaHost()).toBe("not-a-url");
		delete process.env.OLLAMA_HOST;
	});

	it("includes optional provider and model env when building docker args", () => {
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "tars-worker:latest",
			workerRuntimeDir: "/tmp/runtime",
			workerWorkspaceMountSource: "named-volume",
			workerRuntimeMountSource: "/tmp/runtime",
			soulPath: "/app/SOUL.md",
		});

		process.env.PI_AGENT_PROVIDER = " openai ";
		process.env.PI_AGENT_MODEL = " gpt-5 ";

		try {
			expect((executor as any).buildDockerRunArgs("worker-1")).toEqual(
				expect.arrayContaining(["-e", "PI_AGENT_PROVIDER=openai", "-e", "PI_AGENT_MODEL=gpt-5"]),
			);
		} finally {
			delete process.env.PI_AGENT_PROVIDER;
			delete process.env.PI_AGENT_MODEL;
		}
	});

	it("translates localhost OLLAMA_HOST, supports comment prompts, and propagates worker errors", async () => {
		const workspacesRoot = await mkdtemp(path.join(os.tmpdir(), "tars-docker-worker-comment-"));
		const workspacePath = path.join(workspacesRoot, "mbrooks-tars", ".worktrees", "issue-420");
		const runtimeDir = path.join("/tmp", `trt-${Date.now()}-420`);
		await mkdir(workspacePath, { recursive: true });
		process.env.OLLAMA_HOST = "http://127.0.0.1:11434";
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));

		spawnMock.mockImplementation((_cmd, args, options) => {
			const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();

			expect(args).toContain("-e");
			expect(args).toContain("OLLAMA_HOST=http://host.docker.internal:11434/");

			setImmediate(() => {
				const parser = new WorkerMessageParser();
				const client = net.createConnection(path.join(runtimeDir, "github-mbrooks-tars-issue-420", "session.sock"));
				client.on("data", (chunk) => {
					for (const message of parser.push(chunk)) {
						if (message.type !== "launch_config") continue;
						const launch = message as WorkerProtocolMessage<"launch_config">;
						expect(launch.payload.prompt.kind).toBe("comment");
						client.write(
							encodeWorkerMessage(
								createWorkerMessage("error", "mbrooks/tars#420", "error-1", {
									message: "worker blew up",
								}),
							),
						);
					}
				});
				client.on("connect", () => {
					client.write(
						encodeWorkerMessage(
							createWorkerMessage("hello", "mbrooks/tars#420", "hello-comment", {
								workerVersion: "test",
								pid: 88,
							}),
						),
					);
				});
			});

			return child;
		});

		const executor = new DockerWorkerExecutor({
			projectRoot: workspacesRoot,
			workspacesDir: workspacesRoot,
			workerImage: "tars-worker:latest",
			workerRuntimeDir: runtimeDir,
			workerWorkspaceMountSource: workspacesRoot,
			workerRuntimeMountSource: runtimeDir,
			soulPath: "/app/SOUL.md",
		});

		try {
			await expect(
				executor.execute({
					issueNumber: 420,
					repo: "tars",
					owner: "mbrooks",
					title: "Feedback task",
					body: "Body",
					status: "pending",
					sessionPath: "/tmp/session.jsonl",
					workspacePath: workspacePath,
					lastActivity: new Date().toISOString(),
					seeded: false,
				}, "Please retry."),
			).rejects.toThrow("worker blew up");
			expect((executor as any).resolveWorkerOllamaHost()).toBe("http://host.docker.internal:11434/");
		} finally {
			delete process.env.OLLAMA_HOST;
			await rm(workspacesRoot, { recursive: true, force: true });
			await rm(runtimeDir, { recursive: true, force: true });
		}
	});

	it("sends stop control when aborted", async () => {
		const workspacesRoot = await mkdtemp(path.join(os.tmpdir(), "tars-docker-worker-stop-"));
		const workspacePath = path.join(workspacesRoot, "mbrooks-tars", ".worktrees", "issue-421");
		const runtimeDir = path.join("/tmp", `trt-${Date.now()}-421`);
		await mkdir(workspacePath, { recursive: true });
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));

		let sawStop = false;
		spawnMock.mockImplementation((_cmd, _args, _options) => {
			const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();

			setImmediate(() => {
				const parser = new WorkerMessageParser();
				const client = net.createConnection(path.join(runtimeDir, "github-mbrooks-tars-issue-421", "session.sock"));
				client.on("data", (chunk) => {
					for (const message of parser.push(chunk)) {
						if (message.type === "launch_config") {
							const launch = message as WorkerProtocolMessage<"launch_config">;
							client.write(
								encodeWorkerMessage(
									createWorkerMessage("ack", "mbrooks/tars#421", "ack-stop-launch", {
										ackMessageId: launch.messageId,
									}),
								),
							);
						}
						if (message.type === "control") {
							const control = message as WorkerProtocolMessage<"control">;
							sawStop = control.payload.action === "stop";
							client.write(
								encodeWorkerMessage(
									createWorkerMessage("ack", "mbrooks/tars#421", "ack-stop", {
										ackMessageId: control.messageId,
									}),
								),
							);
							client.write(
								encodeWorkerMessage(
									createWorkerMessage("complete", "mbrooks/tars#421", "complete-stop", {
										result: {
											status: "cancelled",
											summary: "stopped",
											rawResponse: "",
										},
									}),
								),
							);
						}
					}
				});
				client.on("connect", () => {
					client.write(
						encodeWorkerMessage(
							createWorkerMessage("hello", "mbrooks/tars#421", "hello-stop", {
								workerVersion: "test",
								pid: 99,
							}),
						),
					);
				});
			});

			return child;
		});

		const executor = new DockerWorkerExecutor({
			projectRoot: workspacesRoot,
			workspacesDir: workspacesRoot,
			workerImage: "tars-worker:latest",
			workerRuntimeDir: runtimeDir,
			workerWorkspaceMountSource: workspacesRoot,
			workerRuntimeMountSource: runtimeDir,
			soulPath: "/app/SOUL.md",
		});
		const abortController = new AbortController();

		try {
			const run = executor.execute({
				issueNumber: 421,
				repo: "tars",
				owner: "mbrooks",
				title: "Abort task",
				body: "Body",
				status: "pending",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: workspacePath,
				lastActivity: new Date().toISOString(),
				seeded: false,
			}, undefined, abortController.signal);
			setTimeout(() => abortController.abort(), 20);
			const result = await run;
			expect(result.status).toBe("cancelled");
			expect(sawStop).toBe(true);
		} finally {
			await rm(workspacesRoot, { recursive: true, force: true });
			await rm(runtimeDir, { recursive: true, force: true });
		}
	});

	it("rejects workers with bad protocol metadata", async () => {
		const workspacesRoot = await mkdtemp(path.join(os.tmpdir(), "tars-docker-worker-bad-"));
		const workspacePath = path.join(workspacesRoot, "mbrooks-tars", ".worktrees", "issue-422");
		const runtimeDir = path.join("/tmp", `trt-${Date.now()}-422`);
		await mkdir(workspacePath, { recursive: true });
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));

		spawnMock.mockImplementation((_cmd, _args, _options) => {
			const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();

			setImmediate(() => {
				const client = net.createConnection(path.join(runtimeDir, "github-mbrooks-tars-issue-422", "session.sock"));
				client.on("connect", () => {
					client.write(
						encodeWorkerMessage({
							type: "hello",
							protocolVersion: 99,
							sessionKey: "wrong/session#1",
							messageId: "bad-hello",
							payload: { workerVersion: "test", pid: 1 },
						} as WorkerProtocolMessage<"hello">),
					);
				});
			});

			return child;
		});

		const executor = new DockerWorkerExecutor({
			projectRoot: workspacesRoot,
			workspacesDir: workspacesRoot,
			workerImage: "tars-worker:latest",
			workerRuntimeDir: runtimeDir,
			workerWorkspaceMountSource: workspacesRoot,
			workerRuntimeMountSource: runtimeDir,
			soulPath: "/app/SOUL.md",
		});

		try {
			await expect(
				executor.execute({
					issueNumber: 422,
					repo: "tars",
					owner: "mbrooks",
					title: "Bad worker",
					body: "Body",
					status: "pending",
					sessionPath: "/tmp/session.jsonl",
					workspacePath: workspacePath,
					lastActivity: new Date().toISOString(),
					seeded: false,
				}),
			).rejects.toThrow(/Unsupported worker protocol version|unexpected session key/);
		} finally {
			await rm(workspacesRoot, { recursive: true, force: true });
			await rm(runtimeDir, { recursive: true, force: true });
		}
	});
});
