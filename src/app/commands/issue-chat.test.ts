import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", () => ({
	AuthStorage: {
		create: vi.fn(() => ({})),
	},
	createAgentSession: vi.fn(),
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

import { createAgentSession } from "@mariozechner/pi-coding-agent";
import { resolveConfiguredModel } from "../../executor/index.js";
import { chatIssueViaLLM } from "./issue-chat.js";

function createMockSession(responses: Array<{ text: string; errorMessage?: string }>) {
	let turn = 0;
	const messages: Array<{ role: string; content: unknown; errorMessage?: string }> = [];
	const session = {
		agent: { state: { systemPrompt: "" } },
		messages,
		prompt: vi.fn(async (text: string) => {
			messages.push({ role: "user", content: text });
			const response = responses[turn++] ?? { text: "" };
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: response.text }],
				errorMessage: response.errorMessage,
			});
		}),
		dispose: vi.fn(),
	};
	return session;
}

describe("chatIssueViaLLM", () => {
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
