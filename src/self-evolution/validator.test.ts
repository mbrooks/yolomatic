import { describe, expect, it } from "vitest";
import { Validator } from "./validator.js";

describe("Validator", () => {
	it("returns ok for successful command", async () => {
		const v = new Validator();
		const result = await v.validate("node -e \"process.exit(0)\"");
		expect(result.ok).toBe(true);
	});

	it("returns not ok for failing command", async () => {
		const v = new Validator();
		const result = await v.validate("node -e \"process.exit(1)\"");
		expect(result.ok).toBe(false);
	});

	it("captures stdout for failing command", async () => {
		const v = new Validator();
		const result = await v.validate(`node -e "process.stdout.write('out'); process.exit(1)"`);
		expect(result.ok).toBe(false);
		expect(result.output).toContain("out");
	});

	it("captures stderr for failing command", async () => {
		const v = new Validator();
		const result = await v.validate(`node -e "process.stderr.write('err'); process.exit(1)"`);
		expect(result.ok).toBe(false);
		expect(result.output).toContain("err");
	});

	it("handles errors with missing stdout/stderr", async () => {
		const mockExec = async () => {
			const err = new Error("fail") as any;
			throw err;
		};
		const v = new Validator(mockExec as any);
		const result = await v.validate("foo");
		expect(result.ok).toBe(false);
		expect(result.output).toContain("fail");
	});
});
