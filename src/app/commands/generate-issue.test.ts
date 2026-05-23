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
}));

vi.mock("@mariozechner/pi-ai", () => ({
	completeSimple: vi.fn(),
}));

vi.mock("../../executor/index.js", () => ({
	resolveConfiguredModel: vi.fn(),
}));

import { completeSimple } from "@mariozechner/pi-ai";
import { resolveConfiguredModel } from "../../executor/index.js";
import { extractJson, generateIssueViaLLM } from "./generate-issue.js";

function makeAssistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
	};
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
		(completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
			makeAssistantMessage('{"title":"Bug","body":"desc","labels":["bug"],"assignees":["a"]}'),
		);

		const result = await generateIssueViaLLM("owner", "repo", "prompt");
		expect(result).toEqual({
			title: "Bug",
			body: "desc",
			labels: ["bug"],
			assignees: ["a"],
		});
	});

	it("returns parsed issue when LLM wraps JSON in fences", async () => {
		const mockModel = { provider: "test", id: "model" };
		(resolveConfiguredModel as ReturnType<typeof vi.fn>).mockReturnValue(mockModel);
		(completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
			makeAssistantMessage('```json\n{"title":"Fenced","body":"b","labels":[],"assignees":[]}\n```'),
		);

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
		(completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
			makeAssistantMessage('Okay!\n{"title":"Wrapped","body":"b","labels":[],"assignees":[]}\nEnjoy!'),
		);

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
		(completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
			makeAssistantMessage("Just some random text"),
		);

		await expect(generateIssueViaLLM("owner", "repo", "prompt")).rejects.toThrow(
			/Could not extract valid JSON from LLM response\. Raw output:\nJust some random text/,
		);
	});
});