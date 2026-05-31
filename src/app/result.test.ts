import { describe, expect, it } from "vitest";
import { ok, fail, type AppResult } from "./result.js";

describe("AppResult", () => {
	it("ok wraps a value in a success result", () => {
		const result = ok(42);
		expect(result.success).toBe(true);
		expect(result.data).toBe(42);
	});

	it("fail wraps a code and message in a failure result", () => {
		const result = fail("not_found", "Session not found");
		expect(result.success).toBe(false);
		expect(result.code).toBe("not_found");
		expect(result.message).toBe("Session not found");
	});

	it("can represent a typed success", () => {
		const result: AppResult<string> = ok("hello");
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toBe("hello");
		}
	});

	it("can represent a typed failure", () => {
		const result: AppResult<string> = fail("invalid_state", "Bad state");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("invalid_state");
			expect(result.message).toBe("Bad state");
		}
	});
});
