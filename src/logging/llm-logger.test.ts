import { describe, expect, it, vi } from "vitest";

import { LlmLogger } from "./llm-logger.js";
import { DEFAULT_LOGGING_SETTINGS, type LoggingSettings } from "../runtime-settings.js";

describe("LlmLogger", () => {
	it("logs with custom session tag when provided", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 0, "yolomatic-job-abc123");
			logger.logPrompt("Hello world", 2);

			const lines = (stdout.mock.calls as unknown as [string][]).map((c) => c[0]);
			expect(lines.some((l) => l.includes("[yolomatic-job-abc123]"))).toBe(true);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("logs prompts with token info", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42);
			logger.logPrompt("Hello world", 2);

			const lines = (stdout.mock.calls as unknown as [string][]).map((c) => c[0]);
			expect(lines.some((l) => l.includes("[prompt] Prompt sent (2 tokens)"))).toBe(true);
			expect(lines.some((l) => l.includes("[yolomatic-issue-42]"))).toBe(true);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("logs prompts with unknown tokens when not specified", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42);
			logger.logPrompt("Hello world");

			const lines = (stdout.mock.calls as unknown as [string][]).map((c) => c[0]);
			expect(lines.some((l) => l.includes("[prompt] Prompt sent (unknown tokens)"))).toBe(true);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("truncates long prompts", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42);
			const longPrompt = "a".repeat(3000);
			logger.logPrompt(longPrompt);

			const lines = (stdout.mock.calls as unknown as [string][]).map((c) => c[0]);
			const contentLines = lines.filter((l) => !l.includes("Prompt sent"));
			expect(contentLines.some((l) => l.endsWith("...\n"))).toBe(true);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("logs thoughts", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42);
			logger.logThought("I should check the handlers first.");

			const lines = (stdout.mock.calls as unknown as [string][]).map((c) => c[0]);
			expect(lines.some((l) => l.includes("[thought] I should check the handlers first."))).toBe(true);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("skips empty thoughts", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42);
			logger.logThought("   ");

			expect(stdout).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("logs tool calls", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42);
			logger.logToolCall("read", { path: "./src/index.ts" });

			const lines = (stdout.mock.calls as unknown as [string][]).map((c) => c[0]);
			expect(lines.some((l) => l.includes('[tool:read] {"path":"./src/index.ts"}'))).toBe(true);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("logs tool results", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42);
			logger.logToolResult("read", "file content here");

			const lines = (stdout.mock.calls as unknown as [string][]).map((c) => c[0]);
			expect(lines.some((l) => l.includes("[tool-result:read] file content here"))).toBe(true);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("truncates long tool results", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42);
			const longResult = "b".repeat(600);
			logger.logToolResult("read", longResult);

			const lines = (stdout.mock.calls as unknown as [string][]).map((c) => c[0]);
			expect(lines.some((l) => l.endsWith("...\n"))).toBe(true);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("logs responses", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42);
			logger.logResponse("YOLO_STATUS: complete\nDone.");

			const lines = (stdout.mock.calls as unknown as [string][]).map((c) => c[0]);
			expect(lines.some((l) => l.includes("[response] YOLO_STATUS: complete"))).toBe(true);
			expect(lines.some((l) => l.includes("[response] Done."))).toBe(true);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("skips empty responses", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42);
			logger.logResponse("   ");

			expect(stdout).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("logs errors", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42);
			logger.logError(new Error("Something broke"), "Execution failed");

			const lines = (stdout.mock.calls as unknown as [string][]).map((c) => c[0]);
			expect(lines.some((l) => l.includes("[error] Execution failed: Something broke"))).toBe(true);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("defaults to the standard logging settings when no settings are injected", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42);
			logger.logPrompt("Hello");

			// Default settings: prompts enabled, info level.
			expect(stdout).toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("two logger instances can receive different explicit settings without modifying process.env", () => {
		const originalLevel = process.env.LOG_LEVEL;
		const originalPrompts = process.env.LOG_PROMPTS;
		try {
			const verbose: LoggingSettings = { ...DEFAULT_LOGGING_SETTINGS, logLevel: "debug" };
			const quiet: LoggingSettings = {
				logLevel: "error",
				logPrompts: false,
				logThoughts: false,
				logTools: false,
				logResponses: false,
			};

			const stdoutA = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const loggerA = new LlmLogger("yolomatic", 1, undefined, { loggingSettings: verbose });
			loggerA.logPrompt("a".repeat(3000));
			const aLines = (stdoutA.mock.calls as unknown as [string][]).map((c) => c[0]);
			stdoutA.mockRestore();

			const stdoutB = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const loggerB = new LlmLogger("yolomatic", 2, undefined, { loggingSettings: quiet });
			loggerB.logPrompt("quiet");
			loggerB.logError(new Error("boom"), "ctx");
			const bLines = (stdoutB.mock.calls as unknown as [string][]).map((c) => c[0]);
			stdoutB.mockRestore();

			// process.env must be untouched by injecting settings.
			expect(process.env.LOG_LEVEL).toBe(originalLevel);
			expect(process.env.LOG_PROMPTS).toBe(originalPrompts);

			// Verbose logger used the debug truncation limit (10000), so the full
			// prompt survived; quiet logger suppressed the prompt entirely.
			expect(aLines.some((l) => l.includes("a".repeat(3000)))).toBe(true);
			expect(bLines.some((l) => l.includes("[prompt]"))).toBe(false);
			expect(bLines.some((l) => l.includes("[error]"))).toBe(true);
		} finally {
			if (originalLevel === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = originalLevel;
			if (originalPrompts === undefined) delete process.env.LOG_PROMPTS;
			else process.env.LOG_PROMPTS = originalPrompts;
			vi.restoreAllMocks();
		}
	});

	it("respects injected logPrompts=false", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42, undefined, {
				loggingSettings: { ...DEFAULT_LOGGING_SETTINGS, logPrompts: false },
			});
			logger.logPrompt("Hello");

			expect(stdout).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("respects injected logThoughts=false", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42, undefined, {
				loggingSettings: { ...DEFAULT_LOGGING_SETTINGS, logThoughts: false },
			});
			logger.logThought("Thinking...");

			expect(stdout).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("respects injected logTools=false", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42, undefined, {
				loggingSettings: { ...DEFAULT_LOGGING_SETTINGS, logTools: false },
			});
			logger.logToolCall("read", { path: "./src" });
			logger.logToolResult("read", "content");

			expect(stdout).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("respects injected logResponses=false", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42, undefined, {
				loggingSettings: { ...DEFAULT_LOGGING_SETTINGS, logResponses: false },
			});
			logger.logResponse("Done");

			expect(stdout).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("respects injected logLevel=error (only errors logged)", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42, undefined, {
				loggingSettings: { ...DEFAULT_LOGGING_SETTINGS, logLevel: "error" },
			});
			logger.logPrompt("Hello");
			logger.logThought("Thinking");
			logger.logToolCall("read", {});
			logger.logToolResult("read", "content");
			logger.logResponse("Done");
			logger.logError(new Error("Bad"), "Oops");

			const lines = (stdout.mock.calls as unknown as [string][]).map((c) => c[0]);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("[error]");
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("uses full content in debug mode", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const logger = new LlmLogger("yolomatic", 42, undefined, {
				loggingSettings: { ...DEFAULT_LOGGING_SETTINGS, logLevel: "debug" },
			});
			const longPrompt = "a".repeat(3000);
			logger.logPrompt(longPrompt);

			const lines = (stdout.mock.calls as unknown as [string][]).map((c) => c[0]);
			const contentLines = lines.filter((l) => !l.includes("Prompt sent"));
			const fullContent = contentLines.join("").replace(/\n/g, "");
			expect(fullContent).toContain("a".repeat(3000));
		} finally {
			vi.restoreAllMocks();
		}
	});
});