import { describe, expect, it } from "vitest";

import { buildFeedbackPrompt, buildIssuePrompt, buildPRReviewPrompt } from "./prompts.js";

describe("buildIssuePrompt", () => {
	it("includes issue metadata", () => {
		const state = {
			issueNumber: 42,
			owner: "mbrooks",
			repo: "tars",
			workspacePath: "/tmp/ws",
			title: "Fix bug",
			body: "Description here",
		} as never;
		const prompt = buildIssuePrompt(state);
		expect(prompt).toContain("#42");
		expect(prompt).toContain("mbrooks/tars");
		expect(prompt).toContain("/tmp/ws");
		expect(prompt).toContain("Fix bug");
		expect(prompt).toContain("Description here");
	});

	it("handles empty body", () => {
		const state = {
			issueNumber: 1,
			owner: "x",
			repo: "y",
			workspacePath: "/tmp",
			title: "T",
			body: "",
		} as never;
		const prompt = buildIssuePrompt(state);
		expect(prompt).toContain("(no description provided)");
	});
});

describe("buildFeedbackPrompt", () => {
	it("includes feedback text", () => {
		const prompt = buildFeedbackPrompt("Please retry.");
		expect(prompt).toContain("Please retry.");
		expect(prompt).toContain("Human feedback received");
	});

	it("trims feedback text", () => {
		const prompt = buildFeedbackPrompt("  trim me  ");
		expect(prompt).toContain("trim me");
		expect(prompt).not.toContain("  trim me  ");
	});
});

describe("buildPRReviewPrompt", () => {
	it("includes PR and issue metadata", () => {
		const state = {
			issueNumber: 56,
			owner: "mbrooks",
			repo: "tars",
			workspacePath: "/tmp/ws",
			title: "Fix bug",
			body: "Description here",
		} as never;
		const prompt = buildPRReviewPrompt(state, [{ body: "Fix typo", user: "reviewer", path: "src/foo.ts", line: 42 }]);
		expect(prompt).toContain("PR review feedback received");
		expect(prompt).toContain("issue #56");
		expect(prompt).toContain("mbrooks/tars");
		expect(prompt).toContain("tars/issue-56");
		expect(prompt).toContain("Fix typo");
		expect(prompt).toContain("src/foo.ts:42");
	});

	it("includes review body when provided", () => {
		const state = {
			issueNumber: 1,
			owner: "x",
			repo: "y",
			workspacePath: "/tmp",
			title: "T",
			body: "B",
		} as never;
		const prompt = buildPRReviewPrompt(state, [], "Please add tests");
		expect(prompt).toContain("Overall review comment:");
		expect(prompt).toContain("Please add tests");
	});

	it("handles comments without line info", () => {
		const state = {
			issueNumber: 2,
			owner: "a",
			repo: "b",
			workspacePath: "/tmp",
			title: "T",
			body: "B",
		} as never;
		const prompt = buildPRReviewPrompt(state, [{ body: "LGTM", user: "user" }]);
		expect(prompt).toContain("@user: LGTM");
		expect(prompt).not.toContain("undefined");
	});

	it("handles empty comments and no review body", () => {
		const state = {
			issueNumber: 3,
			owner: "a",
			repo: "b",
			workspacePath: "/tmp",
			title: "T",
			body: "B",
		} as never;
		const prompt = buildPRReviewPrompt(state, []);
		expect(prompt).toContain("Address the review feedback");
		expect(prompt).not.toContain("Overall review comment:");
		expect(prompt).not.toContain("Review comments:");
	});
});
