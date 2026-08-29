import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	createAgentSession: vi.fn(),
	DefaultResourceLoader: vi.fn(function () {
		return { reload: vi.fn() };
	}),
	getAgentDir: vi.fn(() => "/agent"),
	SessionManager: { open: vi.fn() },
}));

vi.mock("./model-registry.js", () => ({
	createYolomaticModelRegistry: vi.fn(async () => ({
		runtime: { getModel: vi.fn(), getModels: vi.fn(() => []) },
		find: vi.fn(),
		getAll: vi.fn(() => []),
	})),
}));

vi.mock("../logging/llm-logger.js", () => ({
	LlmLogger: vi.fn(function () {
		return {
			logPrompt: vi.fn(),
			logThought: vi.fn(),
			logToolCall: vi.fn(),
			logToolResult: vi.fn(),
			logResponse: vi.fn(),
			logError: vi.fn(),
			logModel: vi.fn(),
		};
	}),
}));

vi.mock("../logging/session-log-store.js", () => ({
	recordSessionLog: vi.fn(),
}));

import { PiAgentExecutor, preferTrustedExtension } from "./index.js";

import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createYolomaticModelRegistry } from "./model-registry.js";
import { recordSessionLog } from "../logging/session-log-store.js";
import { LlmLogger } from "../logging/llm-logger.js";

