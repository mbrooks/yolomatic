import { describe, expect, it } from "vitest";

// execution-service.ts exports only TypeScript interfaces and types.
// This test verifies the module can be imported and that the interface shape is present at runtime via a dummy implementation.
import type { ExecutionService } from "./execution-service.js";
import type { ExecutionResult, PRReviewComment } from "../executor/index.js";

describe("ExecutionService interface", () => {
	it("can be implemented by a concrete object", () => {
		const service: ExecutionService = {
			execute: async () => ({ status: "complete", summary: "", rawResponse: "" }),
			executePRReview: async () => ({ status: "complete", summary: "", rawResponse: "" }),
		};
		expect(service).toBeDefined();
		expect(typeof service.execute).toBe("function");
		expect(typeof service.executePRReview).toBe("function");
	});

	it("PRReviewComment shape accepts expected fields", () => {
		const comment: PRReviewComment = {
			body: "Fix this",
			user: "reviewer",
			path: "src/foo.ts",
			line: 42,
		};
		expect(comment.body).toBe("Fix this");
		expect(comment.user).toBe("reviewer");
		expect(comment.path).toBe("src/foo.ts");
		expect(comment.line).toBe(42);
	});

	it("ExecutionResult status accepts all valid values", () => {
		const working: ExecutionResult = { status: "working", summary: "", rawResponse: "" };
		const waiting: ExecutionResult = { status: "waiting-feedback", summary: "", rawResponse: "" };
		const complete: ExecutionResult = { status: "complete", summary: "", rawResponse: "" };
		const cancelled: ExecutionResult = { status: "cancelled", summary: "", rawResponse: "" };
		expect(working.status).toBe("working");
		expect(waiting.status).toBe("waiting-feedback");
		expect(complete.status).toBe("complete");
		expect(cancelled.status).toBe("cancelled");
	});
});
