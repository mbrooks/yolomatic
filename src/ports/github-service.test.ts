import { describe, expect, it } from "vitest";
import { isPublicVisibility } from "./github-service.js";

describe("github-service types", () => {
	it("has no runtime exports to break", () => {
		expect(true).toBe(true);
	});

	it("identifies public visibility", () => {
		expect(isPublicVisibility("public")).toBe(true);
		expect(isPublicVisibility("private")).toBe(false);
		expect(isPublicVisibility("internal")).toBe(false);
	});
});