describe("PiAgentExecutor", () => {
	afterEach(() => {
		delete process.env.PI_AGENT_MODEL;
		delete process.env.PI_AGENT_PROVIDER;
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	function makeState(issueNumber = 1) {
		return {
			issueNumber,
			repo: "yolomatic",
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
		const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-executor-"));
		const soulPath = path.join(dir, "SOUL.md");
		await writeFile(soulPath, "SOUL content", "utf-8");
		return soulPath;
	}

	function mockRegistry(models: Array<{ provider: string; id: string }> = []) {
		return {
			runtime: {
				getModel: vi.fn((provider: string, modelId: string) =>
					models.find((model) => model.provider === provider && model.id === modelId),
				),
				getModels: vi.fn(() => models),
			},
			find: vi.fn((provider: string, modelId: string) =>
				models.find((model) => model.provider === provider && model.id === modelId),
			),
			getAll: vi.fn(() => models),
		};
	}

	function mockSuccessfulSession(content = "YOLO_STATUS: complete\nDone.") {
		const unsubscribe = vi.fn();
		const mockSession = {
			subscribe: vi.fn(() => unsubscribe),
			prompt: vi.fn(),
			steer: vi.fn(),
			messages: [
				{ role: "assistant", content },
			],
		};
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });
		return { mockSession, unsubscribe };
	}

	function mockSequentialSession(responses: string[], onPromptCall?: (callIndex: number) => void) {
		const unsubscribe = vi.fn();
		const messages: Array<{ role: string; content: string }> = [];
		let callIndex = 0;
		const mockSession = {
			subscribe: vi.fn(() => unsubscribe),
			prompt: vi.fn(async () => {
				const current = callIndex;
				callIndex += 1;
				onPromptCall?.(current);
				const content = responses[current];
				if (content !== undefined) {
					messages.push({ role: "assistant", content });
				}
			}),
			steer: vi.fn(),
			abort: vi.fn(),
			get messages() {
				return messages;
			},
		};
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });
		return { mockSession, unsubscribe };
	}

	it("constructor stores soulPath", () => {
		const executor = new PiAgentExecutor({ soulPath: "/tmp/SOUL.md" });
		expect(executor).toBeInstanceOf(PiAgentExecutor);
	});

	it("prefers a trusted worker extension over stale workspace tools", () => {
		const extension = (extensionPath: string, resolvedPath: string, toolNames: string[]) => ({
			path: extensionPath,
			resolvedPath,
			tools: new Map(toolNames.map((toolName) => [toolName, {}])),
		});
		const trusted = extension(
			"/app/.pi/extensions/github-issues.ts",
			"/app/.pi/extensions/github-issues.ts",
			["github_fetch_issue", "github_fetch_pr"],
		);
		const staleWorkspaceCopy = extension(
			"/app/workspaces/repo/.pi/extensions/github-issues.ts",
			"/app/workspaces/repo/.pi/extensions/github-issues.ts",
			["github_fetch_issue", "github_fetch_pr"],
		);
		const unrelated = extension("/app/workspaces/repo/.pi/extensions/other.ts", "/other.ts", ["other_tool"]);
		const base = {
			extensions: [trusted, staleWorkspaceCopy, unrelated],
			errors: [
				{
					path: staleWorkspaceCopy.path,
					error: `Tool "github_fetch_issue" conflicts with ${trusted.path}`,
				},
				{ path: unrelated.path, error: "unrelated warning" },
			],
			runtime: {},
		} as never;

		const result = preferTrustedExtension(base, trusted.resolvedPath);

		expect(result.extensions).toEqual([trusted, unrelated]);
		expect(result.errors).toEqual([{ path: unrelated.path, error: "unrelated warning" }]);
	});

	it("leaves extensions unchanged when the trusted worker extension is unavailable", () => {
		const base = { extensions: [], errors: [], runtime: {} } as never;
		expect(preferTrustedExtension(base, "/missing/github-issues.ts")).toBe(base);
	});

	it("configures the trusted worker extension on the resource loader", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		mockSuccessfulSession();
		const trustedExtensionPath = "/app/.pi/extensions/github-issues.ts";
		const executor = new PiAgentExecutor({ soulPath, trustedExtensionPath });

		await executor.execute(makeState());

		const loaderOptions = (DefaultResourceLoader as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
			additionalExtensionPaths?: string[];
			extensionsOverride?: (base: never) => unknown;
		};
		expect(loaderOptions.additionalExtensionPaths).toEqual([trustedExtensionPath]);
		const base = { extensions: [], errors: [], runtime: {} } as never;
		expect(loaderOptions.extensionsOverride?.(base)).toBe(base);
	});

	it("executes end-to-end with mocked Pi dependencies", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-executor-"));
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
				{ role: "assistant", content: "YOLO_STATUS: complete\nDone." },
			],
		};

		const mockRegistry = {
			find: vi.fn(),
			getAll: vi.fn(() => []),
		};

		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const state = {
			issueNumber: 1,
			repo: "yolomatic",
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

	it("notifies onActivity for each model output event", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-executor-"));
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
				{ role: "assistant", content: "YOLO_STATUS: complete\nDone." },
			],
		};

		const mockRegistry = {
			find: vi.fn(),
			getAll: vi.fn(() => []),
		};

		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const state = {
			issueNumber: 101,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Test",
			body: "Body",
			status: "pending" as const,
			sessionPath: "/tmp/session",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};

		const onActivity = vi.fn();
		await executor.execute(state, undefined, undefined, undefined, onActivity);

		expect(onActivity).toHaveBeenCalledTimes(1);

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

		expect(onActivity).toHaveBeenCalledTimes(6);
	});

	it("logs and rethrows when session.prompt throws", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-executor-"));
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

		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const state = {
			issueNumber: 2,
			repo: "yolomatic",
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
		const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-executor-"));
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

		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const state = {
			issueNumber: 3,
			repo: "yolomatic",
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
		const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-executor-"));
		const soulPath = path.join(dir, "SOUL.md");
		await writeFile(soulPath, "SOUL content", "utf-8");
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		mockSuccessfulSession();

		const executor = new PiAgentExecutor({ soulPath });
		const state = {
			issueNumber: 4,
			repo: "yolomatic",
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
		const result = await executor.execute(state, undefined, controller.signal);
		expect(result.status).toBe("cancelled");
		expect(result.summary).toBe("Task cancelled before execution started.");
	});

	it("returns failed when assistant message contains a 429 rate-limit error", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-executor-"));
		const soulPath = path.join(dir, "SOUL.md");
		await writeFile(soulPath, "SOUL content", "utf-8");

		const unsubscribe = vi.fn();
		const mockSession = {
			subscribe: vi.fn(() => unsubscribe),
			prompt: vi.fn(),
			messages: [
				{ role: "assistant", content: "YOLO_STATUS: working\nStill going.", errorMessage: '429 "you have reached your weekly usage limit"' },
			],
		};

		const mockRegistry = {
			find: vi.fn(),
			getAll: vi.fn(() => []),
		};

		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const state = {
			issueNumber: 6,
			repo: "yolomatic",
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
		const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-executor-"));
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

		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const state = {
			issueNumber: 5,
			repo: "yolomatic",
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
		const result = await executor.execute(state, undefined, controller.signal);
		expect(result.status).toBe("cancelled");
		expect(result.summary).toBe("Task cancelled by admin.");
		expect(abort).toHaveBeenCalled();
	});

	it("uses an override prompt and passes the configured model into Pi", async () => {
		const soulPath = await makeSoulPath();
		const configuredModel = { provider: "ollama", id: "kimi-k2.7-code:cloud" };
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry([configuredModel]));
		const { mockSession } = mockSuccessfulSession();
		const onSessionCreated = vi.fn();

		const executor = new PiAgentExecutor({
			soulPath,
			modelConfig: { model: "kimi-k2.7-code:cloud" },
		});
		const result = await executor.executeWithOverride(makeState(7), "custom prompt", undefined, onSessionCreated);

		expect(result.status).toBe("complete");
		expect(mockSession.prompt).toHaveBeenCalledWith("custom prompt");
		expect(onSessionCreated).toHaveBeenCalledWith(expect.objectContaining({ steer: expect.any(Function) }));
		await onSessionCreated.mock.calls[0][0].steer("please retry");
		expect(mockSession.steer).toHaveBeenCalledWith("please retry");
		expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ model: configuredModel }));
	});

	it("builds feedback and PR review prompts for continued sessions", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const feedbackSession = mockSuccessfulSession().mockSession;
		const executor = new PiAgentExecutor({ soulPath });

		await executor.execute(makeState(8), "Please retry.");
		expect(feedbackSession.prompt).toHaveBeenCalledWith(expect.stringContaining("Human feedback received"));

		const reviewSession = mockSuccessfulSession().mockSession;
		await executor.executePRReview(makeState(9), { comments: [], reviewBody: "Please add tests" });
		expect(reviewSession.prompt).toHaveBeenCalledWith(expect.stringContaining("PR review feedback received"));
	});

	it("warns when the configured model cannot be resolved", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		mockSuccessfulSession();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const executor = new PiAgentExecutor({
			soulPath,
			modelConfig: { model: "missing-model" },
		});
		await executor.execute(makeState(10));

		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Configured model missing-model did not resolve"));
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("using pi defaults"));
	});

	it("logs non-rate assistant errors without overriding the parsed result", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const unsubscribe = vi.fn();
		const mockSession = {
			subscribe: vi.fn(() => unsubscribe),
			prompt: vi.fn(),
			messages: [
				{ role: "assistant", content: "YOLO_STATUS: complete\nDone.", errorMessage: "tool failed", stopReason: "error" },
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
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const unsubscribe = vi.fn();
		const mockSession = {
			subscribe: vi.fn(() => unsubscribe),
			prompt: vi.fn(),
			messages: [
				{ role: "assistant", content: "YOLO_STATUS: working\nRetrying.", stopReason: "error" },
			],
		};
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(12));

		expect(result.status).toBe("working");
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("marks execution-environment blocker responses as failed", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const unsubscribe = vi.fn();
		const mockSession = {
			subscribe: vi.fn(() => unsubscribe),
			prompt: vi.fn(),
			messages: [
				{
					role: "assistant",
					content:
						"The bash tool won't execute because the configured working directory (/workspaces/x) doesn't exist on this filesystem. Without a valid cwd, I can't run any bash commands.",
				},
			],
		};
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(13));

		expect(result.status).toBe("failed");
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("does not issue a correction prompt when the first response has a valid marker", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const { mockSession } = mockSequentialSession([
			"YOLO_STATUS: complete\nDone.",
		]);

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(20));

		expect(result.status).toBe("complete");
		expect(mockSession.prompt).toHaveBeenCalledTimes(1);
	});

	it("issues one correction prompt and returns complete when the first response lacks a marker", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const { mockSession } = mockSequentialSession([
			"Done. Summary: fixed the bug.\nStatus: complete",
			"YOLO_STATUS: complete\nFixed the parser bug.",
		]);

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(21));

		expect(result.status).toBe("complete");
		expect(result.summary).toBe("Fixed the parser bug.");
		expect(mockSession.prompt).toHaveBeenCalledTimes(2);
		expect(mockSession.prompt).toHaveBeenNthCalledWith(2, expect.stringContaining("rejected"));
		expect(mockSession.prompt).toHaveBeenNthCalledWith(2, expect.stringContaining("YOLO_STATUS: complete"));
	});

	it("treats an unsupported marker as invalid and corrects once", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const { mockSession } = mockSequentialSession([
			"YOLO_STATUS: done\nAll done.",
			"YOLO_STATUS: complete\nDone.",
		]);

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(22));

		expect(result.status).toBe("complete");
		expect(mockSession.prompt).toHaveBeenCalledTimes(2);
	});

	it("returns working when the corrected response is a valid working marker", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const { mockSession } = mockSequentialSession([
			"Still going.",
			"YOLO_STATUS: working\nStill going.",
		]);

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(23));

		expect(result.status).toBe("working");
		expect(mockSession.prompt).toHaveBeenCalledTimes(2);
	});

	it("returns waiting-feedback when the corrected response is valid waiting-feedback", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const { mockSession } = mockSequentialSession([
			"I have a question.",
			"YOLO_STATUS: waiting-feedback\nNeed clarification.",
		]);

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(24));

		expect(result.status).toBe("waiting-feedback");
		expect(result.summary).toBe("Need clarification.");
		expect(mockSession.prompt).toHaveBeenCalledTimes(2);
	});

	it("fails after one correction when the corrected response still lacks a marker", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const { mockSession } = mockSequentialSession([
			"Done. Summary: fixed.",
			"I am done now. No status line.",
		]);

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(25));

		expect(result.status).toBe("failed");
		expect(result.summary).toContain("protocol failure");
		expect(mockSession.prompt).toHaveBeenCalledTimes(2);
	});

	it("fails when the correction prompt itself throws", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const { mockSession } = mockSequentialSession(
			["Done."],
			(callIndex) => {
				if (callIndex === 1) {
					throw new Error("correction channel failed");
				}
			},
		);

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(26));

		expect(result.status).toBe("failed");
		expect(result.summary).toContain("protocol failure");
		expect(result.summary).toContain("correction channel failed");
		expect(mockSession.prompt).toHaveBeenCalledTimes(2);
	});

	it("returns cancelled when abort fires during status correction", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const controller = new AbortController();
		const { mockSession } = mockSequentialSession(
			["Done.", "YOLO_STATUS: complete\nFixed."],
			(callIndex) => {
				if (callIndex === 1) controller.abort();
			},
		);

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(27), undefined, controller.signal);

		expect(result.status).toBe("cancelled");
		expect(mockSession.prompt).toHaveBeenCalledTimes(2);
	});

	it("does not issue a status-correction prompt when abort is set before the correction branch", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const controller = new AbortController();
		const { mockSession } = mockSequentialSession(
			["Done. No status marker here."],
			() => {
				// Abort fires once the first prompt returns, before the correction
				// branch is reached. The run must honor the abort and return a
				// cancelled result without issuing a correction prompt.
				controller.abort();
			},
		);

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(29), undefined, controller.signal);

		expect(result.status).toBe("cancelled");
		expect(result.summary).toBe("Task cancelled by admin.");
		expect(mockSession.prompt).toHaveBeenCalledTimes(1);
	});

	it("does not issue a status correction for refinement executions", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const refinementJson = JSON.stringify({
			proposedTaskBody: "## Summary\nRefined.",
			summary: "Clarified.",
			investigation: "Read code.",
		});
		const { mockSession } = mockSequentialSession([refinementJson]);

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.executeRefinement(makeState(28), "refine prompt");

		expect(result.proposedTaskBody).toContain("Refined.");
		expect(mockSession.prompt).toHaveBeenCalledTimes(1);
	});

	it("issues one JSON correction prompt and accepts a valid corrected refinement result", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const corrected = JSON.stringify({
			proposedTaskBody: "## Summary\nRefined with an escaped \"quote\".",
			summary: "Clarified.",
			investigation: "Read code.",
		});
		const { mockSession } = mockSequentialSession([
			'{"proposedTaskBody":"Invalid "quote"","summary":"Clarified.","investigation":"Read code."}',
			corrected,
		]);

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.executeRefinement(makeState(30), "refine prompt");

		expect(result.proposedTaskBody).toContain('escaped "quote"');
		expect(mockSession.prompt).toHaveBeenCalledTimes(2);
		expect(mockSession.prompt).toHaveBeenNthCalledWith(2, expect.stringContaining("valid JSON"));
		expect(mockSession.prompt).toHaveBeenNthCalledWith(2, expect.stringContaining("Escape every double quote"));
	});

	it("fails after one JSON correction when the corrected refinement result is still invalid", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(mockRegistry());
		const { mockSession } = mockSequentialSession([
			'{"proposedTaskBody":"Invalid "quote"","summary":"One","investigation":"Read code."}',
			'{"proposedTaskBody":"Still "invalid"","summary":"Two","investigation":"Read code."}',
		]);

		const executor = new PiAgentExecutor({ soulPath });

		await expect(executor.executeRefinement(makeState(31), "refine prompt")).rejects.toThrow(
			"Worker did not return a parseable refinement result after one correction prompt.",
		);
		expect(mockSession.prompt).toHaveBeenCalledTimes(2);
	});
});

