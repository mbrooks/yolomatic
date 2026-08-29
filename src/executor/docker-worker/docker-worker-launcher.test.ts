import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileMock, spawnMock, recordSessionLogMock } = vi.hoisted(() => ({
	execFileMock: vi.fn(),
	spawnMock: vi.fn(),
	recordSessionLogMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: execFileMock,
	spawn: spawnMock,
}));

vi.mock("../../logging/session-log-store.js", () => ({
	recordSessionLog: recordSessionLogMock,
}));

import { DockerWorkerLauncher } from "./docker-worker-launcher.js";

const LEGACY_TEMPLATE = { id: "legacy", label: "Legacy", image: "worker:latest", dockerfile: "Dockerfile" };

function createLauncher(options: Record<string, unknown> = {}): DockerWorkerLauncher {
	return new DockerWorkerLauncher({
		projectRoot: "/repo",
		workspacesDir: "/workspaces",
		workerWorkspaceMountSource: "/workspaces",
		soulPath: "/repo/SOUL.md",
		...options,
	});
}

function execFileSuccess(): void {
	execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));
}

function makeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
	const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	return child;
}

function conflictingExitError(): Error {
	return new Error(
		'docker: Error response from daemon: Conflict. The container name "/worker-1" is already in use by container "existing".',
	);
}

