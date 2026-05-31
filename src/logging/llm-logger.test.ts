import { beforeEach, describe, expect, it, vi } from "vitest";

import { LlmLogger } from "./llm-logger.js";

describe("LlmLogger", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		delete process.env.LOG_LEVEL;
		delete process.env.LOG_PROMPTS;
		delete process.env.LOG_THOUGHTS;
		delete process.env.LOG_TOOLS;
		delete process.env.LOG_RESPONSES;
	});

	function getLines(): string[] {
		return (process.stdout.write as unknown as { mock: { calls: [string][] } }).mock.calls.map(
			(c) => c[0],
		);
	}

	it("logs with custom session tag when provided", () => {
		const logger = new LlmLogger("tars", 0, "tars-cron-abc123");
		logger.logPrompt("Hello world", 2);

		const lines = getLines();
		expect(lines.some((l) => l.includes("[tars-cron-abc123]"))).toBe(true);
	});

	it("logs prompts with token info", () => {
		const logger = new LlmLogger("tars", 42);
		logger.logPrompt("Hello world", 2);

		const lines = getLines();
		expect(lines.some((l) => l.includes("[prompt] Prompt sent (2 tokens)"))).toBe(true);
		expect(lines.some((l) => l.includes("[tars-issue-42]"))).toBe(true);
	});

	it("logs prompts with unknown tokens when not specified", () => {
		const logger = new LlmLogger("tars", 42);
		logger.logPrompt("Hello world");

		const lines = getLines();
		expect(lines.some((l) => l.includes("[prompt] Prompt sent (unknown tokens)"))).toBe(true);
	});

	it("truncates long prompts", () => {
		const logger = new LlmLogger("tars", 42);
		const longPrompt = "a".repeat(3000);
		logger.logPrompt(longPrompt);

		const lines = getLines();
		const contentLines = lines.filter((l) => !l.includes("Prompt sent"));
		expect(contentLines.some((l) => l.endsWith("...\n"))).toBe(true);
	});

	it("logs thoughts", () => {
		const logger = new LlmLogger("tars", 42);
		logger.logThought("I should check the handlers first.");

		const lines = getLines();
		expect(lines.some((l) => l.includes("[thought] I should check the handlers first."))).toBe(true);
	});

	it("skips empty thoughts", () => {
		const logger = new LlmLogger("tars", 42);
		logger.logThought("   ");

		expect(process.stdout.write).not.toHaveBeenCalled();
	});

	it("logs tool calls", () => {
		const logger = new LlmLogger("tars", 42);
		logger.logToolCall("read", { path: "./src/index.ts" });

		const lines = getLines();
		expect(lines.some((l) => l.includes('[tool:read] {"path":"./src/index.ts"}'))).toBe(true);
	});

	it("logs tool results", () => {
		const logger = new LlmLogger("tars", 42);
		logger.logToolResult("read", "file content here");

		const lines = getLines();
		expect(lines.some((l) => l.includes("[tool-result:read] file content here"))).toBe(true);
	});

	it("truncates long tool results", () => {
		const logger = new LlmLogger("tars", 42);
		const longResult = "b".repeat(600);
		logger.logToolResult("read", longResult);

		const lines = getLines();
		expect(lines.some((l) => l.endsWith("...\n"))).toBe(true);
	});

	it("logs responses", () => {
		const logger = new LlmLogger("tars", 42);
		logger.logResponse("TARS_STATUS: complete\nDone.");

		const lines = getLines();
		expect(lines.some((l) => l.includes("[response] TARS_STATUS: complete"))).toBe(true);
		expect(lines.some((l) => l.includes("[response] Done."))).toBe(true);
	});

	it("skips empty responses", () => {
		const logger = new LlmLogger("tars", 42);
		logger.logResponse("   ");

		expect(process.stdout.write).not.toHaveBeenCalled();
	});

	it("logs errors", () => {
		const logger = new LlmLogger("tars", 42);
		logger.logError(new Error("Something broke"), "Execution failed");

		const lines = getLines();
		expect(lines.some((l) => l.includes("[error] Execution failed: Something broke"))).toBe(true);
	});

	it("respects LOG_PROMPTS=false", () => {
		process.env.LOG_PROMPTS = "false";
		const logger = new LlmLogger("tars", 42);
		logger.logPrompt("Hello");

		expect(process.stdout.write).not.toHaveBeenCalled();
	});

	it("respects LOG_THOUGHTS=false", () => {
		process.env.LOG_THOUGHTS = "false";
		const logger = new LlmLogger("tars", 42);
		logger.logThought("Thinking...");

		expect(process.stdout.write).not.toHaveBeenCalled();
	});

	it("respects LOG_TOOLS=false", () => {
		process.env.LOG_TOOLS = "false";
		const logger = new LlmLogger("tars", 42);
		logger.logToolCall("read", { path: "./src" });
		logger.logToolResult("read", "content");

		expect(process.stdout.write).not.toHaveBeenCalled();
	});

	it("respects LOG_RESPONSES=false", () => {
		process.env.LOG_RESPONSES = "false";
		const logger = new LlmLogger("tars", 42);
		logger.logResponse("Done");

		expect(process.stdout.write).not.toHaveBeenCalled();
	});

	it("respects LOG_LEVEL=error (only errors logged)", () => {
		process.env.LOG_LEVEL = "error";
		const logger = new LlmLogger("tars", 42);
		logger.logPrompt("Hello");
		logger.logThought("Thinking");
		logger.logToolCall("read", {});
		logger.logToolResult("read", "content");
		logger.logResponse("Done");
		logger.logError(new Error("Bad"), "Oops");

		const lines = getLines();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("[error]");
	});

	it("uses full content in debug mode", () => {
		process.env.LOG_LEVEL = "debug";
		const logger = new LlmLogger("tars", 42);
		const longPrompt = "a".repeat(3000);
		logger.logPrompt(longPrompt);

		const lines = getLines();
		const contentLines = lines.filter((l) => !l.includes("Prompt sent"));
		const fullContent = contentLines.join("").replace(/\n/g, "");
		expect(fullContent).toContain("a".repeat(3000));
	});
});
