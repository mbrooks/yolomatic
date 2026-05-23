import { describe, expect, it } from "vitest";
import { parseHash, buildHash } from "./routes.js";

describe("parseHash", () => {
	it("parses repos list", () => {
		expect(parseHash("#/repos")).toEqual({ screen: "repos" });
	});

	it("parses repo detail (sessions tab)", () => {
		expect(parseHash("#/repos/mbrooks/tars")).toEqual({
			screen: "repo",
			owner: "mbrooks",
			repo: "tars",
			issueNumber: undefined,
			tab: "sessions",
		});
	});

	it("parses repo detail with issue number", () => {
		expect(parseHash("#/repos/mbrooks/tars/140")).toEqual({
			screen: "repo",
			owner: "mbrooks",
			repo: "tars",
			issueNumber: 140,
			tab: "sessions",
		});
	});

	it("parses repo detail (crons tab)", () => {
		expect(parseHash("#/repos/mbrooks/tars/crons")).toEqual({
			screen: "repo",
			owner: "mbrooks",
			repo: "tars",
			issueNumber: undefined,
			tab: "crons",
		});
	});

	it("parses working view", () => {
		expect(parseHash("#/working")).toEqual({ screen: "working" });
	});

	it("parses new-issue view", () => {
		expect(parseHash("#/new-issue")).toEqual({ screen: "new-issue" });
	});

	it("defaults to repos for unknown", () => {
		expect(parseHash("")).toEqual({ screen: "repos" });
	});
});

describe("buildHash", () => {
	it("builds repos list", () => {
		expect(buildHash({ screen: "repos" })).toBe("#/repos");
	});

	it("builds new-issue view", () => {
		expect(buildHash({ screen: "new-issue" })).toBe("#/new-issue");
	});

	it("builds repo detail", () => {
		expect(
			buildHash({ screen: "repo", owner: "mbrooks", repo: "tars", issueNumber: undefined, tab: "sessions" }),
		).toBe("#/repos/mbrooks/tars");
	});

	it("builds repo detail with crons tab", () => {
		expect(
			buildHash({ screen: "repo", owner: "mbrooks", repo: "tars", issueNumber: undefined, tab: "crons" }),
		).toBe("#/repos/mbrooks/tars/crons");
	});

	it("builds repo detail with issue number", () => {
		expect(
			buildHash({ screen: "repo", owner: "mbrooks", repo: "tars", issueNumber: 140, tab: "sessions" }),
		).toBe("#/repos/mbrooks/tars/140");
	});

	it("round-trips crons tab", () => {
		const hash = buildHash({ screen: "repo" as const, owner: "mbrooks", repo: "tars", issueNumber: undefined, tab: "crons" as const });
		expect(parseHash(hash)).toEqual(expect.objectContaining({ screen: "repo", tab: "crons" }));
	});
});
