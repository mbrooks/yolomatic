import { describe, expect, it } from "vitest";

import { classifyComment, classifyComments } from "./classifier.js";

describe("classifyComment", () => {
	it("classifies actionable keywords as actionable", () => {
		expect(classifyComment("Please fix the typo on line 42")).toBe("actionable");
		expect(classifyComment("Can you add a test for this edge case?")).toBe("actionable");
		expect(classifyComment("Can you update the docs?")).toBe("actionable");
		expect(classifyComment("You should change this approach")).toBe("actionable");
		expect(classifyComment("Remove the debug log")).toBe("actionable");
		expect(classifyComment("Refactor this function")).toBe("actionable");
		expect(classifyComment("nit: spacing is off")).toBe("actionable");
		expect(classifyComment("This needs more tests")).toBe("actionable");
		expect(classifyComment("Could you please fix the error handling?")).toBe("actionable");
	});

	it("classifies non-actionable keywords as discussion", () => {
		expect(classifyComment("LGTM")).toBe("discussion");
		expect(classifyComment("lgtm")).toBe("discussion");
		expect(classifyComment("Looks good to me")).toBe("discussion");
		expect(classifyComment("Thanks!")).toBe("discussion");
		expect(classifyComment("Thank you")).toBe("discussion");
		expect(classifyComment("question: why did you choose this approach?")).toBe("discussion");
		expect(classifyComment("Great work!")).toBe("discussion");
		expect(classifyComment("Awesome, nice work!")).toBe("discussion");
		expect(classifyComment("Well done")).toBe("discussion");
		expect(classifyComment("Nice!")).toBe("discussion");
	});

	it("prefers actionable when mixed with non-actionable", () => {
		// "LGTM" is non-actionable, but "fix" is actionable
		expect(classifyComment("LGTM, but please fix the typo")).toBe("actionable");
		expect(classifyComment("Looks good, can you add a comment?")).toBe("actionable");
		expect(classifyComment("Thanks! Could you update the readme too?")).toBe("actionable");
	});

	it("defaults to actionable for unclear comments", () => {
		expect(classifyComment("Hmm, not sure about this")).toBe("actionable");
		expect(classifyComment("What do you think?")).toBe("actionable");
		expect(classifyComment("Interesting choice")).toBe("actionable");
		expect(classifyComment("")).toBe("actionable");
	});
});

describe("classifyComments", () => {
	it("returns actionable if any comment is actionable", () => {
		expect(classifyComments(["LGTM", "Please fix the typo"])).toBe("actionable");
		expect(classifyComments(["Looks good", "Can you add a test?"])).toBe("actionable");
	});

	it("returns discussion only if all comments are discussion", () => {
		expect(classifyComments(["LGTM", "Thanks!"])).toBe("discussion");
		expect(classifyComments(["Looks good", "Great work", "Nice!"])).toBe("discussion");
	});

	it("returns actionable for empty array (no comments to classify)", () => {
		expect(classifyComments([])).toBe("discussion");
	});
});
