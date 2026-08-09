import { describe, expect, it } from "vitest";

import {
	formatIssue,
	formatPullRequest,
	type FetchedComment,
	type FetchedIssue,
	type FetchedPullRequest,
} from "./github-issues-format.js";

describe("formatIssue", () => {
	const baseIssue: FetchedIssue = {
		number: 539,
		title: "The worker github_fetch_issue tool returns only title.",
		body: "It needs to return the body/description as well to be helpful.",
		state: "open",
		labels: ["bug", "worker"],
		assignees: ["mbrooks"],
		html_url: "https://github.com/mbrooks/yolomatic/issues/539",
		created_at: "2026-08-03T00:00:00Z",
		updated_at: "2026-08-03T00:00:00Z",
	};

	it("renders the body, state, labels, assignees, and comments into the text", () => {
		const comments: FetchedComment[] = [
			{
				id: 1,
				body: "Picked up by Yolomatic.",
				author: "yolomatic-bot",
				created_at: "2026-08-03T00:01:00Z",
				updated_at: "2026-08-03T00:01:00Z",
				html_url: "https://github.com/mbrooks/yolomatic/issues/539#issuecomment-1",
			},
		];
		const text = formatIssue(baseIssue, comments);
		expect(text).toContain("Issue #539: The worker github_fetch_issue tool returns only title.");
		expect(text).toContain("State: open");
		expect(text).toContain("Labels: bug, worker");
		expect(text).toContain("Assignees: mbrooks");
		expect(text).toContain("https://github.com/mbrooks/yolomatic/issues/539");
		// The body — the core of issue #539 — must be present.
		expect(text).toContain("It needs to return the body/description as well to be helpful.");
		expect(text).toContain("Comments (1):");
		expect(text).toContain("@yolomatic-bot");
		expect(text).toContain("Picked up by Yolomatic.");
	});

	it("omits the labels/assignees lines when those lists are empty", () => {
		const issue: FetchedIssue = { ...baseIssue, labels: [], assignees: [] };
		const text = formatIssue(issue, []);
		expect(text).not.toContain("Labels:");
		expect(text).not.toContain("Assignees:");
		expect(text).not.toContain("Comments (");
	});

	it("renders a placeholder for an empty body", () => {
		const issue: FetchedIssue = { ...baseIssue, body: "" };
		const text = formatIssue(issue, []);
		expect(text).toContain("Body:");
		expect(text).toContain("(no body)");
	});

	it("renders multiple comments in order", () => {
		const comments: FetchedComment[] = [
			{
				id: 1,
				body: "first",
				author: "alice",
				created_at: "2026-08-03T00:01:00Z",
				updated_at: "2026-08-03T00:01:00Z",
				html_url: "u1",
			},
			{
				id: 2,
				body: "second",
				author: "bob",
				created_at: "2026-08-03T00:02:00Z",
				updated_at: "2026-08-03T00:02:00Z",
				html_url: "u2",
			},
		];
		const text = formatIssue(baseIssue, comments);
		expect(text).toContain("Comments (2):");
		expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
		expect(text).toContain("@alice");
		expect(text).toContain("@bob");
	});
});

describe("formatPullRequest", () => {
	const basePr: FetchedPullRequest = {
		number: 42,
		title: "Fix fetch_issue content",
		body: "Renders the full issue into content, not just the title.",
		state: "open",
		merged: false,
		head_ref: "yolomatic/issue-539",
		base_ref: "main",
		html_url: "https://github.com/mbrooks/yolomatic/pull/42",
		created_at: "2026-08-03T00:00:00Z",
		updated_at: "2026-08-03T00:00:00Z",
	};

	it("renders the PR body, branch, state, and comments", () => {
		const comments: FetchedComment[] = [
			{
				id: 2,
				body: "Looks good.",
				author: "mbrooks",
				created_at: "2026-08-03T00:02:00Z",
				updated_at: "2026-08-03T00:02:00Z",
				html_url: "https://github.com/mbrooks/yolomatic/pull/42#issuecomment-2",
			},
		];
		const text = formatPullRequest(basePr, comments);
		expect(text).toContain("PR #42: Fix fetch_issue content");
		expect(text).toContain("[open]");
		expect(text).toContain("Branch: yolomatic/issue-539 -> main");
		expect(text).toContain("Renders the full issue into content, not just the title.");
		expect(text).toContain("@mbrooks");
		expect(text).toContain("Looks good.");
	});

	it("annotates merged PRs", () => {
		const pr: FetchedPullRequest = { ...basePr, state: "closed", merged: true };
		const text = formatPullRequest(pr, []);
		expect(text).toContain("[closed (merged)]");
	});

	it("renders a placeholder for an empty PR body", () => {
		const pr: FetchedPullRequest = { ...basePr, body: "" };
		const text = formatPullRequest(pr, []);
		expect(text).toContain("(no body)");
	});
});