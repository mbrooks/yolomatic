import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	AuthStorage: {
		create: vi.fn(() => ({})),
	},
	createAgentSession: vi.fn(),
	DefaultResourceLoader: vi.fn(() => ({ reload: vi.fn() })),
	getAgentDir: vi.fn(() => "/agent"),
	SessionManager: {
		inMemory: vi.fn(() => ({})),
	},
}));

vi.mock("../../executor/model-registry.js", () => ({
	createTarsModelRegistry: vi.fn(() => ({
		find: vi.fn(),
		getAll: vi.fn(() => []),
	})),
}));

vi.mock("../../executor/index.js", () => ({
	resolveConfiguredModel: vi.fn(),
	getLastAssistantText: vi.fn((session: { messages: Array<{ role?: string; content?: unknown }> }) => {
		for (let index = session.messages.length - 1; index >= 0; index--) {
			const message = session.messages[index];
			if (message.role !== "assistant") {
				continue;
			}
			const content = message.content;
			if (typeof content === "string") {
				return content.trim();
			}
			if (Array.isArray(content)) {
				return content
					.map((item: any) => item?.type === "text" && typeof item.text === "string" ? item.text : "")
					.filter(Boolean)
					.join("\n")
					.trim();
			}
		}
		return "";
	}),
}));

vi.mock("node:fs", () => ({
	readdirSync: vi.fn(() => []),
	statSync: vi.fn(() => undefined),
	readFileSync: vi.fn(() => ""),
}));

vi.mock("../../skills/repo-skill-service.js", () => ({
	parseSkillFile: vi.fn(() => ({ name: "", description: "", body: "" })),
	buildSkillFile: vi.fn((name: string, description: string, content: string) =>
		`---\nname: ${name}\ndescription: ${description}\n---\n\n${content}`),
}));

vi.mock("../../logging/llm-logger.js", () => ({
	LlmLogger: vi.fn(() => ({
		logPrompt: vi.fn(),
		logThought: vi.fn(),
		logToolCall: vi.fn(),
		logToolResult: vi.fn(),
		logError: vi.fn(),
	})),
}));

vi.mock("../../logging/session-log-store.js", () => ({
	recordSessionLog: vi.fn(),
}));

import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { resolveConfiguredModel } from "../../executor/index.js";
import { LlmLogger } from "../../logging/llm-logger.js";
import { recordSessionLog } from "../../logging/session-log-store.js";
import { chatIssueViaLLM } from "./issue-chat.js";

function createMockSession(
	responses: Array<{ text: string; errorMessage?: string }>,
	eventsByTurn: Array<unknown[]> = [],
) {
	let turn = 0;
	const messages: Array<{ role: string; content: unknown; errorMessage?: string }> = [];
	const listeners = new Set<(event: unknown) => void>();
	const session = {
		agent: { state: { systemPrompt: "" } },
		messages,
		prompt: vi.fn(async (text: string) => {
			messages.push({ role: "user", content: text });
			for (const event of eventsByTurn[turn] ?? []) {
				for (const listener of listeners) {
					listener(event);
				}
			}
			const response = responses[turn++] ?? { text: "" };
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: response.text }],
				errorMessage: response.errorMessage,
			});
		}),
		subscribe: vi.fn((listener: (event: unknown) => void) => {
			listeners.add(listener);
			return vi.fn(() => {
				listeners.delete(listener);
			});
		}),
		dispose: vi.fn(),
	};
	return session;
}

