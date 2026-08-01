import { describe, expect, it } from "vitest";

import { extractText, getLastAssistantText, isExecutionEnvironmentBlocker, isRateLimitError, parseExecutionResult, parseRefinementResult } from "./results.js";

describe("parseExecutionResult", () => {
	it("parses working status", () => {
		const result = parseExecutionResult("YEETOMATIC_STATUS: working\nStill working.");
		expect(result.status).toBe("working");
		expect(result.summary).toBe("Still working.");
	});

	it("parses waiting-feedback status", () => {
		const result = parseExecutionResult("YEETOMATIC_STATUS: waiting-feedback\nNeed info.");
		expect(result.status).toBe("waiting-feedback");
		expect(result.summary).toBe("Need info.");
	});

	it("parses complete status", () => {
		const result = parseExecutionResult("YEETOMATIC_STATUS: complete\nDone.");
		expect(result.status).toBe("complete");
		expect(result.summary).toBe("Done.");
	});

	it("defaults to working for unknown status", () => {
		const result = parseExecutionResult("YEETOMATIC_STATUS: unknown\nOops.");
		expect(result.status).toBe("working");
		expect(result.summary).toBe("YEETOMATIC_STATUS: unknown\nOops.");
	});

	it("defaults to working when no status line is present", () => {
		const result = parseExecutionResult("Just some text.");
		expect(result.status).toBe("working");
		expect(result.summary).toBe("Just some text.");
	});

	it("trims whitespace", () => {
		const result = parseExecutionResult("\n  YEETOMATIC_STATUS: complete  \n  Summary  \n");
		expect(result.status).toBe("complete");
		expect(result.summary).toBe("Summary");
	});

	it("returns raw response as trimmed", () => {
		const result = parseExecutionResult("  raw  ");
		expect(result.rawResponse).toBe("raw");
	});

	it("falls back to trimmed response when summary is empty", () => {
		const result = parseExecutionResult("YEETOMATIC_STATUS: complete\n   ");
		expect(result.summary).toBe("YEETOMATIC_STATUS: complete");
	});

	it("finds status line anywhere in the response", () => {
		const result = parseExecutionResult("Some preamble.\nYEETOMATIC_STATUS: complete\nDone.");
		expect(result.status).toBe("complete");
		expect(result.summary).toBe("Done.");
	});

	it("uses the last status line when multiple are present", () => {
		const result = parseExecutionResult("YEETOMATIC_STATUS: working\nStill going.\nYEETOMATIC_STATUS: complete\nDone.");
		expect(result.status).toBe("complete");
		expect(result.summary).toBe("Done.");
	});

	it("ignores invalid status lines and finds a later valid one", () => {
		const result = parseExecutionResult("YEETOMATIC_STATUS: unknown\nOops.\nYEETOMATIC_STATUS: complete\nFixed.");
		expect(result.status).toBe("complete");
		expect(result.summary).toBe("Fixed.");
	});
});

describe("isRateLimitError", () => {
	it("returns true for Ollama 429 usage limit messages", () => {
		expect(isRateLimitError('429 "you (aubiematt) have reached your weekly usage limit..."')).toBe(true);
	});

	it("returns true for generic rate limit messages", () => {
		expect(isRateLimitError("429 rate limit exceeded")).toBe(true);
		expect(isRateLimitError("429 rate-limit exceeded")).toBe(true);
		expect(isRateLimitError("Too many requests 429")).toBe(true);
	});

	it("returns false for unrelated errors", () => {
		expect(isRateLimitError("something went wrong")).toBe(false);
		expect(isRateLimitError("500 internal server error")).toBe(false);
	});
});

describe("isExecutionEnvironmentBlocker", () => {
	it("returns true for missing cwd bootstrap failures", () => {
		expect(
			isExecutionEnvironmentBlocker(
				"The bash tool won't execute because the configured working directory (/workspaces/x) doesn't exist on this filesystem. Without a valid cwd, I can't run any bash commands.",
			),
		).toBe(true);
	});

	it("returns false for ordinary progress updates", () => {
		expect(isExecutionEnvironmentBlocker("Still working through the issue.")).toBe(false);
	});
});

describe("extractText", () => {
	it("returns strings as-is", () => {
		expect(extractText("hello")).toBe("hello");
	});

	it("extracts text and thinking items from array", () => {
		expect(extractText([
			{ type: "text", text: "hello" },
			{ type: "thinking", thinking: "thought" },
			{ type: "text", text: "world" },
		])).toBe("hello\nthought\nworld");
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

	it("ignores thinking blocks when visible text is present", () => {
		const session = {
			messages: [{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "I need to explain this clearly." },
					{ type: "text", text: "YEETOMATIC_STATUS: complete\nDone." },
				],
			}],
		};
		expect(getLastAssistantText(session)).toBe("YEETOMATIC_STATUS: complete\nDone.");
		expect(parseExecutionResult(getLastAssistantText(session)).status).toBe("complete");
	});

	it("falls back to thinking text when no visible text is present", () => {
		const session = {
			messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "still thinking" }] }],
		};
		expect(getLastAssistantText(session)).toBe("still thinking");
	});
});

describe("parseRefinementResult", () => {
	it("parses a valid JSON refinement result", () => {
		const raw = JSON.stringify({
			proposedTaskBody: "## Summary\nRefined.",
			summary: "Clarified requirements.",
			investigation: "Read README.",
		});
		const result = parseRefinementResult(raw);
		expect(result).not.toBeNull();
		expect(result!.proposedTaskBody).toBe("## Summary\nRefined.");
		expect(result!.summary).toBe("Clarified requirements.");
	});

	it("parses a fenced JSON refinement result", () => {
		const raw = "```json\n" + JSON.stringify({ proposedTaskBody: "Body", summary: "S", investigation: "I" }) + "\n```";
		const result = parseRefinementResult(raw);
		expect(result).not.toBeNull();
		expect(result!.proposedTaskBody).toBe("Body");
	});

	it("extracts a fenced JSON refinement result surrounded by commentary", () => {
		const raw = [
			"I now have a complete picture. Here is my refined task body.",
			"",
			"```json",
			JSON.stringify({
				proposedTaskBody: "## Summary\nRefined directly.",
				summary: "Clarified requirements.",
				investigation: "Read the implementation.",
			}),
			"```",
		].join("\n");

		const result = parseRefinementResult(raw);

		expect(result).not.toBeNull();
		expect(result!.proposedTaskBody).toBe("## Summary\nRefined directly.");
		expect(result!.summary).toBe("Clarified requirements.");
		expect(result!.investigation).toBe("Read the implementation.");
	});

	it("falls back to heuristic extraction", () => {
		const raw = "## Proposed Task\nRefined body.\n## Summary\nBetter description.\n## Investigation\nRead code.";
		const result = parseRefinementResult(raw);
		expect(result).not.toBeNull();
		expect(result!.proposedTaskBody).toBe("Refined body.");
		expect(result!.summary).toBe("Better description.");
	});

	it("returns null for empty input", () => {
		expect(parseRefinementResult("")).toBeNull();
	});

	it("returns null for JSON missing required fields", () => {
		expect(parseRefinementResult(JSON.stringify({ summary: "only summary" }))).toBeNull();
	});
});