describe("DockerWorkerLauncher", () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
		delete process.env.HOSTNAME;
		delete process.env.OLLAMA_HOST;
		delete process.env.YOLO_WORKER_INIT_SCRIPT;
		delete process.env.YOLO_WORKER_INIT_SKIP;
		delete process.env.YOLO_WORKER_INIT_TIMEOUT_SECONDS;
	});

	it("builds a launch plan containing mounts, env, network flags, image, and RPC URL", async () => {
		process.env.YOLO_WORKER_INIT_SCRIPT = "./init.sh";
		process.env.YOLO_WORKER_INIT_SKIP = "true";
		process.env.YOLO_WORKER_INIT_TIMEOUT_SECONDS = "42";

		const launcher = new DockerWorkerLauncher({
			projectRoot: "/repo",
			workspacesDir: "/workspaces",
			workerWorkspaceMountSource: "/workspaces",
			workerDockerNetworkMode: "bridge",
			workerOllamaHost: "http://host:11434",
			workerOpenAiApiKey: "sk-test",
			soulPath: "/repo/SOUL.md",
			runtimeSettings: () => ({ model: { piAgentProvider: "openai", piAgentModel: "gpt-4.1", openaiApiKey: undefined }, logging: { logLevel: "info", logPrompts: false, logThoughts: false, logTools: false, logResponses: false } }),
		});

		execFileSuccess();

		const plan = await launcher.createLaunchPlan({
			sessionKey: "session-123",
			workerSessionUrl: "ws://control-plane.test/rpc?sessionKey=session-123&token=token-1",
			containerName: "yolomatic-session-x",
			workerTemplate: LEGACY_TEMPLATE,
		});

		expect(plan.args).toEqual(
			expect.arrayContaining([
				"run",
				"--rm",
				"--name",
				"yolomatic-session-x",
				"--mount",
				"type=bind,src=/workspaces,dst=/workspaces",
				"--network",
				"bridge",
				"--add-host",
				"host.docker.internal:host-gateway",
				"-e",
				"PI_AGENT_PROVIDER=openai",
				"-e",
				"PI_AGENT_MODEL=gpt-4.1",
				"-e",
				"YOLO_WORKER_INIT_SCRIPT=./init.sh",
				"-e",
				"YOLO_WORKER_INIT_SKIP=true",
				"-e",
				"YOLO_WORKER_INIT_TIMEOUT_SECONDS=42",
				"-e",
				"OLLAMA_HOST=http://host:11434",
				"-e",
				"OPENAI_API_KEY=sk-test",
				"-e",
				"YOLO_SESSION_KEY",
				"-e",
				"YOLO_SESSION_WS_URL",
				"-e",
				"YOLO_SOUL_PATH",
				"worker:latest",
			]),
		);
		expect(plan.env.YOLO_SESSION_KEY).toBe("session-123");
		expect(plan.env.YOLO_SESSION_WS_URL).toBe("ws://control-plane.test/rpc?sessionKey=session-123&token=token-1");
		expect(plan.env.YOLO_SOUL_PATH).toBe("/repo/SOUL.md");
	});

	it("caches mount-source discovery across calls", async () => {
		process.env.HOSTNAME = "control-plane-container";

		execFileMock.mockImplementation((_cmd, args, _options, callback) => {
			if (args[0] === "inspect" && args[1] === "--format") {
				callback(
					null,
					JSON.stringify([
						{ Destination: "/workspaces", Type: "volume", Name: "ws-volume" },
					]),
					"",
				);
				return;
			}
			callback(null, "", "");
		});

		const launcher = createLauncher({ workerWorkspaceMountSource: "workspaces" });

		const first = await launcher.resolveWorkerWorkspaceMountSource();
		const second = await launcher.resolveWorkerWorkspaceMountSource();

		expect(first).toBe("ws-volume");
		expect(second).toBe("ws-volume");
		expect(
			execFileMock.mock.calls.filter((call) => call[0] === "docker" && call[1][0] === "inspect").length,
		).toBe(1);
	});

	it("forwards the build model for build launches and the refinement model for refinement launches", async () => {
		const launcher = createLauncher({
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

		execFileSuccess();

		const issueArgs = await launcher.buildDockerRunArgs("worker-issue", LEGACY_TEMPLATE, "issue");
		expect(issueArgs).toContain("PI_AGENT_MODEL=build-model");

		const commentArgs = await launcher.buildDockerRunArgs("worker-comment", LEGACY_TEMPLATE, "comment");
		expect(commentArgs).toContain("PI_AGENT_MODEL=build-model");

		const prReviewArgs = await launcher.buildDockerRunArgs("worker-review", LEGACY_TEMPLATE, "pr-review");
		expect(prReviewArgs).toContain("PI_AGENT_MODEL=build-model");

		const refinementArgs = await launcher.buildDockerRunArgs("worker-refinement", LEGACY_TEMPLATE, "issue-refinement");
		expect(refinementArgs).toContain("PI_AGENT_MODEL=refinement-model");
		expect(refinementArgs).not.toContain("PI_AGENT_MODEL=build-model");
		expect(refinementArgs).not.toContain("PI_AGENT_MODEL=default-model");
	});

	it("falls back to the default model per launch kind when the specialized model is unset", async () => {
		const launcher = createLauncher({
			runtimeSettings: () => ({
				model: {
					piAgentProvider: "ollama",
					piAgentModel: "default-model",
					piAgentBuildModel: "build-model",
				},
				logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true },
			}),
		});

		execFileSuccess();

		// Build model set: build launches use it, refinement falls back to the default.
		expect(await launcher.buildDockerRunArgs("worker-build", LEGACY_TEMPLATE, "issue")).toContain(
			"PI_AGENT_MODEL=build-model",
		);
		expect(await launcher.buildDockerRunArgs("worker-build-refine", LEGACY_TEMPLATE, "issue-refinement")).toContain(
			"PI_AGENT_MODEL=default-model",
		);

		const refinementOnlyLauncher = createLauncher({
			runtimeSettings: () => ({
				model: {
					piAgentModel: "default-model",
					piAgentRefinementModel: "refinement-model",
				},
				logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true },
			}),
		});

		// Refinement model set: refinement launches use it, builds fall back to the default.
		expect(
			await refinementOnlyLauncher.buildDockerRunArgs("worker-refine", LEGACY_TEMPLATE, "issue-refinement"),
		).toContain("PI_AGENT_MODEL=refinement-model");
		expect(await refinementOnlyLauncher.buildDockerRunArgs("worker-refine-build", LEGACY_TEMPLATE, "issue")).toContain(
			"PI_AGENT_MODEL=default-model",
		);
	});

	it("omits PI_AGENT_MODEL when no model is configured for the launch kind", async () => {
		const launcher = createLauncher();

		execFileSuccess();

		delete process.env.PI_AGENT_MODEL;
		delete process.env.PI_AGENT_PROVIDER;

		for (const kind of [undefined, "issue", "comment", "pr-review", "issue-refinement"] as const) {
			const args = await launcher.buildDockerRunArgs("worker-1", LEGACY_TEMPLATE, kind);
			expect(args.some((arg) => arg.startsWith("PI_AGENT_MODEL="))).toBe(false);
		}
	});

	const globalModelSettings = () => ({
		model: {
			piAgentProvider: "ollama",
			piAgentModel: "default-model",
			piAgentBuildModel: "build-model",
			piAgentRefinementModel: "refinement-model",
		},
		logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true },
	});

	it("applies a per-repository build-model override to build launches and omits the global provider for slash-form models", async () => {
		const resolveRepoBuildModel = vi.fn((owner: string, repo: string) =>
			owner === "mbrooks" && repo === "yolomatic" ? "openai/gpt-4.1" : undefined);
		const launcher = createLauncher({
			runtimeSettings: globalModelSettings,
			resolveRepoBuildModel,
		});

		execFileSuccess();

		// Build session for the overridden repository: repo model wins and, being
		// slash-form, suppresses the global PI_AGENT_PROVIDER across providers.
		const args = await launcher.buildDockerRunArgs("worker-1", LEGACY_TEMPLATE, "comment", {
			owner: "mbrooks",
			repo: "yolomatic",
		});
		expect(args).toContain("PI_AGENT_MODEL=openai/gpt-4.1");
		expect(args).not.toContain("PI_AGENT_MODEL=build-model");
		expect(args).not.toContain("PI_AGENT_MODEL=default-model");
		expect(args.some((arg: string) => arg.startsWith("PI_AGENT_PROVIDER="))).toBe(false);
		expect(resolveRepoBuildModel).toHaveBeenCalledWith("mbrooks", "yolomatic");
	});

	it("applies a bare per-repository model and keeps the global provider forwarded", async () => {
		const launcher = createLauncher({
			runtimeSettings: globalModelSettings,
			resolveRepoBuildModel: () => "qwen3-coder:30b",
		});

		execFileSuccess();

		const args = await launcher.buildDockerRunArgs("worker-1", LEGACY_TEMPLATE, "issue", {
			owner: "mbrooks",
			repo: "yolomatic",
		});
		expect(args).toContain("PI_AGENT_MODEL=qwen3-coder:30b");
		expect(args).toContain("PI_AGENT_PROVIDER=ollama");
	});

	it("keeps the global build model and provider for a repository without an override", async () => {
		const launcher = createLauncher({
			runtimeSettings: globalModelSettings,
			resolveRepoBuildModel: () => undefined,
		});

		execFileSuccess();

		const args = await launcher.buildDockerRunArgs("worker-1", LEGACY_TEMPLATE, "pr-review", {
			owner: "mbrooks",
			repo: "other-repo",
		});
		expect(args).toContain("PI_AGENT_MODEL=build-model");
		expect(args).toContain("PI_AGENT_PROVIDER=ollama");
	});

	it("keeps the global behavior for launches without a repository", async () => {
		const launcher = createLauncher({
			runtimeSettings: globalModelSettings,
			resolveRepoBuildModel: () => "openai/gpt-4.1",
		});

		execFileSuccess();

		const args = await launcher.buildDockerRunArgs("worker-1", LEGACY_TEMPLATE, "issue");
		expect(args).toContain("PI_AGENT_MODEL=build-model");
		expect(args).toContain("PI_AGENT_PROVIDER=ollama");
	});

	it("keeps the global refinement model and provider for a refinement launch of an overridden repository", async () => {
		const launcher = createLauncher({
			runtimeSettings: globalModelSettings,
			resolveRepoBuildModel: () => "openai/gpt-4.1",
		});

		execFileSuccess();

		const args = await launcher.buildDockerRunArgs("worker-refine", LEGACY_TEMPLATE, "issue-refinement", {
			owner: "mbrooks",
			repo: "yolomatic",
		});
		// Refinements always use the global refinement model, and the slash-form
		// override must not suppress the global provider for refinement launches.
		expect(args).toContain("PI_AGENT_MODEL=refinement-model");
		expect(args).toContain("PI_AGENT_PROVIDER=ollama");
		expect(args).not.toContain("PI_AGENT_MODEL=openai/gpt-4.1");
	});

	it("threads the repository into the launch plan model env", async () => {
		const launcher = createLauncher({
			runtimeSettings: globalModelSettings,
			resolveRepoBuildModel: () => "openai/gpt-4.1",
		});

		execFileSuccess();

		const plan = await launcher.createLaunchPlan({
			sessionKey: "session-repo-override",
			workerSessionUrl: "ws://control-plane.test/rpc?sessionKey=session-repo-override&token=token-1",
			containerName: "yolomatic-session-x",
			workerTemplate: LEGACY_TEMPLATE,
			promptKind: "issue",
			repo: { owner: "mbrooks", repo: "yolomatic" },
		});

		expect(plan.args).toContain("PI_AGENT_MODEL=openai/gpt-4.1");
		expect(plan.args.some((arg: string) => arg.startsWith("PI_AGENT_PROVIDER="))).toBe(false);
	});

	it("threads the prompt kind into the launch plan model env", async () => {
		const launcher = createLauncher({
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

		execFileSuccess();

		const plan = await launcher.createLaunchPlan({
			sessionKey: "session-refine",
			workerSessionUrl: "ws://control-plane.test/rpc?sessionKey=session-refine&token=token-1",
			containerName: "yolomatic-refinement-x",
			workerTemplate: LEGACY_TEMPLATE,
			promptKind: "issue-refinement",
		});

		expect(plan.args).toContain("PI_AGENT_MODEL=refinement-model");
	});

	it("prefers an explicit OpenAI key over injected runtime settings", async () => {
		const launcher = createLauncher({
			workerOpenAiApiKey: "sk-explicit",
			runtimeSettings: () => ({
				model: { openaiApiKey: "sk-injected" },
				logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true },
			}),
		});

		execFileSuccess();

		expect(launcher.resolveWorkerOpenAiApiKey()).toBe("sk-explicit");
		const args = await launcher.buildDockerRunArgs("worker-1", LEGACY_TEMPLATE);
		expect(args).toContain("OPENAI_API_KEY=sk-explicit");
		expect(args).not.toContain("OPENAI_API_KEY=sk-injected");
	});

	it("reads the OpenAI key from injected runtime settings when no explicit option exists", async () => {
		const launcher = createLauncher({
			runtimeSettings: () => ({
				model: { openaiApiKey: "sk-injected" },
				logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true },
			}),
		});

		execFileSuccess();

		expect(launcher.resolveWorkerOpenAiApiKey()).toBe("sk-injected");
		const args = await launcher.buildDockerRunArgs("worker-1", LEGACY_TEMPLATE);
		expect(args).toContain("OPENAI_API_KEY=sk-injected");
	});

	it("omits the OpenAI key when neither option nor settings provide one", async () => {
		const launcher = createLauncher();

		execFileSuccess();
		delete process.env.OPENAI_API_KEY;

		expect(launcher.resolveWorkerOpenAiApiKey()).toBeUndefined();
		const args = await launcher.buildDockerRunArgs("worker-1", LEGACY_TEMPLATE);
		expect(args.some((arg) => arg.startsWith("OPENAI_API_KEY="))).toBe(false);
	});

	it("skips the host-gateway add-host when sharing the control-plane network namespace", async () => {
		const launcher = createLauncher({ workerDockerNetworkMode: "container:yolomatic" });

		execFileSuccess();

		const args = await launcher.buildDockerRunArgs("worker-1", LEGACY_TEMPLATE);
		expect(args).toContain("--network");
		expect(args).toContain("container:yolomatic");
		expect(args).not.toContain("--add-host");
	});

	it("forwards YOLO_WORKER_INIT_* env vars when present", async () => {
		process.env.YOLO_WORKER_INIT_SCRIPT = "scripts/bootstrap.sh";
		process.env.YOLO_WORKER_INIT_SKIP = "0";
		process.env.YOLO_WORKER_INIT_TIMEOUT_SECONDS = "600";

		const launcher = createLauncher();

		execFileSuccess();

		const args = await launcher.buildDockerRunArgs("worker-1", LEGACY_TEMPLATE);
		expect(args).toContain("YOLO_WORKER_INIT_SCRIPT=scripts/bootstrap.sh");
		expect(args).toContain("YOLO_WORKER_INIT_SKIP=0");
		expect(args).toContain("YOLO_WORKER_INIT_TIMEOUT_SECONDS=600");
	});

	it("omits YOLO_WORKER_INIT_* env vars when absent", async () => {
		const launcher = createLauncher();

		execFileSuccess();

		const args = await launcher.buildDockerRunArgs("worker-1", LEGACY_TEMPLATE);
		expect(args.some((arg) => arg.startsWith("YOLO_WORKER_INIT_"))).toBe(false);
	});

	describe("resolveTemplate", () => {
		it("prefers a per-repo template resolver", () => {
			const launcher = createLauncher({
				defaultWorkerTemplate: "node",
				resolveWorkerTemplate: () => "python",
			});
			expect(launcher.resolveTemplate("mbrooks", "yolomatic")).toMatchObject({
				id: "python",
				image: "yolomatic-worker-python:latest",
			});
		});

		it("falls back to the default worker template when no override resolves", () => {
			const launcher = createLauncher({ defaultWorkerTemplate: "node" });
			expect(launcher.resolveTemplate("mbrooks", "yolomatic")).toMatchObject({
				id: "node",
				image: "yolomatic-worker-node:latest",
			});
			expect(launcher.resolveTemplate()).toMatchObject({ id: "node" });
		});

		it("uses the legacy worker image when the requested template is unknown", () => {
			const launcher = createLauncher({
				defaultWorkerTemplate: "missing",
				workerImage: "legacy:latest",
			});
			expect(launcher.resolveTemplate()).toMatchObject({ id: "legacy", image: "legacy:latest" });
		});

		it("falls back to the installed default template when nothing else resolves", () => {
			const launcher = createLauncher({ defaultWorkerTemplate: "missing" });
			expect(launcher.resolveTemplate()).toMatchObject({
				id: "node",
				image: "yolomatic-worker-node:latest",
			});
		});
	});

	describe("container and workspace naming", () => {
		it("prefixes refinement container names with yolomatic-refinement", () => {
			const launcher = createLauncher();
			const state = { owner: "mbrooks", repo: "yolomatic", issueNumber: 7 } as never;
			expect(launcher.buildContainerName(state as never, "issue-refinement")).toBe(
				"yolomatic-refinement-mbrooks-yolomatic-7",
			);
			expect(launcher.buildContainerName(state as never)).toBe("yolomatic-session-mbrooks-yolomatic-7");
		});

		it("sanitizes characters outside the docker name alphabet", () => {
			const launcher = createLauncher();
			const state = { owner: "mbrooks", repo: "org/repo sub", issueNumber: 8 } as never;
			expect(launcher.buildContainerName(state as never)).toBe("yolomatic-session-mbrooks-org-repo-sub-8");
		});

		it("resolves worker workspace paths under the mount root", () => {
			const launcher = createLauncher();
			expect(launcher.getWorkerWorkspacesDir()).toBe("/workspaces");
			expect(
				launcher.resolveWorkerWorkspacePath("/workspaces/mbrooks/yolomatic/.worktrees/issue-1"),
			).toBe("/workspaces/mbrooks/yolomatic/.worktrees/issue-1");
		});

		it("rejects workspace paths outside the mount root", () => {
			const launcher = createLauncher();
			expect(() => launcher.resolveWorkerWorkspacePath("/other/place")).toThrow(
				"outside configured WORKSPACES_DIR",
			);
			expect(() => launcher.resolveWorkerWorkspacePath("/workspaces/../escape")).toThrow(
				"outside configured WORKSPACES_DIR",
			);
		});
	});

	describe("validateLaunch", () => {
		let workspaceRoot: string;

		afterEach(async () => {
			if (workspaceRoot) {
				await rm(workspaceRoot, { recursive: true, force: true });
				workspaceRoot = "" as unknown as string;
			}
		});

		it("rejects a workspace path that does not exist", async () => {
			const launcher = createLauncher();
			await expect(launcher.validateLaunch("/workspaces/missing")).rejects.toThrow();
		});

		it("allows a workspace whose origin remote is credential-free", async () => {
			workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "yolomatic-launcher-"));
			const workspacePath = path.join(workspaceRoot, "ws");
			await mkdir(workspacePath, { recursive: true });
			execFileMock.mockImplementation((_cmd, args, _options, callback) => {
				if (args[0] === "remote" && args[1] === "get-url") {
					callback(null, "https://github.com/mbrooks/yolomatic.git\n", "");
					return;
				}
				callback(new Error("unexpected"), "", "");
			});

			const launcher = createLauncher();
			await expect(launcher.validateLaunch(workspacePath)).resolves.toBeUndefined();
		});

		it("refuses a workspace whose origin remote contains credentials", async () => {
			workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "yolomatic-launcher-"));
			const workspacePath = path.join(workspaceRoot, "ws");
			await mkdir(workspacePath, { recursive: true });
			execFileMock.mockImplementation((_cmd, args, _options, callback) => {
				if (args[0] === "remote" && args[1] === "get-url") {
					callback(null, "https://x-access-token:ghp_secret@github.com/mbrooks/yolomatic.git\n", "");
					return;
				}
				callback(new Error("unexpected"), "", "");
			});

			const launcher = createLauncher();
			await expect(launcher.validateLaunch(workspacePath)).rejects.toThrow(/remote origin URL contains credentials/);
		});

		it("allows a workspace without an origin remote", async () => {
			workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "yolomatic-launcher-"));
			const workspacePath = path.join(workspaceRoot, "ws");
			await mkdir(workspacePath, { recursive: true });
			execFileMock.mockImplementation((_cmd, args, _options, callback) => {
				if (args[0] === "remote" && args[1] === "get-url") {
					callback(new Error("no origin remote"), "", "");
					return;
				}
				callback(new Error("unexpected"), "", "");
			});

			const launcher = createLauncher();
			await expect(launcher.validateLaunch(workspacePath)).resolves.toBeUndefined();
		});
	});

	describe("resolveWorkerOllamaHost", () => {
		it("prefers the explicit worker host option", () => {
			process.env.OLLAMA_HOST = "http://127.0.0.1:11434";
			const launcher = createLauncher({
				workerOllamaHost: "http://custom-host:11434",
				workerDockerNetworkMode: "bridge",
			});
			expect(launcher.resolveWorkerOllamaHost()).toBe("http://custom-host:11434");
		});

		it("returns undefined when no host is configured", () => {
			const launcher = createLauncher();
			expect(launcher.resolveWorkerOllamaHost()).toBeUndefined();
		});

		it("passes a non-URL value through unchanged", () => {
			process.env.OLLAMA_HOST = "not-a-url";
			const launcher = createLauncher();
			expect(launcher.resolveWorkerOllamaHost()).toBe("not-a-url");
		});

		it("translates loopback hosts to host.docker.internal", () => {
			process.env.OLLAMA_HOST = "http://127.0.0.1:11434";
			const launcher = createLauncher();
			expect(launcher.resolveWorkerOllamaHost()).toBe("http://host.docker.internal:11434/");
		});

		it("keeps loopback hosts when sharing the control-plane network namespace", () => {
			process.env.OLLAMA_HOST = "http://127.0.0.1:11434";
			const launcher = createLauncher({ workerDockerNetworkMode: "container:yolomatic" });
			expect(launcher.resolveWorkerOllamaHost()).toBe("http://127.0.0.1:11434/");
		});
	});

	describe("image builds", () => {
		it("builds the legacy image with --target worker", async () => {
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

			const launcher = createLauncher({ workerImage: "legacy:latest" });
			await launcher.ensureWorkerImage(launcher.resolveTemplate(), "session-1");

			expect(execFileMock).toHaveBeenCalledWith(
				"docker",
				["build", "--target", "worker", "--label", "io.yolomatic.worker.transport=websocket-v1", "-t", "legacy:latest", "/repo"],
				expect.any(Object),
				expect.any(Function),
			);
		});

		it("builds the base image before a project template image", async () => {
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

			const launcher = createLauncher({ defaultWorkerTemplate: "node" });
			await launcher.ensureWorkerImage(launcher.resolveTemplate(), "session-1");

			const builtImages = execFileMock.mock.calls
				.filter((call) => call[1][0] === "build")
				.map((call) => call[1][call[1].indexOf("-t") + 1]);
			expect(builtImages).toEqual(["yolomatic-worker-base:latest", "yolomatic-worker-node:latest"]);
		});

		it("reuses the cached build while the image still exists", async () => {
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

			const launcher = createLauncher({ workerImage: "legacy:latest" });
			const template = launcher.resolveTemplate();
			await launcher.ensureWorkerImage(template, "session-1");
			await launcher.ensureWorkerImage(template, "session-2");

			expect(
				execFileMock.mock.calls.filter((call) => call[1][0] === "build"),
			).toHaveLength(1);
		});

		it("rebuilds when the cached image was pruned", async () => {
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

			const launcher = createLauncher({ workerImage: "legacy:latest" });
			const template = launcher.resolveTemplate();
			await launcher.ensureWorkerImage(template, "session-1");
			images.delete("legacy:latest");
			await launcher.ensureWorkerImage(template, "session-2");

			expect(
				execFileMock.mock.calls.filter((call) => call[1][0] === "build"),
			).toHaveLength(2);
		});

		it("stops revalidating a template image after three cache replacements", async () => {
			const launcher = createLauncher({ defaultWorkerTemplate: "node" });
			const template = launcher.resolveTemplate();
			let inspections = 0;
			(launcher as unknown as { imageReady: Map<string, Promise<void>> }).imageReady.set(template.id, Promise.resolve());
			execFileMock.mockImplementation((_cmd, args, _options, callback) => {
				if (args[0] === "image" && args[1] === "inspect") {
					inspections += 1;
					if (inspections <= 3) {
						// Simulate another concurrent request replacing the cached promise
						// before this request can invalidate the stale entry.
						(launcher as unknown as { imageReady: Map<string, Promise<void>> }).imageReady.set(
							template.id,
							Promise.resolve(),
						);
						callback(new Error(`No such image: ${args[2]}`), "", "");
						return;
					}
					callback(null, "[]", "");
					return;
				}
				callback(null, "", "");
			});

			await expect(launcher.ensureWorkerImage(template, "session-1")).rejects.toThrow(
				"Worker image yolomatic-worker-node:latest remained unavailable after 3 cache revalidation attempts.",
			);
			expect(inspections).toBe(3);
		});

		it("reuses the cached base image while it exists and rebuilds when pruned", async () => {
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

			const launcher = createLauncher();
			await launcher.ensureWorkerBaseImage();
			await launcher.ensureWorkerBaseImage();
			expect(
				execFileMock.mock.calls.filter((call) => call[1][0] === "build"),
			).toHaveLength(1);

			images.delete("yolomatic-worker-base:latest");
			await launcher.ensureWorkerBaseImage();
			expect(
				execFileMock.mock.calls.filter((call) => call[1][0] === "build"),
			).toHaveLength(2);
		});

		it("stops revalidating the base image after three cache replacements", async () => {
			const launcher = createLauncher();
			(launcher as unknown as { baseImageReady: Promise<void> | undefined }).baseImageReady = Promise.resolve();
			let inspections = 0;
			execFileMock.mockImplementation((_cmd, args, _options, callback) => {
				if (args[0] === "image" && args[1] === "inspect") {
					inspections += 1;
					if (inspections <= 3) {
						(launcher as unknown as { baseImageReady: Promise<void> | undefined }).baseImageReady =
							Promise.resolve();
						callback(new Error(`No such image: ${args[2]}`), "", "");
						return;
					}
					callback(null, "[]", "");
					return;
				}
				callback(null, "", "");
			});

			await expect(launcher.ensureWorkerBaseImage()).rejects.toThrow(
				"Worker base image yolomatic-worker-base:latest remained unavailable after 3 cache revalidation attempts.",
			);
			expect(inspections).toBe(3);
		});

		it("logs a prebuild success for the default template", async () => {
			execFileSuccess();
			const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			try {
				const launcher = createLauncher({ defaultWorkerTemplate: "node" });
				await launcher.prebuildWorkerImage();
				expect(stdoutSpy).toHaveBeenCalledWith("[startup] prebuilding worker image...\n");
				expect(stdoutSpy).toHaveBeenCalledWith("[startup] worker image prebuilt successfully\n");
			} finally {
				stdoutSpy.mockRestore();
			}
		});

		it("logs a prebuild failure and clears the build cache", async () => {
			execFileMock.mockImplementationOnce((_cmd, _args, _options, callback) =>
				callback(new Error("prebuild failed"), "", ""),
			);
			const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			try {
				const launcher = createLauncher({ defaultWorkerTemplate: "node" });
				await expect(launcher.prebuildWorkerImage()).resolves.toBeUndefined();
				expect(stdoutSpy).toHaveBeenCalledWith("[startup] worker image prebuild failed: prebuild failed\n");
				expect(
					(launcher as unknown as { imageReady: Map<string, Promise<void>> }).imageReady.size,
				).toBe(0);
			} finally {
				stdoutSpy.mockRestore();
			}
		});
	});

	describe("mount specs", () => {
		it("uses a bind mount for absolute sources and a volume otherwise", () => {
			const launcher = createLauncher();
			const buildMountSpec = (
				launcher as unknown as { buildMountSpec: (source: string, target: string) => string }
			).buildMountSpec.bind(launcher);
			expect(buildMountSpec("/abs/source", "/workspaces")).toBe("type=bind,src=/abs/source,dst=/workspaces");
			expect(buildMountSpec("named-volume", "/workspaces")).toBe("type=volume,src=named-volume,dst=/workspaces");
		});

		it("returns an absolute configured source without docker inspection", async () => {
			execFileSuccess();
			const launcher = createLauncher({ workerWorkspaceMountSource: "/data/workspaces" });
			expect(await launcher.resolveWorkerWorkspaceMountSource()).toBe("/data/workspaces");
			expect(execFileMock).not.toHaveBeenCalled();
		});

		it("returns the configured source when HOSTNAME is unset", async () => {
			execFileSuccess();
			const launcher = createLauncher({ workerWorkspaceMountSource: "workspaces" });
			expect(await launcher.resolveWorkerWorkspaceMountSource()).toBe("workspaces");
			expect(execFileMock).not.toHaveBeenCalled();
		});

		it("resolves the workspace volume by container self-inspection", async () => {
			process.env.HOSTNAME = "control-plane-container";
			execFileMock.mockImplementation((_cmd, args, _options, callback) => {
				if (args[0] === "inspect" && args[1] === "--format") {
					callback(
						null,
						JSON.stringify([
							{ Destination: "/workspaces", Type: "volume", Name: "ws-volume" },
						]),
						"",
					);
					return;
				}
				callback(null, "", "");
			});

			const launcher = createLauncher({ workerWorkspaceMountSource: "workspaces" });
			expect(await launcher.resolveWorkerWorkspaceMountSource()).toBe("ws-volume");
		});

		it("resolves a bind-mount source by container self-inspection", async () => {
			process.env.HOSTNAME = "control-plane-container";
			execFileMock.mockImplementation((_cmd, args, _options, callback) => {
				if (args[0] === "inspect" && args[1] === "--format") {
					callback(
						null,
						JSON.stringify([
							{ Destination: "/workspaces", Type: "bind", Source: "/host/data/workspaces" },
						]),
						"",
					);
					return;
				}
				callback(null, "", "");
			});

			const launcher = createLauncher({ workerWorkspaceMountSource: "workspaces" });
			expect(await launcher.resolveWorkerWorkspaceMountSource()).toBe("/host/data/workspaces");
		});

		it("falls back to the configured source when self-inspection fails", async () => {
			process.env.HOSTNAME = "control-plane-container";
			execFileMock.mockImplementation((_cmd, args, _options, callback) => {
				if (args[0] === "inspect" && args[1] === "--format") {
					callback(new Error("docker not available"), "", "");
					return;
				}
				callback(null, "", "");
			});

			const launcher = createLauncher({ workerWorkspaceMountSource: "workspaces" });
			expect(await launcher.resolveWorkerWorkspaceMountSource()).toBe("workspaces");
		});
	});

	describe("launchContainer", () => {
		it("spawns docker with the plan and captures streamed output", () => {
			const child = makeChild();
			spawnMock.mockReturnValue(child);
			const launcher = createLauncher();
			const plan = {
				containerName: "worker-1",
				args: ["run", "--rm", "--name", "worker-1", "worker:latest"],
				env: { PATH: "/usr/bin" },
				cwd: "/repo",
			};

			const handle = launcher.launchContainer(plan, "session-1", LEGACY_TEMPLATE);

			expect(spawnMock).toHaveBeenCalledWith("docker", plan.args, {
				cwd: "/repo",
				env: { PATH: "/usr/bin" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"session-1",
				expect.objectContaining({ message: "Launching worker container worker-1" }),
			);

			child.stdout.emit("data", Buffer.from("out"));
			child.stderr.emit("data", Buffer.from("err"));
			expect(handle.getOutputTail()).toBe("err\nout");
		});

		it("rejects the exit promise when the container exits before the session settles", async () => {
			const child = makeChild();
			spawnMock.mockReturnValue(child);
			const launcher = createLauncher();
			const plan = { containerName: "worker-1", args: [], env: {}, cwd: "/repo" };

			const handle = launcher.launchContainer(plan, "session-1", LEGACY_TEMPLATE);
			child.stderr.emit("data", Buffer.from("boom"));
			child.emit("exit", 125, null);

			await expect(handle.dockerExitPromise).rejects.toThrow(
				"Worker container exited before completion (code=125, signal=null).\nboom",
			);
		});

		it("ignores docker exit after the session is settled", async () => {
			const child = makeChild();
			spawnMock.mockReturnValue(child);
			const launcher = createLauncher();
			const plan = { containerName: "worker-1", args: [], env: {}, cwd: "/repo" };

			const handle = launcher.launchContainer(plan, "session-1", LEGACY_TEMPLATE);
			handle.markSettled();
			child.emit("exit", 0, null);

			let rejected = false;
			void handle.dockerExitPromise.then(
				() => undefined,
				() => {
					rejected = true;
				},
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(rejected).toBe(false);
		});

		it("rejects the exit promise when docker cannot be spawned", async () => {
			const child = makeChild();
			spawnMock.mockReturnValue(child);
			const launcher = createLauncher();
			const plan = { containerName: "worker-1", args: [], env: {}, cwd: "/repo" };

			const handle = launcher.launchContainer(plan, "session-1", LEGACY_TEMPLATE);
			child.emit("error", new Error("docker missing"));

			await expect(handle.dockerExitPromise).rejects.toThrow("docker missing");
		});

		it("keeps only the last 4000 characters of streamed output", () => {
			const child = makeChild();
			spawnMock.mockReturnValue(child);
			const launcher = createLauncher();
			const plan = { containerName: "worker-1", args: [], env: {}, cwd: "/repo" };

			const handle = launcher.launchContainer(plan, "session-1", LEGACY_TEMPLATE);
			child.stdout.emit("data", Buffer.from("a".repeat(5000)));
			expect(handle.getOutputTail().length).toBe(4000);
			expect(handle.getOutputTail()).toContain("aaaa");
		});

		it("appendOutput truncates accumulated chunks at 4000 characters", () => {
			const launcher = createLauncher();
			expect(launcher.appendOutput("a".repeat(3990), "b".repeat(50))).toHaveLength(4000);
		});
	});

	describe("runWithNameConflictRetry", () => {
		it("removes a stopped conflicting container and retries the launch", async () => {
			execFileMock.mockImplementation((_cmd, args, _options, callback) => {
				if (args[0] === "inspect") {
					callback(null, "exited\n", "");
					return;
				}
				callback(null, "", "");
			});

			const launcher = createLauncher();
			let attempts = 0;
			const result = await launcher.runWithNameConflictRetry("worker-1", "session-1", async () => {
				attempts += 1;
				if (attempts === 1) throw conflictingExitError();
				return "launched";
			});

			expect(result).toBe("launched");
			expect(attempts).toBe(2);
			expect(execFileMock).toHaveBeenCalledWith(
				"docker",
				["inspect", "--format", "{{.State.Status}}", "worker-1"],
				expect.any(Object),
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenCalledWith(
				"docker",
				["rm", "worker-1"],
				expect.any(Object),
				expect.any(Function),
			);
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"session-1",
				expect.objectContaining({
					message: "Removed stopped conflicting worker container worker-1; retrying launch",
				}),
			);
		});

		it("refuses to remove a conflicting container that is still running", async () => {
			execFileMock.mockImplementation((_cmd, args, _options, callback) => {
				if (args[0] === "inspect") {
					callback(null, "running\n", "");
					return;
				}
				callback(null, "", "");
			});

			const launcher = createLauncher();
			let attempts = 0;
			await expect(
				launcher.runWithNameConflictRetry("worker-1", "session-1", async () => {
					attempts += 1;
					throw conflictingExitError();
				}),
			).rejects.toThrow("already in use");
			expect(attempts).toBe(1);
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"session-1",
				expect.objectContaining({
					message: "Conflicting worker container worker-1 is running; refusing to remove it",
				}),
			);
		});

		it("does not retry when the conflicting container cannot be inspected", async () => {
			execFileMock.mockImplementation((_cmd, args, _options, callback) => {
				if (args[0] === "inspect") {
					callback(new Error("inspect failed"), "", "");
					return;
				}
				callback(null, "", "");
			});

			const launcher = createLauncher();
			let attempts = 0;
			await expect(
				launcher.runWithNameConflictRetry("worker-1", "session-1", async () => {
					attempts += 1;
					throw conflictingExitError();
				}),
			).rejects.toThrow("already in use");
			expect(attempts).toBe(1);
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"session-1",
				expect.objectContaining({
					message: "Could not inspect conflicting worker container worker-1",
				}),
			);
		});

		it("does not retry when the stopped conflicting container cannot be removed", async () => {
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

			const launcher = createLauncher();
			let attempts = 0;
			await expect(
				launcher.runWithNameConflictRetry("worker-1", "session-1", async () => {
					attempts += 1;
					throw conflictingExitError();
				}),
			).rejects.toThrow("already in use");
			expect(attempts).toBe(1);
			expect(recordSessionLogMock).toHaveBeenCalledWith(
				"session-1",
				expect.objectContaining({
					message: "Could not remove stopped conflicting worker container worker-1",
				}),
			);
		});

		it("gives up after three recovered retries", async () => {
			execFileMock.mockImplementation((_cmd, args, _options, callback) => {
				if (args[0] === "inspect") {
					callback(null, "exited\n", "");
					return;
				}
				callback(null, "", "");
			});

			const launcher = createLauncher();
			let attempts = 0;
			await expect(
				launcher.runWithNameConflictRetry("worker-1", "session-1", async () => {
					attempts += 1;
					throw conflictingExitError();
				}),
			).rejects.toThrow("Worker container launch failed after 4 attempts (3 retries).");
			expect(attempts).toBe(4);
		});

		it("rethrows non-conflict errors without retrying", async () => {
			const launcher = createLauncher();
			let attempts = 0;
			const error = new Error("generic launch failure");
			await expect(
				launcher.runWithNameConflictRetry("worker-1", "session-1", async () => {
					attempts += 1;
					throw error;
				}),
			).rejects.toThrow("generic launch failure");
			expect(attempts).toBe(1);
		});
	});
});