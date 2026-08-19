import { describe, expect, it } from "vitest";

import { sessionKey } from "./session-key.js";

describe("sessionKey", () => {
	it("builds the canonical github session key for an implementation session", () => {
		expect(sessionKey("mbrooks", "yolomatic", 42, "implementation")).toBe(
			"github-mbrooks-yolomatic-issue-42-implementation",
		);
	});

	it("builds the canonical github session key for a refinement session", () => {
		expect(sessionKey("octocat", "demo-repo", 7, "refinement")).toBe(
			"github-octocat-demo-repo-issue-7-refinement",
		);
	});

	it("preserves owner/repo casing and numeric issue ids without padding", () => {
		expect(sessionKey("Some-User", "My.Repo", 0, "implementation")).toBe(
			"github-Some-User-My.Repo-issue-0-implementation",
		);
	});
});