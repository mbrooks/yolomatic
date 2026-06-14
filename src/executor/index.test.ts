import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	AuthStorage: { create: vi.fn() },
	createAgentSession: vi.fn(),
	DefaultResourceLoader: vi.fn(() => ({ reload: vi.fn() })),
	getAgentDir: vi.fn(() => "/agent"),
	SessionManager: { open: vi.fn() },
}));

vi.mock("./model-registry.js", () => ({
	createTarsModelRegistry: vi.fn(),
}));

vi.mock("../logging/llm-logger.js", () => ({
	LlmLogger: vi.fn(() => ({
		logPrompt: vi.fn(),
		logThought: vi.fn(),
		logToolCall: vi.fn(),
		logToolResult: vi.fn(),
		logResponse: vi.fn(),
		logError: vi.fn(),
	})),
}));

vi.mock("../logging/session-log-store.js", () => ({
	recordSessionLog: vi.fn(),
}));

import { PiAgentExecutor } from "./index.js";

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createTarsModelRegistry } from "./model-registry.js";

describe("PiAgentExecutor", () => {
	afterEach(() => {
		delete process.env.PI_AGENT_MODEL;
		delete process.env.PI_AGENT_PROVIDER;
		vi.restoreAllMocks();
	});

	function makeState(issueNumber = 1) {
		return {
			issueNumber,
			repo: "tars",
			owner: "mbrooks",
			title: "Test",
			body: "Body",
			status: "pending" as const,
			sessionPath: "/tmp/session",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};
	}

	async function makeSoulPath() {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-executor-"));
		const soulPath = path.join(dir, "SOUL.md");
		await writeFile(soulPath, "SOUL content", "utf-8");
		return soulPath;
	}

	function mockRegistry(models: Array<{ provider: string; id: string }> = []) {
		return {
			find: vi.fn((provider: string, modelId: string) => models.find((model) => model.provider === provider && model.id === modelId)),
			getAll: vi.fn(() => models),
		};
	}

	function mockSuccessfulSession(content = "TARS_STATUS: complete\nDone.") {
		const unsubscribe = vi.fn();
		const mockSession = {
			subscribe: vi.fn(() => unsubscribe),
			prompt: vi.fn(),
			messages: [
				{ role: "assistant", content },
			],
		};
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });
		return { mockSession, unsubscribe };
	}

	it("constructor stores soulPath", () => {
		const executor = new PiAgentExecutor({ soulPath: "/tmp/SOUL.md" });
		expect(executor).toBeInstanceOf(PiAgentExecutor);
	});

	it("executes end-to-end with mocked Pi dependencies", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-executor-"));
		const soulPath = path.join(dir, "SOUL.md");
		await writeFile(soulPath, "SOUL content", "utf-8");

		const unsubscribe = vi.fn();
		let subscribeCallback: ((event: unknown) => void) | undefined;
		const mockSession = {
			subscribe: vi.fn((cb: (event: unknown) => void) => {
				subscribeCallback = cb;
				return unsubscribe;
			}),
			prompt: vi.fn(),
			messages: [
				{ role: "assistant", content: "TARS_STATUS: complete\nDone." },
			],
		};

		const mockRegistry = {
			find: vi.fn(),
			getAll: vi.fn(() => []),
		};

		(createTarsModelRegistry as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const state = {
			issueNumber: 1,
			repo: "tars",
			owner: "mbrooks",
			title: "Test",
			body: "Body",
			status: "pending" as const,
			sessionPath: "/tmp/session",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		const result = await executor.execute(state);
		expect(result.status).toBe("complete");
		expect(result.summary).toBe("Done.");
		expect(mockSession.subscribe).toHaveBeenCalledOnce();
		expect(unsubscribe).toHaveBeenCalledOnce();

		// Cover event handler branches
		if (subscribeCallback) {
			subscribeCallback({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_end", content: "thought" },
			});
			subscribeCallback({ type: "tool_execution_start", toolName: "read", args: {} });
			subscribeCallback({ type: "tool_execution_end", toolName: "read", result: "ok" });
			subscribeCallback({ type: "auto_retry_start", errorMessage: "err", attempt: 1, maxAttempts: 3 });
			subscribeCallback({ type: "auto_retry_end", success: false, finalError: "failed" });
		}
	});

	it("logs and rethrows when session.prompt throws", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-executor-"));
		const soulPath = path.join(dir, "SOUL.md");
		await writeFile(soulPath, "SOUL content", "utf-8");

		const unsubscribe = vi.fn();
		const mockSession = {
			subscribe: vi.fn(() => unsubscribe),
			prompt: vi.fn(async () => {
				throw new Error("prompt failed");
			}),
			messages: [],
		};

		const mockRegistry = {
			find: vi.fn(),
			getAll: vi.fn(() => []),
		};

		(createTarsModelRegistry as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const state = {
			issueNumber: 2,
			repo: "tars",
			owner: "mbrooks",
			title: "Test",
			body: "Body",
			status: "pending" as const,
			sessionPath: "/tmp/session",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		await expect(executor.execute(state)).rejects.toThrow("prompt failed");
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("throws FatalSystemError when a fatal tool error is detected", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-executor-"));
		const soulPath = path.join(dir, "SOUL.md");
		await writeFile(soulPath, "SOUL content", "utf-8");

		const unsubscribe = vi.fn();
		let subscribeCallback: ((event: unknown) => void) | undefined;
		const abort = vi.fn();
		const mockSession = {
			subscribe: vi.fn((cb: (event: unknown) => void) => {
				subscribeCallback = cb;
				return unsubscribe;
			}),
			prompt: vi.fn(async () => {
				subscribeCallback?.({
					type: "tool_execution_end",
					toolName: "bash",
					result: { output: "npm ERR! code EACCES\nnpm ERR! syscall mkdir", exitCode: 1 },
					isError: true,
				});
			}),
			abort,
			messages: [],
		};

		const mockRegistry = {
			find: vi.fn(),
			getAll: vi.fn(() => []),
		};

		(createTarsModelRegistry as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const state = {
			issueNumber: 3,
			repo: "tars",
			owner: "mbrooks",
			title: "Test",
			body: "Body",
			status: "pending" as const,
			sessionPath: "/tmp/session",
			workspacePath: dir,
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		await expect(executor.execute(state)).rejects.toThrow(/Fatal system error: permission_denied/);
		expect(abort).toHaveBeenCalled();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("returns cancelled when abort signal is already aborted", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-executor-"));
		const soulPath = path.join(dir, "SOUL.md");
		await writeFile(soulPath, "SOUL content", "utf-8");
		(createTarsModelRegistry as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry());
		mockSuccessfulSession();

		const executor = new PiAgentExecutor({ soulPath });
		const state = {
			issueNumber: 4,
			repo: "tars",
			owner: "mbrooks",
			title: "Test",
			body: "Body",
			status: "pending" as const,
			sessionPath: "/tmp/session",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		const controller = new AbortController();
		controller.abort();
		const result = await executor.execute(state, undefined, undefined, controller.signal);
		expect(result.status).toBe("cancelled");
		expect(result.summary).toBe("Task cancelled before execution started.");
	});

	it("returns failed when assistant message contains a 429 rate-limit error", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-executor-"));
		const soulPath = path.join(dir, "SOUL.md");
		await writeFile(soulPath, "SOUL content", "utf-8");

		const unsubscribe = vi.fn();
		const mockSession = {
			subscribe: vi.fn(() => unsubscribe),
			prompt: vi.fn(),
			messages: [
				{ role: "assistant", content: "TARS_STATUS: working\nStill going.", errorMessage: '429 "you have reached your weekly usage limit"' },
			],
		};

		const mockRegistry = {
			find: vi.fn(),
			getAll: vi.fn(() => []),
		};

		(createTarsModelRegistry as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const state = {
			issueNumber: 6,
			repo: "tars",
			owner: "mbrooks",
			title: "Test",
			body: "Body",
			status: "pending" as const,
			sessionPath: "/tmp/session",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		const result = await executor.execute(state);
		expect(result.status).toBe("failed");
		expect(result.summary).toContain("429");
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("returns cancelled when abort signal fires during execution", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-executor-"));
		const soulPath = path.join(dir, "SOUL.md");
		await writeFile(soulPath, "SOUL content", "utf-8");

		const unsubscribe = vi.fn();
		const abort = vi.fn();
		const mockSession = {
			subscribe: vi.fn(() => unsubscribe),
			prompt: vi.fn(async () => {
				controller.abort();
				throw new Error("abort error");
			}),
			abort,
			messages: [],
		};

		const mockRegistry = {
			find: vi.fn(),
			getAll: vi.fn(() => []),
		};

		(createTarsModelRegistry as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const state = {
			issueNumber: 5,
			repo: "tars",
			owner: "mbrooks",
			title: "Test",
			body: "Body",
			status: "pending" as const,
			sessionPath: "/tmp/session",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		const controller = new AbortController();
		const result = await executor.execute(state, undefined, undefined, controller.signal);
		expect(result.status).toBe("cancelled");
		expect(result.summary).toBe("Task cancelled by admin.");
		expect(abort).toHaveBeenCalled();
	});

	it("uses an override prompt and passes the configured model into Pi", async () => {
		const soulPath = await makeSoulPath();
		const configuredModel = { provider: "ollama", id: "kimi-k2.7-code:cloud" };
		(createTarsModelRegistry as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry([configuredModel]));
		const { mockSession } = mockSuccessfulSession();
		process.env.PI_AGENT_MODEL = "kimi-k2.7-code:cloud";
		const onSessionCreated = vi.fn();

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(7), undefined, undefined, undefined, onSessionCreated, "custom prompt");

		expect(result.status).toBe("complete");
		expect(mockSession.prompt).toHaveBeenCalledWith("custom prompt");
		expect(onSessionCreated).toHaveBeenCalledWith(mockSession);
		expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ model: configuredModel }));
	});

	it("builds feedback and PR review prompts for continued sessions", async () => {
		const soulPath = await makeSoulPath();
		(createTarsModelRegistry as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry());
		const feedbackSession = mockSuccessfulSession().mockSession;
		const executor = new PiAgentExecutor({ soulPath });

		await executor.execute(makeState(8), "Please retry.");
		expect(feedbackSession.prompt).toHaveBeenCalledWith(expect.stringContaining("Human feedback received"));

		const reviewSession = mockSuccessfulSession().mockSession;
		await executor.execute(makeState(9), undefined, { comments: [], reviewBody: "Please add tests" });
		expect(reviewSession.prompt).toHaveBeenCalledWith(expect.stringContaining("PR review feedback received"));
	});

	it("warns when PI_AGENT_MODEL is configured but cannot be resolved", async () => {
		const soulPath = await makeSoulPath();
		(createTarsModelRegistry as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry());
		mockSuccessfulSession();
		process.env.PI_AGENT_MODEL = "missing-model";
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const executor = new PiAgentExecutor({ soulPath });
		await executor.execute(makeState(10));

		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("PI_AGENT_MODEL=missing-model did not resolve"));
	});

	it("logs non-rate assistant errors without overriding the parsed result", async () => {
		const soulPath = await makeSoulPath();
		(createTarsModelRegistry as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry());
		const unsubscribe = vi.fn();
		const mockSession = {
			subscribe: vi.fn(() => unsubscribe),
			prompt: vi.fn(),
			messages: [
				{ role: "assistant", content: "TARS_STATUS: complete\nDone.", errorMessage: "tool failed", stopReason: "error" },
			],
		};
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(11));

		expect(result.status).toBe("complete");
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("logs assistant error stop reasons without a message", async () => {
		const soulPath = await makeSoulPath();
		(createTarsModelRegistry as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry());
		const unsubscribe = vi.fn();
		const mockSession = {
			subscribe: vi.fn(() => unsubscribe),
			prompt: vi.fn(),
			messages: [
				{ role: "assistant", content: "TARS_STATUS: working\nRetrying.", stopReason: "error" },
			],
		};
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(12));

		expect(result.status).toBe("working");
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});
