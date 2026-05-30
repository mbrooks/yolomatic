// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { parseHash, buildHash, navigate, useRoute } from "./routes.js";

describe("navigate", () => {
	beforeEach(() => {
		window.location.hash = "#/dashboard";
	});

	afterEach(() => {
		window.location.hash = "";
	});

	it("sets window.location.hash", () => {
		navigate({ screen: "settings", tab: "general" });
		expect(window.location.hash).toBe("#/settings");
	});
});

describe("useRoute", () => {
	beforeEach(() => {
		window.location.hash = "#/repos/mbrooks/tars";
	});

	afterEach(() => {
		window.location.hash = "";
	});

	it("returns current route from hash", () => {
		const { result } = renderHook(() => useRoute());
		expect(result.current).toEqual(expect.objectContaining({ screen: "repo", owner: "mbrooks", repo: "tars" }));
	});
});

describe("parseHash", () => {
	it("parses dashboard list", () => {
		expect(parseHash("#/dashboard")).toEqual({ screen: "dashboard" });
	});

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

	it("parses new-issue view with owner and repo", () => {
		expect(parseHash("#/new-issue/mbrooks/tars")).toEqual({ screen: "new-issue", owner: "mbrooks", repo: "tars" });
	});

	it("defaults to dashboard for unknown", () => {
		expect(parseHash("")).toEqual({ screen: "dashboard" });
	});

	it("parses repo detail (issues tab)", () => {
		expect(parseHash("#/repos/mbrooks/tars/issues")).toEqual({
			screen: "repo",
			owner: "mbrooks",
			repo: "tars",
			issueNumber: undefined,
			tab: "issues",
		});
	});

	it("parses server-skills view", () => {
		expect(parseHash("#/settings/skills")).toEqual({ screen: "settings", tab: "skills" });
	});
});

describe("buildHash", () => {
	it("builds dashboard view", () => {
		expect(buildHash({ screen: "dashboard" })).toBe("#/dashboard");
	});

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

	it("builds new-issue view with owner and repo", () => {
		expect(buildHash({ screen: "new-issue", owner: "mbrooks", repo: "tars" })).toBe("#/new-issue/mbrooks/tars");
	});

	it("builds repo detail with issues tab", () => {
		expect(
			buildHash({ screen: "repo", owner: "mbrooks", repo: "tars", issueNumber: undefined, tab: "issues" }),
		).toBe("#/repos/mbrooks/tars/issues");
	});

	it("round-trips issues tab", () => {
		const hash = buildHash({ screen: "repo" as const, owner: "mbrooks", repo: "tars", issueNumber: undefined, tab: "issues" as const });
		expect(parseHash(hash)).toEqual(expect.objectContaining({ screen: "repo", tab: "issues" }));
	});

	it("builds repo detail with skills tab", () => {
		expect(
			buildHash({ screen: "repo", owner: "mbrooks", repo: "tars", issueNumber: undefined, tab: "skills" }),
		).toBe("#/repos/mbrooks/tars/skills");
	});

	it("builds server-skills view", () => {
		expect(buildHash({ screen: "settings", tab: "skills" })).toBe("#/settings/skills");
	});

	it("round-trips skills tab", () => {
		const hash = buildHash({ screen: "repo" as const, owner: "mbrooks", repo: "tars", issueNumber: undefined, tab: "skills" as const });
		expect(parseHash(hash)).toEqual(expect.objectContaining({ screen: "repo", tab: "skills" }));
	});
});