describe("chatIssueViaLLM", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns a structured conversational draft update", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession([
			{
				text: JSON.stringify({
					message: "I drafted the issue. Tell me when to create it.",
					owner: "mbrooks",
					repo: "tars",
					draft: {
						title: "Generated Title",
						body: "Generated body",
						labels: ["bug"],
						assignees: [],
					},
					readyToCreate: true,
					shouldCreate: false,
				}),
			},
		]);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		const result = await chatIssueViaLLM({
			messages: [{ role: "user", text: "Create an issue in mbrooks/tars for a login bug" }],
		});

		expect(result).toEqual({
			message: "I drafted the issue. Tell me when to create it.",
			owner: "mbrooks",
			repo: "tars",
			draft: {
				title: "Generated Title",
				body: "Generated body",
				labels: ["bug"],
				assignees: [],
			},
			readyToCreate: true,
			shouldCreate: false,
		});
		expect(session.dispose).toHaveBeenCalled();
		expect(session.subscribe).toHaveBeenCalled();
	});

	it("streams thinking events and logs prompt, thinking, and tool activity", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession(
			[
				{
					text: JSON.stringify({
						message: "Draft ready.",
						owner: "mbrooks",
						repo: "tars",
						draft: { title: "Title", body: "Body", labels: [], assignees: [] },
						readyToCreate: true,
						shouldCreate: false,
					}),
				},
			],
			[[
				{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "checking " } },
				{ type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "checking context" } },
				{ type: "tool_execution_start", toolName: "grep", args: { pattern: "bug" } },
				{ type: "tool_execution_end", toolName: "grep", result: "match", isError: false },
			]],
		);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });
		const onThinking = vi.fn();

		const result = await chatIssueViaLLM({
			owner: "mbrooks",
			repo: "tars",
			messages: [{ role: "user", text: "draft this" }],
			onThinking,
		});

		expect(result.message).toBe("Draft ready.");
		expect(onThinking).toHaveBeenNthCalledWith(1, { text: "checking ", done: false });
		expect(onThinking).toHaveBeenNthCalledWith(2, { text: "checking context", done: true });
		const logger = vi.mocked(LlmLogger).mock.results[0].value;
		expect(logger.logPrompt).toHaveBeenCalled();
		expect(logger.logThought).toHaveBeenCalledWith("checking context");
		expect(logger.logToolCall).toHaveBeenCalledWith("grep", { pattern: "bug" });
		expect(logger.logToolResult).toHaveBeenCalledWith("grep", "match");
		expect(recordSessionLog).toHaveBeenCalledWith(
			"mbrooks/tars#-1",
			expect.objectContaining({ details: expect.objectContaining({ type: "prompt" }) }),
		);
		expect(recordSessionLog).toHaveBeenCalledWith(
			"mbrooks/tars#-1",
			expect.objectContaining({ details: expect.objectContaining({ type: "thinking" }) }),
		);
	});

	it("logs tool execution failures", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession(
			[
				{
					text: JSON.stringify({
						message: "Draft ready.",
						owner: "mbrooks",
						repo: "tars",
						draft: { title: "Title", body: "Body", labels: [], assignees: [] },
						readyToCreate: true,
						shouldCreate: false,
					}),
				},
			],
			[[
				{ type: "tool_execution_end", toolName: "grep", result: "boom", isError: true },
			]],
		);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		await chatIssueViaLLM({
			owner: "mbrooks",
			repo: "tars",
			messages: [{ role: "user", text: "draft this" }],
		});

		expect(recordSessionLog).toHaveBeenCalledWith(
			"mbrooks/tars#-1",
			expect.objectContaining({
				level: "error",
				message: "grep failed",
				details: expect.objectContaining({ type: "tool_execution_end", isError: true }),
			}),
		);
	});

	it("retries if the first response is not valid JSON", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession([
			{ text: "not json" },
			{
				text: JSON.stringify({
					message: "Ready.",
					owner: "mbrooks",
					repo: "tars",
					draft: { title: "Title", body: "", labels: [], assignees: [] },
					readyToCreate: true,
					shouldCreate: true,
				}),
			},
		]);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		const result = await chatIssueViaLLM({
			owner: "mbrooks",
			repo: "tars",
			messages: [{ role: "user", text: "create it" }],
		});

		expect(result.readyToCreate).toBe(true);
		expect(result.shouldCreate).toBe(true);
		expect(session.prompt).toHaveBeenCalledTimes(2);
	});

	it("falls back to provided owner and repo and normalizes draft fields", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession([
			{
				text: JSON.stringify({
					message: " Ready to go. ",
					draft: {
						title: " Draft title ",
						body: " Draft body ",
						labels: [" bug ", 123, ""],
						assignees: [" mbrooks ", null],
					},
					readyToCreate: false,
					shouldCreate: false,
				}),
			},
		]);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		const result = await chatIssueViaLLM({
			owner: "mbrooks",
			repo: "tars",
			messages: [{ role: "user", text: "draft this" }],
		});

		expect(result).toEqual({
			message: "Ready to go.",
			owner: "mbrooks",
			repo: "tars",
			draft: {
				title: "Draft title",
				body: "Draft body",
				labels: ["bug"],
				assignees: ["mbrooks"],
			},
			readyToCreate: false,
			shouldCreate: false,
		});
	});

	it("throws when no model is configured", async () => {
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
		await expect(
			chatIssueViaLLM({
				messages: [{ role: "user", text: "draft this" }],
			}),
		).rejects.toThrow("No LLM model configured");
	});

	it("throws on provider errors and disposes the session", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession([{ text: "", errorMessage: "Rate limit exceeded" }]);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		await expect(
			chatIssueViaLLM({
				messages: [{ role: "user", text: "draft this" }],
			}),
		).rejects.toThrow("LLM request failed: Rate limit exceeded");
		expect(session.dispose).toHaveBeenCalled();
		const logger = vi.mocked(LlmLogger).mock.results[0].value;
		expect(logger.logError).toHaveBeenCalledWith(expect.any(Error), "Issue chat failed");
	});

	it("throws after the retry limit when responses are not valid JSON", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession([
			{ text: "not json 1" },
			{ text: "not json 2" },
			{ text: "not json 3" },
		]);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		await expect(
			chatIssueViaLLM({
				messages: [{ role: "user", text: "draft this" }],
			}),
		).rejects.toThrow("Could not extract valid JSON from LLM response after 3 attempts");
		expect(session.prompt).toHaveBeenCalledTimes(3);
		expect(session.dispose).toHaveBeenCalled();
	});

	it("still works when repo skill service throws", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession([
			{
				text: JSON.stringify({
					message: "Draft ready.",
					owner: "mbrooks",
					repo: "tars",
					draft: { title: "Title", body: "Body", labels: [], assignees: [] },
					readyToCreate: true,
					shouldCreate: false,
				}),
			},
		]);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		const repoSkillService = {
			listRepoSkills: vi.fn(async () => {
				throw new Error("repo skill fetch failed");
			}),
		};

		await chatIssueViaLLM({
			owner: "mbrooks",
			repo: "tars",
			messages: [{ role: "user", text: "draft this" }],
			repoSkillService: repoSkillService as unknown as import("../../skills/repo-skill-service.js").RepoSkillService,
		});

		expect(DefaultResourceLoader).toHaveBeenCalled();
	});

	it("creates a DefaultResourceLoader with skill files when services are provided", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession([
			{
				text: JSON.stringify({
					message: "Draft ready.",
					owner: "mbrooks",
					repo: "tars",
					draft: { title: "Title", body: "Body", labels: [], assignees: [] },
					readyToCreate: true,
					shouldCreate: false,
				}),
			},
		]);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		const skillStore = {
			listAll: vi.fn(async () => [
				{ id: "1", name: "server-skill", description: "desc", content: "body", updatedAt: "", createdAt: "" },
			]),
		};
		const repoSkillService = {
			listRepoSkills: vi.fn(async () => [
				{ name: "repo-skill", description: "rdesc", content: "rbody", updatedAt: "", source: "repo" },
			]),
		};

		await chatIssueViaLLM({
			owner: "mbrooks",
			repo: "tars",
			messages: [{ role: "user", text: "draft this" }],
			skillStore: skillStore as unknown as import("../../skills/store.js").SkillStore,
			repoSkillService: repoSkillService as unknown as import("../../skills/repo-skill-service.js").RepoSkillService,
		});

		expect(DefaultResourceLoader).toHaveBeenCalled();
		const loaderOptions = vi.mocked(DefaultResourceLoader).mock.calls[0][0];
		expect(loaderOptions.cwd).toBeDefined();
		expect(loaderOptions.agentDir).toBeDefined();
		expect(loaderOptions.agentsFilesOverride).toBeDefined();

		const agentsFilesOverride = loaderOptions.agentsFilesOverride!;
		const overrideResult = agentsFilesOverride({ agentsFiles: [] });
		expect(overrideResult.agentsFiles.length).toBeGreaterThanOrEqual(2);
		const paths = overrideResult.agentsFiles.map((f: { path: string }) => f.path);
		expect(paths.some((p: string) => p.includes("server-skill"))).toBe(true);
		expect(paths.some((p: string) => p.includes("repo-skill"))).toBe(true);
	});

	it("defaults missing draft payload fields safely", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession([
			{
				text: JSON.stringify({
					message: 123,
					owner: null,
					repo: undefined,
					draft: null,
					readyToCreate: "yes",
					shouldCreate: 1,
				}),
			},
		]);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		const result = await chatIssueViaLLM({
			messages: [{ role: "user", text: "draft this" }],
		});

		expect(result).toEqual({
			message: "",
			owner: "",
			repo: "",
			draft: {
				title: "",
				body: "",
				labels: [],
				assignees: [],
			},
			readyToCreate: false,
			shouldCreate: false,
		});
	});
});
