import { describe, expect, it } from "vitest";
import {
	mapIssueComment,
	mapIssueLabels,
	mapReviewComment,
} from "./mappers.js";

describe("mapIssueLabels", () => {
	it("maps object labels to their names and filters empties", () => {
		const result = mapIssueLabels([
			{ name: "bug" },
			{ name: "" },
			{ name: undefined },
			{ name: "ui" },
		]);
		expect(result).toEqual(["bug", "ui"]);
	});

	it("passes through string labels and drops empty strings", () => {
		expect(mapIssueLabels(["bug", "", "ui"])).toEqual(["bug", "ui"]);
	});

	it("returns an empty array when labels are undefined", () => {
		expect(mapIssueLabels(undefined)).toEqual([]);
	});
});

describe("mapIssueComment", () => {
	it("maps a comment with author and timestamps", () => {
		expect(
			mapIssueComment({
				id: 9,
				body: "hi",
				user: { login: "r" },
				created_at: "a",
				updated_at: "b",
				html_url: "u",
			}),
		).toEqual({
			id: 9,
			body: "hi",
			author: "r",
			created_at: "a",
			updated_at: "b",
			html_url: "u",
		});
	});

	it("coerces missing body to empty string and unknown author", () => {
		expect(
			mapIssueComment({
				id: 1,
				body: null,
				user: null,
				created_at: "a",
				updated_at: "b",
				html_url: "u",
			}),
		).toEqual({
			id: 1,
			body: "",
			author: "unknown",
			created_at: "a",
			updated_at: "b",
			html_url: "u",
		});
	});
});

describe("mapReviewComment", () => {
	it("maps a review comment with user, path, and line", () => {
		expect(
			mapReviewComment({
				id: 1,
				body: "nit",
				user: { login: "rev" },
				path: "a.ts",
				line: 3,
			}),
		).toEqual({ id: 1, body: "nit", user: { login: "rev" }, path: "a.ts", line: 3 });
	});

	it("uses undefined user and empty body when missing", () => {
		expect(
			mapReviewComment({ id: 2, body: null, user: null, path: "b.ts", line: null }),
		).toEqual({ id: 2, body: "", user: undefined, path: "b.ts", line: null });
	});
});