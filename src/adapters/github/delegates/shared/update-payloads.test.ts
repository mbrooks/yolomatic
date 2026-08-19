import { describe, expect, it } from "vitest";
import { buildStatefulUpdateFields } from "./update-payloads.js";

describe("buildStatefulUpdateFields", () => {
	it("includes only the title/body/state fields that are defined", () => {
		expect(buildStatefulUpdateFields({ title: "T", body: "B", state: "open" })).toEqual({
			title: "T",
			body: "B",
			state: "open",
		});
	});

	it("omits undefined fields", () => {
		expect(buildStatefulUpdateFields({ title: "T" })).toEqual({ title: "T" });
	});

	it("returns an empty object when no fields are provided", () => {
		expect(buildStatefulUpdateFields({})).toEqual({});
	});

	it("preserves empty-string body and title values", () => {
		expect(buildStatefulUpdateFields({ body: "" })).toEqual({ body: "" });
	});
});