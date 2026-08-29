import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
	execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: execFileMock,
	spawn: vi.fn(),
}));

import { DockerWorkerLauncher } from "./docker-worker-launcher.js";

describe("DockerWorkerLauncher", () => {
	afterEach(() => {
		vi.clearAllMocks();
		delete process.env.HOSTNAME;
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

		execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, "", ""));

		const plan = await launcher.createLaunchPlan({
			sessionKey: "session-123",
			workerSessionUrl: "ws://control-plane.test/rpc?sessionKey=session-123&token=token-1",
			containerName: "yolomatic-session-x",
			workerTemplate: { id: "legacy", label: "Legacy", image: "worker:latest", dockerfile: "Dockerfile" },
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

		const launcher = new DockerWorkerLauncher({
			projectRoot: "/repo",
			workspacesDir: "/workspaces",
			workerWorkspaceMountSource: "workspaces",
			soulPath: "/repo/SOUL.md",
		});

		const first = await launcher.resolveWorkerWorkspaceMountSource();
		const second = await launcher.resolveWorkerWorkspaceMountSource();

		expect(first).toBe("ws-volume");
		expect(second).toBe("ws-volume");
		expect(
			execFileMock.mock.calls.filter((call) => call[0] === "docker" && call[1][0] === "inspect").length,
		).toBe(1);
	});
});
