import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkerMessage, type AnyWorkerProtocolMessage, type WorkerProtocolMessage } from "../worker/protocol.js";
import type { PendingWorkerRpcConnection, WorkerRpcConnection, WorkerRpcServer } from "../worker/rpc-server.js";
import { WorkerGitHubGateway, type GatewayToolResponse, type WorkerWorkspaceGateway } from "../worker/github-gateway.js";
import type { GitHubGatewayService } from "../ports/github-gateway-service.js";

function makeFakeWorkspace(): WorkerWorkspaceGateway {
	return {
		updateDefaultBranchFromOrigin: vi.fn(async () => ({
			branch: "main",
			before: "old".repeat(10),
			after: "new".repeat(10),
			updated: true,
		})),
	};
}

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

import { DockerWorkerExecutor, type DockerWorkerExecutorOptions } from "./docker-worker.js";

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
			expect(options.env.YOLO_SESSION_KEY).toBe("github-mbrooks-yolomatic-issue-418-implementation");
			expect(options.env.YOLO_SESSION_WS_URL).toContain("sessionKey=github-mbrooks-yolomatic-issue-418-implementation");

			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					const launch = message as WorkerProtocolMessage<"launch_config">;
					expect(launch.payload.session.workspacePath).toBe(harness.workspacePath);
					await connection.send(
						createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-418-implementation", "ack-1", {
							ackMessageId: launch.messageId,
						}),
					);
					await connection.send(
						createWorkerMessage("event_batch", "github-mbrooks-yolomatic-issue-418-implementation", "events-1", {
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
						createWorkerMessage("complete", "github-mbrooks-yolomatic-issue-418-implementation", "complete-1", {
							result: {
								status: "complete",
								summary: "done",
								rawResponse: "YOLO_STATUS: complete\ndone",
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
				repo: "yolomatic",
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
				"github-mbrooks-yolomatic-issue-418-implementation",
				expect.objectContaining({ message: "Launching worker container yolomatic-session-mbrooks-yolomatic-418" }),
			);
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"github-mbrooks-yolomatic-issue-418-implementation",
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
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-419-implementation", "ack-build", {
							ackMessageId: message.messageId,
						}),
					);
					await connection.send(
						createWorkerMessage("complete", "github-mbrooks-yolomatic-issue-419-implementation", "complete-build", {
							result: {
								status: "complete",
								summary: "done",
								rawResponse: "YOLO_STATUS: complete\ndone",
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
				repo: "yolomatic",
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
					"io.yolomatic.worker.transport=websocket-v1",
					"-t",
					"yolomatic-worker:latest",
					"/repo",
				],
				expect.any(Object),
				expect.any(Function),
			);
		} finally {
			await harness.close();
		}
	});

	it("builds the worker-only base and selected project template, then launches its image", async () => {
		const harness = await createHarness(420, {
			workerImage: undefined,
			defaultWorkerTemplate: "node",
			resolveWorkerTemplate: () => "python",
		});
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));

		try {
			const launcher = (harness.executor as any).launcher;
			const template = launcher.resolveTemplate("mbrooks", "yolomatic");
			expect(template).toMatchObject({ id: "python", image: "yolomatic-worker-python:latest" });
			await launcher.ensureWorkerImage(template, "test-session");

			expect(execFileMock).toHaveBeenNthCalledWith(
				1,
				"docker",
				["build", "--label", "io.yolomatic.worker.transport=websocket-v1", "-t", "yolomatic-worker-base:latest", "-f", `${harness.projectRoot}/workers/base-runtime.Dockerfile`, harness.projectRoot],
				expect.any(Object),
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenNthCalledWith(
				2,
				"docker",
				["build", "--label", "io.yolomatic.worker.transport=websocket-v1", "-t", "yolomatic-worker-python:latest", "-f", `${harness.projectRoot}/workers/python.Dockerfile`, harness.projectRoot],
				expect.any(Object),
				expect.any(Function),
			);
			const args = await launcher.buildDockerRunArgs("worker-python", template);
			expect(args.at(-1)).toBe("yolomatic-worker-python:latest");
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
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-424-implementation", "ack-rebuild", {
							ackMessageId: message.messageId,
						}),
					);
					await connection.send(
						createWorkerMessage("complete", "github-mbrooks-yolomatic-issue-424-implementation", "complete-rebuild", {
							result: {
								status: "complete",
								summary: "done",
								rawResponse: "YOLO_STATUS: complete\ndone",
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
				repo: "yolomatic",
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
					"io.yolomatic.worker.transport=websocket-v1",
					"-t",
					"yolomatic-worker:latest",
					harness.projectRoot,
				],
				expect.any(Object),
				expect.any(Function),
			);
		} finally {
			await harness.close();
		}
	});

	it("reports a worker exit when Docker provides only a signal", async () => {
		const harness = await createHarness(479);
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));
		spawnMock.mockImplementation(() => {
			const child = makeChildProcess();
			queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
			return child;
		});

		try {
			await expect(harness.executor.execute(makeSessionState(479, harness.workspacePath))).rejects.toThrow(
				"Worker container exited before completion (code=null, signal=SIGTERM).",
			);
		} finally {
			await harness.close();
		}
	});

	it("normalizes a non-Error Docker spawn rejection", async () => {
		const harness = await createHarness(478);
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));
		spawnMock.mockImplementation(() => {
			const child = makeChildProcess();
			queueMicrotask(() => child.emit("error", "docker unavailable"));
			return child;
		});

		try {
			await expect(harness.executor.execute(makeSessionState(478, harness.workspacePath))).rejects.toThrow(
				"docker unavailable",
			);
		} finally {
			await harness.close();
		}
	});

	it("logs an info-level build notice before the first image build", async () => {
		const harness = await createHarness(480);
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-480-implementation", "ack-build", {
							ackMessageId: message.messageId,
						}),
					);
					await connection.send(
						createWorkerMessage("complete", "github-mbrooks-yolomatic-issue-480-implementation", "complete-build", {
							result: {
								status: "complete",
								summary: "done",
								rawResponse: "YOLO_STATUS: complete\ndone",
							},
						}),
					);
				},
			);
			return child;
		});

		try {
			await harness.executor.execute(makeSessionState(480, harness.workspacePath));

			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"github-mbrooks-yolomatic-issue-480-implementation",
				expect.objectContaining({
					level: "info",
					message: "Building worker container image; this may take a couple of minutes.",
					details: { type: "worker_image_build", image: "yolomatic-worker:latest", template: "legacy" },
				}),
			);
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"github-mbrooks-yolomatic-issue-480-implementation",
				expect.objectContaining({
					message: "Launching worker container yolomatic-session-mbrooks-yolomatic-480",
				}),
			);
			const buildNoticeIndex = recordSessionLogMock.mock.calls.findIndex(
				(call) => call[1].message === "Building worker container image; this may take a couple of minutes.",
			);
			const launchIndex = recordSessionLogMock.mock.calls.findIndex(
				(call) =>
					call[1].message ===
					"Launching worker container yolomatic-session-mbrooks-yolomatic-480",
			);
			expect(buildNoticeIndex).toBeGreaterThanOrEqual(0);
			expect(buildNoticeIndex).toBeLessThan(launchIndex);
		} finally {
			await harness.close();
		}
	});

	it("does not log the build notice on subsequent launches using the cached image", async () => {
		const harness = await createHarness(481);
		const secondWorkspacePath = path.join(harness.projectRoot, "second-workspace");
		await mkdir(secondWorkspacePath, { recursive: true });
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			const sessionKey = new URL(options.env.YOLO_SESSION_WS_URL as string).searchParams.get("sessionKey") ?? "";
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("ack", sessionKey, "ack-second", {
							ackMessageId: message.messageId,
						}),
					);
					await connection.send(
						createWorkerMessage("complete", sessionKey, "complete-second", {
							result: {
								status: "complete",
								summary: "done",
								rawResponse: "YOLO_STATUS: complete\ndone",
							},
						}),
					);
				},
			);
			return child;
		});

		try {
			await harness.executor.execute(makeSessionState(481, harness.workspacePath));
			recordSessionLogMock.mockClear();
			execFileMock.mockClear();

			await harness.executor.execute({ ...makeSessionState(482, secondWorkspacePath), issueNumber: 482 });

			expect(
				recordSessionLogMock.mock.calls.filter(
					(call) => call[1].message === "Building worker container image; this may take a couple of minutes.",
				),
			).toHaveLength(0);
			expect(
				execFileMock.mock.calls.filter((call) => call[0] === "docker" && call[1][0] === "build"),
			).toHaveLength(0);
		} finally {
			await rm(secondWorkspacePath, { recursive: true, force: true });
			await harness.close();
		}
	});

	it("logs the build notice under the refinement session key for the first refinement worker", async () => {
		const harness = await createHarness(483);
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-483-refinement", "ack-refine-build", {
							ackMessageId: message.messageId,
						}),
					);
					await connection.send(
						createWorkerMessage("complete", "github-mbrooks-yolomatic-issue-483-refinement", "complete-refine-build", {
							result: {
								proposedTaskBody: "## Summary\nRefined.",
								summary: "Better description.",
								investigation: "Read the code.",
							},
						}),
					);
				},
			);
			return child;
		});

		try {
			await harness.executor.executeRefinement(makeSessionState(483, harness.workspacePath), undefined);
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"github-mbrooks-yolomatic-issue-483-refinement",
				expect.objectContaining({
					level: "info",
					message: "Building worker container image; this may take a couple of minutes.",
					details: { type: "worker_image_build", image: "yolomatic-worker:latest", template: "legacy" },
				}),
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
			workerImage: "yolomatic-worker:latest",
			workerWorkspaceMountSource: "named-volume",
			workerControlBaseUrl: "https://control.example.test/base",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			workerOllamaHost: "http://custom-host:11434",
			soulPath: "/app/SOUL.md",
		});

		const launcher = (executor as any).launcher;
		const supervisor = (executor as any).supervisor;

		expect(launcher.buildMountSpec("named-volume", "/workspaces")).toContain("type=volume");
		expect(launcher.resolveWorkerOllamaHost()).toBe("http://custom-host:11434");
		expect(launcher.appendOutput("a".repeat(3990), "b".repeat(50))).toHaveLength(4000);
		expect(supervisor.buildWorkerSessionUrl("github-mbrooks-yolomatic-issue-1-implementation", "token-1")).toBe(
			"wss://control.example.test/yolomatic-worker/ws?sessionKey=github-mbrooks-yolomatic-issue-1-implementation&token=token-1",
		);
		expect(() => launcher.resolveWorkerWorkspacePath("/other/place")).toThrow("outside configured WORKSPACES_DIR");
	});

	it("falls back to raw or translated OLLAMA_HOST values", async () => {
		const workerRpcServer = createFakeWorkerRpcServer();
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "yolomatic-worker:latest",
			workerWorkspaceMountSource: "named-volume",
			workerControlBaseUrl: "http://host.docker.internal:6767",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			soulPath: "/app/SOUL.md",
		});

		const launcher = (executor as any).launcher;

		delete process.env.OLLAMA_HOST;
		expect(launcher.resolveWorkerOllamaHost()).toBeUndefined();

		process.env.OLLAMA_HOST = "not-a-url";
		expect(launcher.resolveWorkerOllamaHost()).toBe("not-a-url");

		process.env.OLLAMA_HOST = "http://127.0.0.1:11434";
		expect(launcher.resolveWorkerOllamaHost()).toBe("http://host.docker.internal:11434/");

		delete process.env.OLLAMA_HOST;
	});

	it("uses shared container networking without rewriting loopback hosts", async () => {
		const workerRpcServer = createFakeWorkerRpcServer();
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "yolomatic-worker:latest",
			workerWorkspaceMountSource: "/workspace-root",
			workerControlBaseUrl: "http://127.0.0.1:6767",
			workerDockerNetworkMode: "container:yolomatic",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			soulPath: "/app/SOUL.md",
		});

		process.env.OLLAMA_HOST = "http://127.0.0.1:11434";

		try {
			const launcher = (executor as any).launcher;
			const supervisor = (executor as any).supervisor;

			expect(launcher.resolveWorkerOllamaHost()).toBe("http://127.0.0.1:11434/");
			expect(supervisor.buildWorkerSessionUrl("github-mbrooks-yolomatic-issue-1-implementation", "token-1")).toBe(
				"ws://127.0.0.1:6767/yolomatic-worker/ws?sessionKey=github-mbrooks-yolomatic-issue-1-implementation&token=token-1",
			);

			const args = await launcher.buildDockerRunArgs("worker-1", launcher.resolveTemplate());
			expect(args).toContain("--network");
			expect(args).toContain("container:yolomatic");
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
			workerImage: "yolomatic-worker:latest",
			workerWorkspaceMountSource: "yolomatic_workspaces",
			workerControlBaseUrl: "http://127.0.0.1:6767",
			workerDockerNetworkMode: "container:yolomatic",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			soulPath: "/app/SOUL.md",
		});

		const originalHostname = process.env.HOSTNAME;
		process.env.HOSTNAME = "container-123";
		execFileMock.mockImplementation((_cmd, _args, _options, callback) =>
			callback(
				null,
				JSON.stringify([
					{ Destination: "/app/workspaces", Type: "volume", Name: "yolomatic_yolomatic_workspaces" },
				]),
				"",
			),
		);

		try {
			const launcher = (executor as any).launcher;
			const args = await launcher.buildDockerRunArgs("worker-1", launcher.resolveTemplate());
			expect(args).toContain("type=volume,src=yolomatic_yolomatic_workspaces,dst=/app/workspaces");
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

	it("includes model env vars in docker args from injected runtime settings", async () => {
		const workerRpcServer = createFakeWorkerRpcServer();
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "yolomatic-worker:latest",
			workerWorkspaceMountSource: "/workspace-root",
			workerControlBaseUrl: "http://control-plane.test",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			runtimeSettings: () => ({
				model: { piAgentProvider: "ollama", piAgentModel: "glm-test" },
				logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true },
			}),
			soulPath: "/app/SOUL.md",
		});

		const launcher = (executor as any).launcher;
		const args = await launcher.buildDockerRunArgs("worker-1", launcher.resolveTemplate());
		expect(args).toContain("PI_AGENT_PROVIDER=ollama");
		expect(args).toContain("PI_AGENT_MODEL=glm-test");
		// Injected settings take precedence over any process.env value: set
		// divergent sentinel env values and confirm they are NOT forwarded.
		const priorProvider = process.env.PI_AGENT_PROVIDER;
		const priorModel = process.env.PI_AGENT_MODEL;
		process.env.PI_AGENT_PROVIDER = "should-be-ignored-provider";
		process.env.PI_AGENT_MODEL = "should-be-ignored-model";
		try {
			const args2 = await launcher.buildDockerRunArgs("worker-2", launcher.resolveTemplate());
			expect(args2).toContain("PI_AGENT_PROVIDER=ollama");
			expect(args2).toContain("PI_AGENT_MODEL=glm-test");
			expect(args2).not.toContain("PI_AGENT_PROVIDER=should-be-ignored-provider");
			expect(args2).not.toContain("PI_AGENT_MODEL=should-be-ignored-model");
		} finally {
			if (priorProvider === undefined) delete process.env.PI_AGENT_PROVIDER;
			else process.env.PI_AGENT_PROVIDER = priorProvider;
			if (priorModel === undefined) delete process.env.PI_AGENT_MODEL;
			else process.env.PI_AGENT_MODEL = priorModel;
		}
	});

	it("forwards the build model for build launches and the refinement model for refinement launches", async () => {
		const harness = await createHarness(510, {
			runtimeSettings: () => ({
				model: {
					piAgentProvider: "ollama",
					piAgentModel: "default-model",
					piAgentBuildModel: "build-model",
					piAgentRefinementModel: "refinement-model",
				},
				logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true },
			}),
		});
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, currentWorkerTransport, ""));

		const spawnedArgs: string[][] = [];
		spawnMock.mockImplementation((_cmd, args, options) => {
			spawnedArgs.push(args as string[]);
			const child = makeChildProcess();
			const sessionKey = new URL(options.env.YOLO_SESSION_WS_URL as string).searchParams.get("sessionKey") ?? "";
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("ack", sessionKey, `ack-${sessionKey}`, { ackMessageId: message.messageId }),
					);
					const isRefinement = sessionKey.endsWith("-refinement");
					await connection.send(
						createWorkerMessage("complete", sessionKey, `complete-${sessionKey}`, {
							result: isRefinement
								? {
										proposedTaskBody: "## Summary\nRefined.",
										summary: "Better description.",
										investigation: "Read the code.",
									}
									: { status: "complete", summary: "done", rawResponse: "YOLO_STATUS: complete\ndone" },
							}),
					);
				},
			);
			return child;
		});

		try {
			// Initial issue build.
			await harness.executor.execute(makeSessionState(510, harness.workspacePath));
			// Feedback pass.
			await harness.executor.execute(makeSessionState(511, harness.workspacePath), "Please retry.");
			// PR-review pass.
			await harness.executor.executePRReview(makeSessionState(512, harness.workspacePath), {
				comments: [{ body: "nit", user: "reviewer", path: "a.ts", line: 1 }],
			});
			// Issue refinement.
			await harness.executor.executeRefinement(makeSessionState(513, harness.workspacePath), undefined);

			expect(spawnedArgs).toHaveLength(4);
			expect(spawnedArgs[0]).toContain("PI_AGENT_MODEL=build-model");
			expect(spawnedArgs[1]).toContain("PI_AGENT_MODEL=build-model");
			expect(spawnedArgs[2]).toContain("PI_AGENT_MODEL=build-model");
			expect(spawnedArgs[3]).toContain("PI_AGENT_MODEL=refinement-model");
			for (const args of spawnedArgs) {
				expect(args).toContain("PI_AGENT_PROVIDER=ollama");
				expect(args).not.toContain("PI_AGENT_MODEL=default-model");
			}
		} finally {
			await harness.close();
		}
	});

	it("falls back to the default model per session type and forwards no model when nothing is configured", async () => {
		const workerRpcServer = createFakeWorkerRpcServer();
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "yolomatic-worker:latest",
			workerWorkspaceMountSource: "/workspace-root",
			workerControlBaseUrl: "http://control-plane.test",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			runtimeSettings: () => ({
				model: { piAgentProvider: "ollama", piAgentModel: "default-model" },
				logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true },
			}),
			soulPath: "/app/SOUL.md",
		});

		const launcher = (executor as any).launcher;
		const template = launcher.resolveTemplate();
		// Build and refinement models unset: every session type uses the default model.
		expect(await launcher.buildDockerRunArgs("worker-build", template, "issue")).toContain(
			"PI_AGENT_MODEL=default-model",
		);
		expect(await launcher.buildDockerRunArgs("worker-refine", template, "issue-refinement")).toContain(
			"PI_AGENT_MODEL=default-model",
		);

		const emptyExecutor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "yolomatic-worker:latest",
			workerWorkspaceMountSource: "/workspace-root",
			workerControlBaseUrl: "http://control-plane.test",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			soulPath: "/app/SOUL.md",
		});
		const emptyLauncher = (emptyExecutor as any).launcher;
		const priorModel = process.env.PI_AGENT_MODEL;
		delete process.env.PI_AGENT_MODEL;
		try {
			// Nothing configured: no model is forwarded and the worker keeps pi defaults.
			for (const kind of [undefined, "issue", "comment", "pr-review", "issue-refinement"] as const) {
				const args = await emptyLauncher.buildDockerRunArgs("worker-empty", template, kind);
				expect(args.some((arg: string) => arg.startsWith("PI_AGENT_MODEL="))).toBe(false);
			}
		} finally {
			if (priorModel === undefined) delete process.env.PI_AGENT_MODEL;
			else process.env.PI_AGENT_MODEL = priorModel;
		}
	});

	it("forwards OPENAI_API_KEY from injected runtime settings when configured", async () => {
		const workerRpcServer = createFakeWorkerRpcServer();
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "yolomatic-worker:latest",
			workerWorkspaceMountSource: "/workspace-root",
			workerControlBaseUrl: "http://control-plane.test",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			runtimeSettings: () => ({
				model: { openaiApiKey: "sk-injected" },
				logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true },
			}),
			soulPath: "/app/SOUL.md",
		});

		const launcher = (executor as any).launcher;
		const args = await launcher.buildDockerRunArgs("worker-1", launcher.resolveTemplate());
		expect(args).toContain("OPENAI_API_KEY=sk-injected");
		expect(args.some((arg: string) => arg.startsWith("PI_AGENT_PROVIDER="))).toBe(false);
		expect(args.some((arg: string) => arg.startsWith("OLLAMA_HOST="))).toBe(false);
	});

	it("prefers an explicit workerOpenAiApiKey option over injected runtime settings", async () => {
		const workerRpcServer = createFakeWorkerRpcServer();
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "yolomatic-worker:latest",
			workerWorkspaceMountSource: "/workspace-root",
			workerControlBaseUrl: "http://control-plane.test",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			workerOpenAiApiKey: "sk-explicit",
			runtimeSettings: () => ({
				model: { openaiApiKey: "sk-injected" },
				logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true },
			}),
			soulPath: "/app/SOUL.md",
		});

		const launcher = (executor as any).launcher;
		const args = await launcher.buildDockerRunArgs("worker-1", launcher.resolveTemplate());
		expect(args).toContain("OPENAI_API_KEY=sk-explicit");
		expect(args).not.toContain("OPENAI_API_KEY=sk-injected");
	});

	it("omits OPENAI_API_KEY when neither option nor runtime settings provide one", async () => {
		const workerRpcServer = createFakeWorkerRpcServer();
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "yolomatic-worker:latest",
			workerWorkspaceMountSource: "/workspace-root",
			workerControlBaseUrl: "http://control-plane.test",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			soulPath: "/app/SOUL.md",
		});

		const launcher = (executor as any).launcher;
		delete process.env.OPENAI_API_KEY;
		const args = await launcher.buildDockerRunArgs("worker-1", launcher.resolveTemplate());
		expect(args.some((arg: string) => arg.startsWith("OPENAI_API_KEY="))).toBe(false);
	});

	it("forwards YOLO_WORKER_INIT_* env vars when present", async () => {
		const workerRpcServer = createFakeWorkerRpcServer();
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "yolomatic-worker:latest",
			workerWorkspaceMountSource: "/workspace-root",
			workerControlBaseUrl: "http://control-plane.test",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			soulPath: "/app/SOUL.md",
		});

		process.env.YOLO_WORKER_INIT_SCRIPT = "scripts/bootstrap.sh";
		process.env.YOLO_WORKER_INIT_SKIP = "0";
		process.env.YOLO_WORKER_INIT_TIMEOUT_SECONDS = "600";

		try {
			const launcher = (executor as any).launcher;
			const args = await launcher.buildDockerRunArgs("worker-1", launcher.resolveTemplate());
			expect(args).toContain("YOLO_WORKER_INIT_SCRIPT=scripts/bootstrap.sh");
			expect(args).toContain("YOLO_WORKER_INIT_SKIP=0");
			expect(args).toContain("YOLO_WORKER_INIT_TIMEOUT_SECONDS=600");
		} finally {
			delete process.env.YOLO_WORKER_INIT_SCRIPT;
			delete process.env.YOLO_WORKER_INIT_SKIP;
			delete process.env.YOLO_WORKER_INIT_TIMEOUT_SECONDS;
		}
	});

	it("omits YOLO_WORKER_INIT_* env vars when absent", async () => {
		const workerRpcServer = createFakeWorkerRpcServer();
		const executor = new DockerWorkerExecutor({
			projectRoot: "/repo",
			workspacesDir: "/workspace-root",
			workerImage: "yolomatic-worker:latest",
			workerWorkspaceMountSource: "/workspace-root",
			workerControlBaseUrl: "http://control-plane.test",
			workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
			soulPath: "/app/SOUL.md",
		});

		delete process.env.YOLO_WORKER_INIT_SCRIPT;
		delete process.env.YOLO_WORKER_INIT_SKIP;
		delete process.env.YOLO_WORKER_INIT_TIMEOUT_SECONDS;

		const launcher = (executor as any).launcher;
		const args = await launcher.buildDockerRunArgs("worker-1", launcher.resolveTemplate());
		expect(args.some((arg: string) => arg.startsWith("YOLO_WORKER_INIT_"))).toBe(false);
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
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("error", "github-mbrooks-yolomatic-issue-420-implementation", "error-1", {
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
					repo: "yolomatic",
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
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type === "launch_config") {
						await connection.send(
							createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-421-implementation", "ack-launch", {
								ackMessageId: message.messageId,
							}),
						);
						return;
					}
					if (message.type === "control") {
						sawStop = message.payload.action === "stop";
						await connection.send(
							createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-421-implementation", "ack-stop", {
								ackMessageId: message.messageId,
							}),
						);
						await connection.send(
							createWorkerMessage("complete", "github-mbrooks-yolomatic-issue-421-implementation", "complete-stop", {
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
				repo: "yolomatic",
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
			void connectWorkerSession(harness.workerRpcServer, options.env.YOLO_SESSION_WS_URL as string).then(async (connection) => {
				await connection.send(
					createWorkerMessage("hello", "github-mbrooks-yolomatic-issue-999-implementation", "hello-wrong-session", {
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
					repo: "yolomatic",
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
			void connectWorkerSession(harness.workerRpcServer, options.env.YOLO_SESSION_WS_URL as string).then(async (connection) => {
				await connection.send({
					...createWorkerMessage("hello", "github-mbrooks-yolomatic-issue-423-implementation", "hello-bad-version", {
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
					repo: "yolomatic",
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
					options.env.YOLO_SESSION_WS_URL as string,
					async (connection, message) => {
						if (message.type !== "launch_config") return;
						await connection.send(
							createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-425-implementation", "ack-retry", {
								ackMessageId: message.messageId,
							}),
						);
						await connection.send(
							createWorkerMessage("complete", "github-mbrooks-yolomatic-issue-425-implementation", "complete-retry", {
								result: {
									status: "complete",
									summary: "recovered",
									rawResponse: "YOLO_STATUS: complete\nrecovered",
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
				["inspect", "--format", "{{.State.Status}}", "yolomatic-session-mbrooks-yolomatic-425"],
				expect.any(Object),
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenCalledWith(
				"docker",
				["rm", "yolomatic-session-mbrooks-yolomatic-425"],
				expect.any(Object),
				expect.any(Function),
			);
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"github-mbrooks-yolomatic-issue-425-implementation",
				expect.objectContaining({
					message: "Removed stopped conflicting worker container yolomatic-session-mbrooks-yolomatic-425; retrying launch",
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
				'The container name "/yolomatic-session-mbrooks-yolomatic-426" is already in use',
			);
			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(execFileMock).not.toHaveBeenCalledWith(
				"docker",
				["rm", "yolomatic-session-mbrooks-yolomatic-426"],
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
				'The container name "/yolomatic-session-mbrooks-yolomatic-428" is already in use',
			);
			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"github-mbrooks-yolomatic-issue-428-implementation",
				expect.objectContaining({
					message: "Could not inspect conflicting worker container yolomatic-session-mbrooks-yolomatic-428",
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
				'The container name "/yolomatic-session-mbrooks-yolomatic-429" is already in use',
			);
			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"github-mbrooks-yolomatic-issue-429-implementation",
				expect.objectContaining({
					message: "Could not remove stopped conflicting worker container yolomatic-session-mbrooks-yolomatic-429",
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
				callback(null, "https://x-access-token:ghp_secret@github.com/mbrooks/yolomatic.git\n", "");
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
				callback(null, "https://github.com/mbrooks/yolomatic.git\n", "");
				return;
			}
			callback(null, currentWorkerTransport, "");
			return;
		});

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-431-implementation", "ack-safe", { ackMessageId: message.messageId }),
					);
					await connection.send(
						createWorkerMessage("complete", "github-mbrooks-yolomatic-issue-431-implementation", "complete-safe", {
							result: { status: "complete", summary: "done", rawResponse: "YOLO_STATUS: complete\ndone" },
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

	it("launches a refinement worker and parses the refinement result", async () => {
		const harness = await createHarness(450);
		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				callback(null, "https://github.com/mbrooks/yolomatic.git\n", "");
				return;
			}
			callback(null, currentWorkerTransport, "");
		});

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					expect((message as WorkerProtocolMessage<"launch_config">).payload.prompt.kind).toBe("issue-refinement");
					await connection.send(
						createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-450-refinement", "ack-refine", { ackMessageId: message.messageId }),
					);
					await connection.send(
						createWorkerMessage("complete", "github-mbrooks-yolomatic-issue-450-refinement", "complete-refine", {
							result: {
								proposedTaskBody: "## Summary\nRefined.",
								summary: "Better description.",
								investigation: "Read the code.",
							},
						}),
					);
				},
			);
			return child;
		});

		try {
			const result = await harness.executor.executeRefinement(makeSessionState(450, harness.workspacePath), undefined);
			expect(result.proposedTaskBody).toBe("## Summary\nRefined.");
			expect(result.summary).toBe("Better description.");
			expect(spawnMock).toHaveBeenCalled();
			const args = spawnMock.mock.calls[0]![1] as string[];
			expect(args).toContain("--name");
			expect(args[args.indexOf("--name") + 1]).toContain("refinement");
		} finally {
			await harness.close();
		}
	});

	it("rejects an invalid refinement result", async () => {
		const harness = await createHarness(451);
		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				callback(null, "https://github.com/mbrooks/yolomatic.git\n", "");
				return;
			}
			callback(null, currentWorkerTransport, "");
		});

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-451-refinement", "ack-bad", { ackMessageId: message.messageId }),
					);
					await connection.send(
						createWorkerMessage("complete", "github-mbrooks-yolomatic-issue-451-refinement", "complete-bad", {
							result: { proposedTaskBody: "", summary: "", investigation: "" } as any,
						}),
					);
				},
			);
			return child;
		});

		try {
			await harness.executor.executeRefinement(makeSessionState(451, harness.workspacePath), undefined);
			throw new Error("expected refinement to fail");
		} catch (error) {
			expect(error instanceof Error ? error.message : String(error)).toMatch(/invalid refinement result/);
		} finally {
			await harness.close();
		}
	});

	it("falls back to configured workspace mount source when docker self-inspection fails", async () => {
		const harness = await createHarness(452);
		const originalHostname = process.env.HOSTNAME;
		process.env.HOSTNAME = "some-container";
		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			if (args[0] === "inspect") {
				callback(new Error("docker not available"), "", "");
				return;
			}
			if (args[0] === "remote" && args[1] === "get-url") {
				callback(null, "https://github.com/mbrooks/yolomatic.git\n", "");
				return;
			}
			callback(null, currentWorkerTransport, "");
		});

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-452-implementation", "ack-fallback", { ackMessageId: message.messageId }),
					);
					await connection.send(
						createWorkerMessage("complete", "github-mbrooks-yolomatic-issue-452-implementation", "complete-fallback", {
							result: { status: "complete", summary: "done", rawResponse: "YOLO_STATUS: complete\ndone" },
						}),
					);
				},
			);
			return child;
		});

		try {
			const result = await harness.executor.execute(makeSessionState(452, harness.workspacePath));
			expect(result.status).toBe("complete");
		} finally {
			process.env.HOSTNAME = originalHostname;
			await harness.close();
		}
	});

	it("allows launch when the workspace has no origin remote", async () => {
		const harness = await createHarness(453);
		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				callback(new Error("no origin remote"), "", "");
				return;
			}
			callback(null, currentWorkerTransport, "");
		});

		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-453-implementation", "ack-noremote", { ackMessageId: message.messageId }),
					);
					await connection.send(
						createWorkerMessage("complete", "github-mbrooks-yolomatic-issue-453-implementation", "complete-noremote", {
							result: { status: "complete", summary: "done", rawResponse: "YOLO_STATUS: complete\ndone" },
						}),
					);
				},
			);
			return child;
		});

		try {
			const result = await harness.executor.execute(makeSessionState(453, harness.workspacePath));
			expect(result.status).toBe("complete");
		} finally {
			await harness.close();
		}
	});

	it("prebuilds the worker image and logs startup messages", async () => {
		const harness = await createHarness(700);
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await harness.executor.prebuildWorkerImage();
			expect(execFileMock).toHaveBeenCalledWith(
				"docker",
				[
					"build",
					"--target",
					"worker",
					"--label",
					"io.yolomatic.worker.transport=websocket-v1",
					"-t",
					"yolomatic-worker:latest",
					harness.projectRoot,
				],
				expect.any(Object),
				expect.any(Function),
			);
			expect(stdoutSpy).toHaveBeenCalledWith("[startup] prebuilding worker image...\n");
			expect(stdoutSpy).toHaveBeenCalledWith("[startup] worker image prebuilt successfully\n");
		} finally {
			stdoutSpy.mockRestore();
			await harness.close();
		}
	});

	it("reuses the prebuilt image promise on the first session launch", async () => {
		const harness = await createHarness(701);
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));
		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			const sessionKey = new URL(options.env.YOLO_SESSION_WS_URL as string).searchParams.get("sessionKey") ?? "";
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("ack", sessionKey, "ack-prebuild", { ackMessageId: message.messageId }),
					);
					await connection.send(
						createWorkerMessage("complete", sessionKey, "complete-prebuild", {
							result: {
								status: "complete",
								summary: "done",
								rawResponse: "YOLO_STATUS: complete\ndone",
							},
						}),
					);
				},
			);
			return child;
		});

		try {
			await harness.executor.prebuildWorkerImage();
			execFileMock.mockClear();
			await harness.executor.execute(makeSessionState(701, harness.workspacePath));
			expect(execFileMock.mock.calls.filter((call) => call[1][0] === "build")).toHaveLength(0);
		} finally {
			await harness.close();
		}
	});

	it("rebuilds a cached worker template when Docker no longer has its image", async () => {
		const harness = await createHarness(703, {
			workerImage: undefined,
			defaultWorkerTemplate: "node",
		});
		const images = new Set<string>();
		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			if (args[0] === "image" && args[1] === "inspect") {
				if (images.has(args[2])) callback(null, "[]", "");
				else callback(new Error(`No such image: ${args[2]}`), "", "");
				return;
			}
			if (args[0] === "build") {
				images.add(args[args.indexOf("-t") + 1]);
			}
			callback(null, "", "");
		});

		try {
			const launcher = (harness.executor as any).launcher;
			const template = launcher.resolveTemplate();
			await harness.executor.prebuildWorkerImage();
			images.delete("yolomatic-worker-node:latest");

			await launcher.ensureWorkerImage(template, "test-session");

			const builtImages = execFileMock.mock.calls
				.filter((call) => call[1][0] === "build")
				.map((call) => call[1][call[1].indexOf("-t") + 1]);
			expect(builtImages).toEqual([
				"yolomatic-worker-base:latest",
				"yolomatic-worker-node:latest",
				"yolomatic-worker-node:latest",
			]);
			expect(images.has("yolomatic-worker-node:latest")).toBe(true);
		} finally {
			await harness.close();
		}
	});

	it("rebuilds pruned base and template images once for concurrent recovery requests", async () => {
		const harness = await createHarness(704, {
			workerImage: undefined,
			defaultWorkerTemplate: "node",
		});
		const images = new Set<string>();
		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			queueMicrotask(() => {
				if (args[0] === "image" && args[1] === "inspect") {
					if (images.has(args[2])) callback(null, "[]", "");
					else callback(new Error(`No such image: ${args[2]}`), "", "");
					return;
				}
				if (args[0] === "build") {
					images.add(args[args.indexOf("-t") + 1]);
				}
				callback(null, "", "");
			});
		});

		try {
			const launcher = (harness.executor as any).launcher;
			const template = launcher.resolveTemplate();
			await harness.executor.prebuildWorkerImage();
			images.clear();

			await Promise.all([
				launcher.ensureWorkerImage(template, "test-session-1"),
				launcher.ensureWorkerImage(template, "test-session-2"),
			]);
			images.delete("yolomatic-worker-base:latest");
			await Promise.all([
				launcher.ensureWorkerBaseImage(),
				launcher.ensureWorkerBaseImage(),
			]);

			const builtImages = execFileMock.mock.calls
				.filter((call) => call[1][0] === "build")
				.map((call) => call[1][call[1].indexOf("-t") + 1]);
			expect(builtImages).toEqual([
				"yolomatic-worker-base:latest",
				"yolomatic-worker-node:latest",
				"yolomatic-worker-base:latest",
				"yolomatic-worker-node:latest",
				"yolomatic-worker-base:latest",
			]);
		} finally {
			await harness.close();
		}
	});

	it("stops worker image revalidation after three concurrent cache replacements", async () => {
		const harness = await createHarness(707, {
			workerImage: undefined,
			defaultWorkerTemplate: "node",
		});
		const executor = harness.executor as any;
		const launcher = executor.launcher;
		const template = launcher.resolveTemplate();
		let inspections = 0;
		launcher.imageReady.set(template.id, Promise.resolve());
		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			if (args[0] === "image" && args[1] === "inspect") {
				inspections += 1;
				if (inspections <= 3) {
					// Simulate another concurrent request replacing the cached promise
					// before this request can invalidate the stale entry.
					launcher.imageReady.set(template.id, Promise.resolve());
					callback(new Error(`No such image: ${args[2]}`), "", "");
					return;
				}
				callback(null, "[]", "");
				return;
			}
			callback(null, "", "");
		});

		try {
			await expect(launcher.ensureWorkerImage(template, "test-session")).rejects.toThrow(
				"Worker image yolomatic-worker-node:latest remained unavailable after 3 cache revalidation attempts.",
			);
			expect(inspections).toBe(3);
		} finally {
			await harness.close();
		}
	});

	it("stops base image revalidation after three concurrent cache replacements", async () => {
		const harness = await createHarness(708, {
			workerImage: undefined,
			defaultWorkerTemplate: "node",
		});
		const executor = harness.executor as any;
		const launcher = executor.launcher;
		let inspections = 0;
		launcher.baseImageReady = Promise.resolve();
		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			if (args[0] === "image" && args[1] === "inspect") {
				inspections += 1;
				if (inspections <= 3) {
					launcher.baseImageReady = Promise.resolve();
					callback(new Error(`No such image: ${args[2]}`), "", "");
					return;
				}
				callback(null, "[]", "");
				return;
			}
			callback(null, "", "");
		});

		try {
			await expect(launcher.ensureWorkerBaseImage()).rejects.toThrow(
				"Worker base image yolomatic-worker-base:latest remained unavailable after 3 cache revalidation attempts.",
			);
			expect(inspections).toBe(3);
		} finally {
			await harness.close();
		}
	});

	it("falls back to the default template when no configured or legacy image resolves", async () => {
		const harness = await createHarness(705, {
			workerImage: undefined,
			defaultWorkerTemplate: "missing",
		});

		try {
			const launcher = (harness.executor as any).launcher;
			expect(launcher.resolveTemplate()).toMatchObject({
				id: "node",
				image: "yolomatic-worker-node:latest",
			});
		} finally {
			await harness.close();
		}
	});

	it("reports a non-Error prebuild rejection and clears the cached build", async () => {
		const harness = await createHarness(706);
		execFileMock.mockImplementationOnce((_cmd, _args, _options, callback) =>
			callback("prebuild rejected" as unknown as Error, "", ""),
		);
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		try {
			await expect(harness.executor.prebuildWorkerImage()).resolves.toBeUndefined();
			expect(stdoutSpy).toHaveBeenCalledWith(
				"[startup] worker image prebuild failed: prebuild rejected\n",
			);
			const launcher = (harness.executor as any).launcher;
			expect(launcher.imageReady.size).toBe(0);
		} finally {
			stdoutSpy.mockRestore();
			await harness.close();
		}
	});

	it("recovers from a failed prebuild by rebuilding on the first session", async () => {
		const harness = await createHarness(702);
		execFileMock.mockImplementationOnce((_cmd, _args, _options, callback) =>
			callback(new Error("prebuild failed"), "", ""),
		);
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		spawnMock.mockImplementation((_cmd, _args, options) => {
			const child = makeChildProcess();
			const sessionKey = new URL(options.env.YOLO_SESSION_WS_URL as string).searchParams.get("sessionKey") ?? "";
			void connectMockWorker(
				harness.workerRpcServer,
				options.env.YOLO_SESSION_WS_URL as string,
				async (connection, message) => {
					if (message.type !== "launch_config") return;
					await connection.send(
						createWorkerMessage("ack", sessionKey, "ack-recover", { ackMessageId: message.messageId }),
					);
					await connection.send(
						createWorkerMessage("complete", sessionKey, "complete-recover", {
							result: {
								status: "complete",
								summary: "done",
								rawResponse: "YOLO_STATUS: complete\ndone",
							},
						}),
					);
				},
			);
			return child;
		});

		try {
			await expect(harness.executor.prebuildWorkerImage()).resolves.toBeUndefined();
			expect(stdoutSpy).toHaveBeenCalledWith(
				"[startup] worker image prebuild failed: prebuild failed\n",
			);
			execFileMock.mockClear();
			await harness.executor.execute(makeSessionState(702, harness.workspacePath));
			expect(execFileMock.mock.calls.filter((call) => call[1][0] === "build")).toHaveLength(1);
		} finally {
			stdoutSpy.mockRestore();
			await harness.close();
		}
	});
});

	describe("tool_request / tool_response gateway dispatch", () => {
		const gatewayTransport = "websocket-v1";

		it("routes a worker tool_request through the gateway and logs success", async () => {
			const harness = await createHarness(460);
			const github: GitHubGatewayService = {
				getAuthenticatedUser: vi.fn(async () => ({ login: "yolomatic-bot" })),
			} as unknown as GitHubGatewayService;
			const gateway = new WorkerGitHubGateway(github, makeFakeWorkspace());
			(harness.executor as unknown as { options: { githubGateway: WorkerGitHubGateway } }).options.githubGateway = gateway;
			execFileMock.mockImplementation((_cmd, args, _options, callback) => {
				if (args[0] === "remote" && args[1] === "get-url") {
					callback(null, "https://github.com/mbrooks/yolomatic.git\n", "");
					return;
				}
				callback(null, gatewayTransport, "");
			});

			spawnMock.mockImplementation((_cmd, _args, options) => {
				const child = makeChildProcess();
				void connectMockWorker(
					harness.workerRpcServer,
					options.env.YOLO_SESSION_WS_URL as string,
					async (connection, message) => {
						if (message.type === "launch_config") {
							await connection.send(
								createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-460-implementation", "ack-launch", { ackMessageId: message.messageId }),
							);
							await connection.send(
								createWorkerMessage("tool_request", "github-mbrooks-yolomatic-issue-460-implementation", "tool-1", {
									tool: "get_authenticated_user",
									params: {},
								}),
							);
							return;
						}
						if (message.type === "tool_response") {
							expect((message.payload as { ok: boolean }).ok).toBe(true);
							await connection.send(
								createWorkerMessage("complete", "github-mbrooks-yolomatic-issue-460-implementation", "complete-1", {
									result: { status: "complete", summary: "done", rawResponse: "YOLO_STATUS: complete\ndone" },
								}),
							);
						}
					},
				);
				return child;
			});

			try {
				const result = await harness.executor.execute(makeSessionState(460, harness.workspacePath));
				expect(result.status).toBe("complete");
				expect(github.getAuthenticatedUser).toHaveBeenCalled();
				expect(recordSessionLogMock).toHaveBeenCalledWith(
					"github-mbrooks-yolomatic-issue-460-implementation",
					expect.objectContaining({ message: "gateway get_authenticated_user done" }),
				);
			} finally {
				await harness.close();
			}
		});

		it("returns a scope-error tool_response and does not call GitHub for out-of-scope pr_number", async () => {
			const harness = await createHarness(461);
			const github: GitHubGatewayService = {
				getAuthenticatedUser: vi.fn(async () => ({ login: "bot" })),
				listPullRequestsForHead: vi.fn(async () => []),
				postPRComment: vi.fn(async () => {
					throw new Error("must not be called");
				}),
			} as unknown as GitHubGatewayService;
			const gateway = new WorkerGitHubGateway(github, makeFakeWorkspace());
			(harness.executor as unknown as { options: { githubGateway: WorkerGitHubGateway } }).options.githubGateway = gateway;
			execFileMock.mockImplementation((_cmd, args, _options, callback) => {
				if (args[0] === "remote" && args[1] === "get-url") {
					callback(null, "https://github.com/mbrooks/yolomatic.git\n", "");
					return;
				}
				callback(null, gatewayTransport, "");
			});

			let responsePayload: GatewayToolResponse | undefined;
			spawnMock.mockImplementation((_cmd, _args, options) => {
				const child = makeChildProcess();
				void connectMockWorker(
					harness.workerRpcServer,
					options.env.YOLO_SESSION_WS_URL as string,
					async (connection, message) => {
						if (message.type === "launch_config") {
							await connection.send(
								createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-461-implementation", "ack-launch", { ackMessageId: message.messageId }),
							);
							await connection.send(
								createWorkerMessage("tool_request", "github-mbrooks-yolomatic-issue-461-implementation", "tool-2", {
									tool: "set_pr_comment",
									params: { body: "hi", pr_number: 999 },
								}),
							);
							return;
						}
						if (message.type === "tool_response") {
							responsePayload = message.payload as unknown as GatewayToolResponse;
							await connection.send(
								createWorkerMessage("complete", "github-mbrooks-yolomatic-issue-461-implementation", "complete-2", {
									result: { status: "complete", summary: "done", rawResponse: "YOLO_STATUS: complete\ndone" },
								}),
							);
						}
					},
				);
				return child;
			});

			try {
				await harness.executor.execute(makeSessionState(461, harness.workspacePath));
				expect(responsePayload).toBeDefined();
				expect(responsePayload?.ok).toBe(false);
				expect(responsePayload?.scopeError).toBe(true);
				expect(github.postPRComment).not.toHaveBeenCalled();
				expect(github.listPullRequestsForHead).toHaveBeenCalled();
				expect(recordSessionLogMock).toHaveBeenCalledWith(
					"github-mbrooks-yolomatic-issue-461-implementation",
					expect.objectContaining({ message: "gateway set_pr_comment scope-rejected" }),
				);
			} finally {
				await harness.close();
			}
		});

		it("returns an error tool_response when no gateway is configured", async () => {
			const harness = await createHarness(462);
			execFileMock.mockImplementation((_cmd, args, _options, callback) => {
				if (args[0] === "remote" && args[1] === "get-url") {
					callback(null, "https://github.com/mbrooks/yolomatic.git\n", "");
					return;
				}
				callback(null, gatewayTransport, "");
			});

			let responsePayload: GatewayToolResponse | undefined;
			spawnMock.mockImplementation((_cmd, _args, options) => {
				const child = makeChildProcess();
				void connectMockWorker(
					harness.workerRpcServer,
					options.env.YOLO_SESSION_WS_URL as string,
					async (connection, message) => {
						if (message.type === "launch_config") {
							await connection.send(
								createWorkerMessage("ack", "github-mbrooks-yolomatic-issue-462-implementation", "ack-launch", { ackMessageId: message.messageId }),
							);
							await connection.send(
								createWorkerMessage("tool_request", "github-mbrooks-yolomatic-issue-462-implementation", "tool-3", {
									tool: "fetch_issue",
									params: {},
								}),
							);
							return;
						}
						if (message.type === "tool_response") {
							responsePayload = message.payload as unknown as GatewayToolResponse;
							await connection.send(
								createWorkerMessage("complete", "github-mbrooks-yolomatic-issue-462-implementation", "complete-3", {
									result: { status: "complete", summary: "done", rawResponse: "YOLO_STATUS: complete\ndone" },
								}),
							);
						}
					},
				);
				return child;
			});

			try {
				await harness.executor.execute(makeSessionState(462, harness.workspacePath));
				expect(responsePayload).toBeDefined();
				expect(responsePayload?.ok).toBe(false);
				expect(responsePayload?.error).toContain("GitHub gateway is not enabled");
			} finally {
				await harness.close();
			}
		});
	});


