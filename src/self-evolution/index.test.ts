import { describe, expect, it } from "vitest";

describe("self-evolution index", () => {
	it("exports expected members", async () => {
		const index = await import("./index.js");
		expect(typeof index.PatchGenerator).toBe("function");
		expect(typeof index.SafeDeployer).toBe("function");
		expect(typeof index.Validator).toBe("function");
		expect(typeof index.SelfEvolutionEngine).toBe("function");
		expect(typeof index.analyzeError).toBe("function");
		expect(typeof index.classifyFatalErrorCategory).toBe("function");
	});
});
