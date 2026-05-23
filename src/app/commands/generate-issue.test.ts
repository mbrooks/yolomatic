import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", () => ({
	AuthStorage: {
		create: vi.fn(() => ({})),
	},
	ModelRegistry: {
		create: vi.fn(() => ({
			find: vi.fn(),
			getAll: vi.fn(() => []),
		})),
	},
	createAgentSession: vi.fn(),
	SessionManager: {
		inMemory: vi.fn(() => ({})),
	},
}));

vi.mock("../../executor/index.js", () => ({
	resolveConfiguredModel: vi.fn(),
	getLastAssistantText: vi.fn((session: { messages: Array<{ role?: string; content?: unknown }> }) => {
		for (let i = session.messages.length - 1; i >= 0; i--) {
			const message = session.messages[i];
			if (message.role === "assistant") {
				const content = message.content;
				if (typeof content === "string") {
					return content.trim();
				}
				if (Array.isArray(content)) {
					return content
						.map((item: any) => {
							if (item?.type === "text" && "text" in item) {
								return typeof item.text === "string" ? item.text : "";
							}
							if (item?.type === "thinking" && "thinking" in item) {
								return typeof item.thinking === "string" ? item.thinking : "";
							}
							return "";
						})
						.filter(Boolean)
						.join("\n")
						.trim();
				}
			}
		}
		return "";
	}),
}));

import { createAgentSession } from "@mariozechner/pi-coding-agent";
import { resolveConfiguredModel, getLastAssistantText } from "../../executor/index.js";
import { extractJson, generateIssueViaLLM } from "./generate-issue.js";

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

describe("extractJson", () => {
	it("parses raw JSON", () => {
		const result = extractJson('{"title": "foo"}');
		expect(result).toEqual({ title: "foo" });
	});

	it("parses JSON inside markdown fences", () => {
		const result = extractJson('```json\n{"title": "bar"}\n```');
		expect(result).toEqual({ title: "bar" });
	});

	it("parses JSON with no language on fences", () => {
		const result = extractJson('```\n{"title": "baz"}\n```');
		expect(result).toEqual({ title: "baz" });
	});

	it("parses JSON surrounded by explanatory text", () => {
		const result = extractJson('Sure! Here is the JSON:\n{"title": "qux"}\nHope that helps!');
		expect(result).toEqual({ title: "qux" });
	});

	it("parses JSON with nested objects when using brace extraction", () => {
		const text = 'Here you go:\n{"outer": {"inner": 1}}\nDone.';
		const result = extractJson(text);
		expect(result).toEqual({ outer: { inner: 1 } });
	});

	it("throws with raw output when no JSON can be extracted", () => {
		const text = "Not valid json at all";
		expect(() => extractJson(text)).toThrow(
			"Could not extract valid JSON from LLM response. Raw output:\nNot valid json at all",
		);
	});

	it("throws with raw output when braces exist but content is not valid JSON", () => {
		const text = "Here is {not quite valid} json";
		expect(() => extractJson(text)).toThrow(
			"Could not extract valid JSON from LLM response. Raw output:\nHere is {not quite valid} json",
		);
	});
});

describe("generateIssueViaLLM", () => {
	it("returns parsed issue when LLM responds with clean JSON", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession([
			{ text: '{"title":"Bug","body":"desc","labels":["bug"],"assignees":["a"]}' },
		]);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		const result = await generateIssueViaLLM("owner", "repo", "prompt");
		expect(result).toEqual({
			title: "Bug",
			body: "desc",
			labels: ["bug"],
			assignees: ["a"],
		});
		expect(session.dispose).toHaveBeenCalled();
	});

	it("returns parsed issue when LLM wraps JSON in fences", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession([
			{ text: '```json\n{"title":"Fenced","body":"b","labels":[],"assignees":[]}\n```' },
		]);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		const result = await generateIssueViaLLM("owner", "repo", "prompt");
		expect(result).toEqual({
			title: "Fenced",
			body: "b",
			labels: [],
			assignees: [],
		});
	});

	it("returns parsed issue when LLM adds commentary around JSON", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession([
			{ text: 'Okay!\n{"title":"Wrapped","body":"b","labels":[],"assignees":[]}\nEnjoy!' },
		]);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		const result = await generateIssueViaLLM("owner", "repo", "prompt");
		expect(result).toEqual({
			title: "Wrapped",
			body: "b",
			labels: [],
			assignees: [],
		});
	});

	it("throws when no model is configured", async () => {
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
		await expect(generateIssueViaLLM("owner", "repo", "prompt")).rejects.toThrow(
			"No LLM model configured",
		);
	});

	it("throws with raw LLM output when JSON extraction fails", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession([
			{ text: "Just some random text" },
			{ text: "Just some random text" },
			{ text: "Just some random text" },
		]);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		await expect(generateIssueViaLLM("owner", "repo", "prompt")).rejects.toThrow(
			/Could not extract valid JSON from LLM response after 3 attempts\. Last error:.*Raw output:\nJust some random text/,
		);
		expect(session.dispose).toHaveBeenCalled();
	});

	it("retries on invalid JSON and succeeds on second turn", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession([
			{ text: "not json" },
			{ text: '{"title":"Retry","body":"b","labels":[],"assignees":[]}' },
		]);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		const result = await generateIssueViaLLM("owner", "repo", "prompt");
		expect(result).toEqual({
			title: "Retry",
			body: "b",
			labels: [],
			assignees: [],
		});
		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.dispose).toHaveBeenCalled();
	});

	it("throws on API error immediately without retrying", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession([
			{ text: "", errorMessage: "Rate limit exceeded" },
		]);
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		await expect(generateIssueViaLLM("owner", "repo", "prompt")).rejects.toThrow(
			"LLM request failed: Rate limit exceeded",
		);
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(session.dispose).toHaveBeenCalled();
	});

	it("works with reasoning models that return thinking blocks", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		const session = createMockSession([
			{
				text: "",
			},
		]);
		// Override the assistant message to include thinking block content
		session.prompt.mockImplementation(async (text: string) => {
			session.messages.push({ role: "user", content: text });
			session.messages.push({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Let me construct the JSON." },
					{ type: "text", text: '{"title":"Thinking","body":"b","labels":[],"assignees":[]}' },
				],
			});
		});
		(createAgentSession as ReturnType<typeof vi.fn>).mockResolvedValue({ session });

		const result = await generateIssueViaLLM("owner", "repo", "prompt");
		expect(result).toEqual({
			title: "Thinking",
			body: "b",
			labels: [],
			assignees: [],
		});
		expect(session.dispose).toHaveBeenCalled();
	});
});