async function createHarness(
	issueNumber: number,
	workerOptions: Partial<
		Pick<DockerWorkerExecutorOptions, "workerImage" | "defaultWorkerTemplate" | "resolveWorkerTemplate" | "runtimeSettings">
	> = {},
): Promise<{
	executor: DockerWorkerExecutor;
	projectRoot: string;
	workspacePath: string;
	workerRpcServer: FakeWorkerRpcServer;
	close: () => Promise<void>;
}> {
	const workspacesRoot = await mkdtemp(path.join(os.tmpdir(), `yolomatic-docker-worker-${issueNumber}-`));
	const workspacePath = path.join(workspacesRoot, "mbrooks-yolomatic", ".worktrees", `issue-${issueNumber}`);
	await mkdir(workspacePath, { recursive: true });

	const workerRpcServer = createFakeWorkerRpcServer();
	const projectRoot = issueNumber === 419 ? "/repo" : workspacesRoot;
	const executor = new DockerWorkerExecutor({
		projectRoot,
		workspacesDir: workspacesRoot,
		workerImage: "yolomatic-worker:latest",
		...workerOptions,
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
				`docker: Error response from daemon: Conflict. The container name "/yolomatic-session-mbrooks-yolomatic-${issueNumber}" is already in use by container "existing".`,
			),
		);
		child.emit("exit", 125, null);
	});
	return child;
}

function makeSessionState(issueNumber: number, workspacePath: string) {
	return {
		issueNumber,
		repo: "yolomatic",
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
