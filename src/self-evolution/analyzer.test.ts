import { describe, expect, it } from "vitest";
import { analyzeError, classifyFatalErrorCategory } from "./analyzer.js";
import { FatalSystemError } from "../self-monitor/index.js";

describe("analyzeError", () => {
	it("classifies FatalSystemError config-level categories as config-level", () => {
		const error = new FatalSystemError({
			toolHistory: [],
			fatalError: { category: "disk_full", message: "No space", toolName: "bash" },
			systemEvidence: {
				whoami: "t",
				pwd: "/tmp",
				workspacePath: "/tmp",
				lsWorkspace: "",
				gitStatus: "",
				gitDiff: "",
				gitBranch: "main",
				nodeVersion: "v20",
				timestamp: "2024-01-01T00:00:00Z",
			},
		});
		const result = analyzeError(error, "/app");
		expect(result.level).toBe("config-level");
		expect(result.description).toBe("No space");
	});

	it("classifies stack trace pointing to repo src as code-level", () => {
		const error = new Error("Cannot read properties of undefined");
		error.stack = `Error: Cannot read properties of undefined\n    at Object.doSomething (/app/src/self-evolution/engine.ts:42:10)\n    at processTicksAndRejections (internal/process/task_queues.js:97:5)`;
		const result = analyzeError(error, "/app");
		expect(result.level).toBe("code-level");
		expect(result.affectedFiles).toContain("/app/src/self-evolution/engine.ts");
	});

	it("classifies JSON errors as prompt-level", () => {
		const error = new Error("Unexpected token } in JSON at position 12");
		const result = analyzeError(error, "/app");
		expect(result.level).toBe("prompt-level");
	});

	it("classifies config/env errors as config-level", () => {
		const error = new Error("Missing .env variable WEBHOOK_SECRET");
		const result = analyzeError(error, "/app");
		expect(result.level).toBe("config-level");
	});

	it("defaults unknown errors without stack to code-level", () => {
		const error = new Error("something went wrong");
		const result = analyzeError(error, "/app");
		expect(result.level).toBe("code-level");
		expect(result.affectedFiles).toEqual([]);
	});
});

describe("classifyFatalErrorCategory", () => {
	it("returns config-level for permission_denied", () => {
		expect(classifyFatalErrorCategory("permission_denied")).toBe("config-level");
	});

	it("returns code-level for unknown categories", () => {
		expect(classifyFatalErrorCategory("unknown_category" as any)).toBe("code-level");
	});
});
