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
		};
	}),
}));

vi.mock("../logging/session-log-store.js", () => ({
	recordSessionLog: vi.fn(),
}));

import { PiAgentExecutor, preferTrustedExtension } from "./index.js";

import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createYolomaticModelRegistry } from "./model-registry.js";

describe("PiAgentExecutor", () => {
	afterEach(() => {
		delete process.env.PI_AGENT_MODEL;
		delete process.env.PI_AGENT_PROVIDER;
		vi.restoreAllMocks();
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

		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("configured Pi model missing-model did not resolve"));
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
});