describe("PiAgentExecutor runtime settings injection", () => {
	afterEach(() => {
		delete process.env.PI_AGENT_MODEL;
		delete process.env.PI_AGENT_PROVIDER;
		delete process.env.OPENAI_API_KEY;
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	async function makeSoulPath() {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-executor-"));
		const soulPath = path.join(dir, "SOUL.md");
		await writeFile(soulPath, "SOUL content", "utf-8");
		return soulPath;
	}

	function makeState(issueNumber = 1) {
		return {
			issueNumber,
			repo: "yolomatic",
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

	it("passes injected logging settings to the LlmLogger", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue({
			runtime: { getModel: vi.fn(), getModels: vi.fn(() => []) },
			find: vi.fn(),
			getAll: vi.fn(() => []),
		});
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			session: { subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(), messages: [{ role: "assistant", content: "YOLO_STATUS: complete\nDone." }] },
		});
		const { LlmLogger } = await import("../logging/llm-logger.js");

		const loggingSettings = {
			logLevel: "error",
			logPrompts: false,
			logThoughts: false,
			logTools: false,
			logResponses: false,
		};
		const executor = new PiAgentExecutor({
			soulPath,
			runtimeSettings: { model: {}, logging: loggingSettings },
		});
		await executor.execute(makeState(500));

		expect(LlmLogger).toHaveBeenCalledWith(
			"yolomatic",
			500,
			undefined,
			expect.objectContaining({ loggingSettings }),
		);
	});

	it("passes injected openaiApiKey and ollamaHost to the model registry", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue({
			runtime: { getModel: vi.fn(), getModels: vi.fn(() => []) },
			find: vi.fn(),
			getAll: vi.fn(() => []),
		});
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			session: { subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(), messages: [{ role: "assistant", content: "YOLO_STATUS: complete\nDone." }] },
		});

		const executor = new PiAgentExecutor({
			soulPath,
			runtimeSettings: {
				model: { openaiApiKey: "sk-injected", ollamaHost: "http://ollama:11434" },
				logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true },
			},
		});
		await executor.execute(makeState(501));

		expect(createYolomaticModelRegistry).toHaveBeenCalledWith({
			openaiApiKey: "sk-injected",
			ollamaHost: "http://ollama:11434",
		});
	});

	it("uses the runtimeSettings provider model as the configured model fallback", async () => {
		const soulPath = await makeSoulPath();
		const configuredModel = { provider: "ollama", id: "kimi-k2.7-code:cloud" };
		const registry = {
			runtime: {
				getModel: vi.fn((provider: string, id: string) => (provider === "ollama" && id === "kimi-k2.7-code:cloud" ? { provider, id } : undefined)),
				getModels: vi.fn(() => [configuredModel]),
			},
			find: vi.fn((provider: string, id: string) => (provider === "ollama" && id === "kimi-k2.7-code:cloud" ? { provider, id } : undefined)),
			getAll: vi.fn(() => [configuredModel]),
		};
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(registry);
		const mockSession = { subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(), messages: [{ role: "assistant", content: "YOLO_STATUS: complete\nDone." }] };
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({
			soulPath,
			runtimeSettings: { model: { piAgentModel: "kimi-k2.7-code:cloud", piAgentProvider: "ollama" }, logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true } },
		});
		await executor.execute(makeState(502));

		expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ model: configuredModel }));
	});

	it("warns and falls back to pi defaults for an unresolvable per-repository model", async () => {
		// A repository selects e.g. openai/gpt-4.1 but the registry cannot resolve
		// it: the session must keep running on pi defaults with a warning, not throw.
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue({
			runtime: { getModel: vi.fn(), getModels: vi.fn(() => []) },
			find: vi.fn(),
			getAll: vi.fn(() => []),
			diagnostics: null,
		});
		const mockSession = { subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(), messages: [{ role: "assistant", content: "YOLO_STATUS: complete\nDone." }] };
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		// Mirrors the forwarded env of a slash-form repo override: model set, no
		// PI_AGENT_PROVIDER forwarded.
		const executor = new PiAgentExecutor({
			soulPath,
			runtimeSettings: { model: { piAgentModel: "openai/missing-model" }, logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true } },
		});
		const result = await executor.execute(makeState(503));

		expect(result.status).toBe("complete");
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Configured model openai/missing-model did not resolve"));
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("using pi defaults"));
		expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
		stderr.mockRestore();
	});

	function mockFullSession(content = "YOLO_STATUS: complete\nDone.", extra: Record<string, unknown> = {}) {
		const unsubscribe = vi.fn();
		const mockSession = {
			subscribe: vi.fn(() => unsubscribe),
			prompt: vi.fn(),
			steer: vi.fn(),
			messages: [
				{ role: "assistant", content },
			],
			...extra,
		};
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });
		return { mockSession, unsubscribe };
	}

	function makeModelSpec(provider: string, id: string, overrides: Record<string, unknown> = {}) {
		return {
			provider,
			id,
			name: id,
			api: "openai-completions",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			baseUrl: "http://localhost:11434/v1",
			...overrides,
		};
	}

	function modelLogEntries() {
		return (recordSessionLog as ReturnType<typeof vi.fn>).mock.calls
			.map((call) => call[1] as { message: string; details?: { type?: string } })
			.filter((entry) => entry.details?.type === "model");
	}

	async function prepareExecutor(
		issueNumber: number,
		model: Record<string, unknown>,
		sessionExtras: Record<string, unknown> = {},
	) {
		const soulPath = await makeSoulPath();
		const registry = {
			runtime: {
				getModel: vi.fn((p: string, id: string) => (p === model.provider && id === model.id ? model : undefined)),
				getModels: vi.fn(() => [model]),
			},
			find: vi.fn((p: string, id: string) => (p === model.provider && id === model.id ? model : undefined)),
			getAll: vi.fn(() => [model]),
		};
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(registry);
		mockFullSession("YOLO_STATUS: complete\nDone.", sessionExtras);
		return new PiAgentExecutor({
			soulPath,
			runtimeSettings: {
				model: { piAgentModel: model.id as string, piAgentProvider: model.provider as string },
				logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true },
			},
		});
	}

	it("logs full model details for issue builds", async () => {
		const executor = await prepareExecutor(
			600,
			makeModelSpec("ollama", "glm-5.3-flash:cloud"),
			{ thinkingLevel: "medium" },
		);
		const stderrSpy = vi.spyOn(process.stderr, "write");

		await executor.execute(makeState(600));

		expect(stderrSpy).not.toHaveBeenCalled();

		const entries = modelLogEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0].message).toBe(
			"Running on glm-5.3-flash:cloud, served through Ollama (openai-completions API). " +
			"Reasoning is enabled at medium effort, with a 1M-token context window and 64K max output tokens.",
		);
		expect(entries[0].details).toMatchObject({
			type: "model",
			provider: "ollama",
			modelId: "glm-5.3-flash:cloud",
			api: "openai-completions",
			reasoning: true,
			thinkingLevel: "medium",
			contextWindow: 1_048_576,
			maxTokens: 65_536,
		});

		const logModel = (LlmLogger as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value as { logModel: ReturnType<typeof vi.fn> };
		expect(logModel.logModel).toHaveBeenCalledWith(entries[0].message);
	});

	it("logs full model details for issue refinements", async () => {
		const executor = await prepareExecutor(
			601,
			makeModelSpec("ollama", "kimi-k2.7-code:cloud", { maxTokens: 16_384 }),
			{ thinkingLevel: "high" },
		);

		await executor.executeRefinement(
			{ ...makeState(601), kind: "refinement" } as never,
			"Refine this issue.",
		);

		const entries = modelLogEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0].message).toBe(
			"Running on kimi-k2.7-code:cloud, served through Ollama (openai-completions API). " +
			"Reasoning is enabled at high effort, with a 1M-token context window and 16K max output tokens.",
		);
		expect(entries[0].details).toMatchObject({
			type: "model",
			provider: "ollama",
			modelId: "kimi-k2.7-code:cloud",
			thinkingLevel: "high",
			maxTokens: 16_384,
		});
	});

	it("falls back to the pi default effort when the session omits thinkingLevel", async () => {
		const executor = await prepareExecutor(602, makeModelSpec("ollama", "glm-5.2:cloud"));

		await executor.execute(makeState(602));

		const entries = modelLogEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0].message).toContain("Reasoning is enabled at medium effort");
		expect(entries[0].details).toMatchObject({ thinkingLevel: "medium" });
	});

	it("reports reasoning as disabled for non-reasoning models", async () => {
		const executor = await prepareExecutor(
			603,
			makeModelSpec("ollama", "tiny-local:8b", { reasoning: false, maxTokens: 16_384 }),
			{ thinkingLevel: "high" },
		);

		await executor.execute(makeState(603));

		const entries = modelLogEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0].message).toContain("Reasoning is disabled");
		expect(entries[0].message).toContain("with a 1M-token context window and 16K max output tokens.");
	});

	it("keeps the unresolved-model warning entry when no model resolves", async () => {
		const soulPath = await makeSoulPath();
		const registry = {
			runtime: {
				getModel: vi.fn(() => undefined),
				getModels: vi.fn(() => []),
			},
			find: vi.fn(() => undefined),
			getAll: vi.fn(() => []),
			diagnostics: { ollama: { host: "http://127.0.0.1:11434", taggedModels: [] } },
		};
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(registry);
		mockFullSession();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const executor = new PiAgentExecutor({
			soulPath,
			runtimeSettings: {
				model: { piAgentModel: "missing-model", piAgentProvider: "ollama" },
				logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true },
			},
		});
		await executor.execute(makeState(604));

		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Configured model ollama/missing-model did not resolve"));
		const entries = modelLogEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0].message).toContain("Using model: (pi defaults)");
		expect(entries[0].message).toContain("did not resolve");
		stderrSpy.mockRestore();
	});

	it("keeps the resolved-model log message free of unresolved-model notices", async () => {
		const executor = await prepareExecutor(605, makeModelSpec("ollama", "glm-5.3-flash:cloud"), { thinkingLevel: "medium" });

		await executor.execute(makeState(605));

		const entries = modelLogEntries();
		expect(entries[0].message).not.toContain("configured model unresolved");
		expect(entries[0].message).toContain("Running on glm-5.3-flash:cloud");
	});
	
	it("reads the runtime settings provider fresh on each execution", async () => {
		const soulPath = await makeSoulPath();
		const configuredModelA = { provider: "ollama", id: "kimi-k2.7-code:cloud" };
		const configuredModelB = { provider: "ollama", id: "glm-5.2:cloud" };
		const registry = {
			runtime: {
				getModel: vi.fn((provider: string, id: string) => {
					if (provider === "ollama" && id === "kimi-k2.7-code:cloud") return configuredModelA;
					if (provider === "ollama" && id === "glm-5.2:cloud") return configuredModelB;
					return undefined;
				}),
				getModels: vi.fn(() => [configuredModelA, configuredModelB]),
			},
			find: vi.fn((provider: string, id: string) => {
				if (provider === "ollama" && id === "kimi-k2.7-code:cloud") return configuredModelA;
				if (provider === "ollama" && id === "glm-5.2:cloud") return configuredModelB;
				return undefined;
			}),
			getAll: vi.fn(() => [configuredModelA, configuredModelB]),
		};
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(registry);
		const mockSession = { subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(), messages: [{ role: "assistant", content: "YOLO_STATUS: complete\nDone." }] };
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		let currentModel = "kimi-k2.7-code:cloud";
		const provider = () => ({
			model: { piAgentModel: currentModel, piAgentProvider: "ollama" },
			logging: { logLevel: "info", logPrompts: true, logThoughts: true, logTools: true, logResponses: true },
		});
		const executor = new PiAgentExecutor({ soulPath, runtimeSettings: provider });

		await executor.execute(makeState(503));
		expect(createAgentSession).toHaveBeenLastCalledWith(expect.objectContaining({ model: configuredModelA }));

		// Live reconfiguration: the next execution picks up the new value without
		// reconstructing the executor or mutating process.env.
		currentModel = "glm-5.2:cloud";
		await executor.execute(makeState(504));
		expect(createAgentSession).toHaveBeenLastCalledWith(expect.objectContaining({ model: configuredModelB }));
	});

	it("preserves fallback behavior when model settings are missing", async () => {
		const soulPath = await makeSoulPath();
		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue({
			runtime: { getModel: vi.fn(), getModels: vi.fn(() => []) },
			find: vi.fn(),
			getAll: vi.fn(() => []),
		});
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			session: { subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(), messages: [{ role: "assistant", content: "YOLO_STATUS: complete\nDone." }] },
		});

		const executor = new PiAgentExecutor({ soulPath });
		await executor.execute(makeState(505));

		// No configured model => Pi defaults, no unresolved-model warning.
		expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("did not resolve"));
		expect(createAgentSession).toHaveBeenLastCalledWith(expect.objectContaining({ model: undefined }));
	});

	it("does not read process.env for migrated model keys", async () => {
		const soulPath = await makeSoulPath();
		const originalModel = process.env.PI_AGENT_MODEL;
		try {
			process.env.PI_AGENT_MODEL = "should-be-ignored";
			(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue({
				runtime: { getModel: vi.fn(), getModels: vi.fn(() => []) },
				find: vi.fn(),
				getAll: vi.fn(() => []),
			});
			(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({
				session: { subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(), messages: [{ role: "assistant", content: "YOLO_STATUS: complete\nDone." }] },
			});

			const executor = new PiAgentExecutor({ soulPath });
			await executor.execute(makeState(506));

			// No runtime settings injected => process.env.PI_AGENT_MODEL must not be
			// consulted; the executor falls back to Pi defaults instead.
			expect(createAgentSession).toHaveBeenLastCalledWith(expect.objectContaining({ model: undefined }));
			expect(process.env.PI_AGENT_MODEL).toBe("should-be-ignored");
		} finally {
			if (originalModel === undefined) delete process.env.PI_AGENT_MODEL;
			else process.env.PI_AGENT_MODEL = originalModel;
		}
	});

	it("attaches aggregated token usage to the execution result when the provider reports usage", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-executor-"));
		const soulPath = path.join(dir, "SOUL.md");
		await writeFile(soulPath, "SOUL content", "utf-8");

		const mockSession = {
			subscribe: vi.fn(() => vi.fn()),
			prompt: vi.fn(),
			abort: vi.fn(),
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "YOLO_STATUS: complete\nDone." }],
					usage: {
						input: 100,
						output: 40,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 140,
						cost: { input: 0.5, output: 0.3, cacheRead: 0, cacheWrite: 0, total: 0.8 },
					},
				},
			],
		};

		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue({
			find: vi.fn(),
			getAll: vi.fn(() => []),
		});
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(601));

		expect(result.status).toBe("complete");
		expect(result.usage).toBeDefined();
		expect(result.usage!.available).toBe(true);
		expect(result.usage!.totalTokens).toBe(140);
		expect(result.usage!.input).toBe(100);
		expect(result.usage!.output).toBe(40);
		expect(result.usage!.cost).toBeCloseTo(0.8, 10);
	});

	it("reports unavailable usage on the result when the provider omits usage", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-executor-"));
		const soulPath = path.join(dir, "SOUL.md");
		await writeFile(soulPath, "SOUL content", "utf-8");

		const mockSession = {
			subscribe: vi.fn(() => vi.fn()),
			prompt: vi.fn(),
			abort: vi.fn(),
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "YOLO_STATUS: complete\nDone." }] },
			],
		};

		(createYolomaticModelRegistry as ReturnType<typeof vi.fn>).mockResolvedValue({
			find: vi.fn(),
			getAll: vi.fn(() => []),
		});
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session: mockSession });

		const executor = new PiAgentExecutor({ soulPath });
		const result = await executor.execute(makeState(602));

		expect(result.status).toBe("complete");
		expect(result.usage).toBeDefined();
		expect(result.usage!.available).toBe(false);
		expect(result.usage!.totalTokens).toBe(0);
	});
});
