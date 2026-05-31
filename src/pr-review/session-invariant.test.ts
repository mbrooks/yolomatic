import { describe, expect, it } from "vitest";

import type { SessionState } from "../session/store.js";
import {
	expectedBranchForIssue,
	extractIssueNumberFromBranch,
	validatePRSessionMapping,
} from "./session-invariant.js";

function session(overrides: Partial<SessionState> = {}): SessionState {
	return {
		issueNumber: 56,
		repo: "tars",
		owner: "mbrooks",
		title: "Title",
		body: "Body",
		status: "complete",
		sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-56.jsonl",
		workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-56",
		lastActivity: new Date().toISOString(),
		seeded: true,
		...overrides,
	};
}

describe("PR session invariants", () => {
	it("extracts issue numbers from TARS branches", () => {
		expect(extractIssueNumberFromBranch("tars/issue-56")).toBe(56);
		expect(extractIssueNumberFromBranch("feature/other")).toBeNull();
		expect(expectedBranchForIssue(56)).toBe("tars/issue-56");
	});

	it("accepts matching session, PR number, and head branch", () => {
		expect(validatePRSessionMapping(session({ prNumber: 99 }), 99, "tars/issue-56")).toBeNull();
	});

	it("rejects non-TARS head branches", () => {
		expect(validatePRSessionMapping(session(), 99, "feature/other")).toContain("not a TARS issue branch");
	});

	it("accepts non-issue branches when the PR is already associated with the session", () => {
		expect(validatePRSessionMapping(session({ prNumber: 99 }), 99, "tars/cron-job-123")).toBeNull();
	});

	it("rejects a head branch for a different issue", () => {
		expect(validatePRSessionMapping(session(), 99, "tars/issue-57")).toContain("issue #57");
	});

	it("rejects a session already associated with another PR", () => {
		expect(validatePRSessionMapping(session({ prNumber: 100 }), 99, "tars/issue-56")).toContain("PR #100");
	});
});
