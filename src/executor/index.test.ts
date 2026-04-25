import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", () => ({
	AuthStorage: { create: vi.fn() },
	createAgentSession: vi.fn(),
	DefaultResourceLoader: vi.fn(() => ({ reload: vi.fn() })),
	getAgentDir: vi.fn(() => "/agent"),
	ModelRegistry: { create: vi.fn() },
	SessionManager: { open: vi.fn() },
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

import {
	buildFeedbackPrompt,
	buildIssuePrompt,
	extractText,
	getLastAssistantText,
	parseExecutionResult,
	PiAgentExecutor,
	resolveConfiguredModel,
} from "./index.js";

import { createAgentSession, ModelRegistry } from "@mariozechner/pi-coding-agent";

interface TestModel {
	provider: string;
	id: string;
}

function createRegistry(models: TestModel[]) {
	return {
		find(provider: string, modelId: string): TestModel | undefined {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		getAll(): TestModel[] {
			return models;
		},
	};
}

describe("resolveConfiguredModel", () => {
	it("prefers an explicit provider when configured", () => {
		const registry = createRegistry([
			{ provider: "github-copilot", id: "gpt-4o" },
			{ provider: "ollama", id: "kimi-k2.6:cloud" },
		]);

		const model = resolveConfiguredModel(registry, {
			PI_AGENT_PROVIDER: "ollama",
			PI_AGENT_MODEL: "kimi-k2.6:cloud",
		});

		expect(model).toEqual({ provider: "ollama", id: "kimi-k2.6:cloud" });
	});

	it("resolves a unique model id without an explicit provider", () => {
		const registry = createRegistry([
			{ provider: "github-copilot", id: "gpt-4o" },
			{ provider: "ollama", id: "kimi-k2.6:cloud" },
		]);

		const model = resolveConfiguredModel(registry, {
			PI_AGENT_MODEL: "kimi-k2.6:cloud",
		});

		expect(model).toEqual({ provider: "ollama", id: "kimi-k2.6:cloud" });
	});

	it("supports provider/model syntax in PI_AGENT_MODEL", () => {
		const registry = createRegistry([
			{ provider: "github-copilot", id: "gpt-4o" },
			{ provider: "ollama", id: "kimi-k2.6:cloud" },
		]);

		const model = resolveConfiguredModel(registry, {
			PI_AGENT_MODEL: "ollama/kimi-k2.6:cloud",
		});

		expect(model).toEqual({ provider: "ollama", id: "kimi-k2.6:cloud" });
	});

	it("returns undefined for ambiguous model ids", () => {
		const registry = createRegistry([
			{ provider: "provider-a", id: "shared-model" },
			{ provider: "provider-b", id: "shared-model" },
		]);

		const model = resolveConfiguredModel(registry, {
			PI_AGENT_MODEL: "shared-model",
		});

		expect(model).toBeUndefined();
	});
});

describe("parseExecutionResult", () => {
	it("parses working status", () => {
		const result = parseExecutionResult("TARS_STATUS: working\nStill working.");
		expect(result.status).toBe("working");
		expect(result.summary).toBe("Still working.");
	});

	it("parses waiting-feedback status", () => {
		const result = parseExecutionResult("TARS_STATUS: waiting-feedback\nNeed info.");
		expect(result.status).toBe("waiting-feedback");
		expect(result.summary).toBe("Need info.");
	});

	it("parses complete status", () => {
		const result = parseExecutionResult("TARS_STATUS: complete\nDone.");
		expect(result.status).toBe("complete");
		expect(result.summary).toBe("Done.");
	});

	it("defaults to working for unknown status", () => {
		const result = parseExecutionResult("TARS_STATUS: unknown\nOops.");
		expect(result.status).toBe("working");
		expect(result.summary).toBe("TARS_STATUS: unknown\nOops.");
	});

	it("defaults to working when no status line is present", () => {
		const result = parseExecutionResult("Just some text.");
		expect(result.status).toBe("working");
		expect(result.summary).toBe("Just some text.");
	});

	it("trims whitespace", () => {
		const result = parseExecutionResult("\n  TARS_STATUS: complete  \n  Summary  \n");
		expect(result.status).toBe("complete");
		expect(result.summary).toBe("Summary");
	});

	it("returns raw response as trimmed", () => {
		const result = parseExecutionResult("  raw  ");
		expect(result.rawResponse).toBe("raw");
	});

	it("falls back to trimmed response when summary is empty", () => {
		const result = parseExecutionResult("TARS_STATUS: complete\n   ");
		expect(result.summary).toBe("TARS_STATUS: complete");
	});
});

describe("extractText", () => {
	it("returns strings as-is", () => {
		expect(extractText("hello")).toBe("hello");
	});

	it("extracts text items from array", () => {
		expect(extractText([{ type: "text", text: "hello" }, { type: "text", text: "world" }])).toBe("hello\nworld");
	});

	it("skips non-text array items", () => {
		expect(extractText([{ type: "image" }, { type: "text", text: "only" }])).toBe("only");
	});

	it("returns empty for unknown types", () => {
		expect(extractText(123)).toBe("");
		expect(extractText(null)).toBe("");
		expect(extractText(undefined)).toBe("");
	});
});

describe("getLastAssistantText", () => {
	it("returns text from the last assistant message", () => {
		const session = {
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
				{ role: "user", content: "bye" },
				{ role: "assistant", content: "goodbye" },
			],
		};
		expect(getLastAssistantText(session)).toBe("goodbye");
	});

	it("returns empty when no assistant messages", () => {
		const session = { messages: [{ role: "user", content: "hi" }] };
		expect(getLastAssistantText(session)).toBe("");
	});

	it("returns empty for empty messages", () => {
		expect(getLastAssistantText({ messages: [] })).toBe("");
	});

	it("handles array content in assistant message", () => {
		const session = {
			messages: [{ role: "assistant", content: [{ type: "text", text: "  hello  " }] }],
		};
		expect(getLastAssistantText(session)).toBe("hello");
	});
});

describe("buildIssuePrompt", () => {
	it("includes issue metadata", () => {
		const state = {
			issueNumber: 42,
			owner: "mbrooks",
			repo: "tars",
			workspacePath: "/tmp/ws",
			title: "Fix bug",
			body: "Description here",
		} as never;
		const prompt = buildIssuePrompt(state);
		expect(prompt).toContain("#42");
		expect(prompt).toContain("mbrooks/tars");
		expect(prompt).toContain("/tmp/ws");
		expect(prompt).toContain("Fix bug");
		expect(prompt).toContain("Description here");
	});

	it("handles empty body", () => {
		const state = {
			issueNumber: 1,
			owner: "x",
			repo: "y",
			workspacePath: "/tmp",
			title: "T",
			body: "",
		} as never;
		const prompt = buildIssuePrompt(state);
		expect(prompt).toContain("(no description provided)");
	});
});

describe("buildFeedbackPrompt", () => {
	it("includes feedback text", () => {
		const prompt = buildFeedbackPrompt("Please retry.");
		expect(prompt).toContain("Please retry.");
		expect(prompt).toContain("Human feedback received");
	});

	it("trims feedback text", () => {
		const prompt = buildFeedbackPrompt("  trim me  ");
		expect(prompt).toContain("trim me");
		expect(prompt).not.toContain("  trim me  ");
	});
});

describe("PiAgentExecutor", () => {
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

		(ModelRegistry.create as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry);
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

		(ModelRegistry.create as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry);
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

		(ModelRegistry.create as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry);
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
});
