import path from "node:path";

import { describe, expect, it } from "vitest";

import { getBareRepoPath, getBranchName, getRepoKey, getWorktreePath, normalizeSegment } from "./paths.js";

describe("workspace paths", () => {
	it("normalizes repo segments and derived paths", () => {
		expect(getRepoKey("MBrooks", "CaseBot")).toBe("mbrooks-casebot");
		expect(getBareRepoPath("/tmp/workspaces", "MBrooks", "CaseBot")).toBe(
			path.join("/tmp/workspaces", "mbrooks-casebot"),
		);
		expect(getWorktreePath("/tmp/workspaces", "MBrooks", "CaseBot", 42)).toBe(
			path.join("/tmp/workspaces", "mbrooks-casebot", ".worktrees", "issue-42"),
		);
		expect(getBranchName(42)).toBe("tars/issue-42");
	});

	it("rejects empty or invalid path segments", () => {
		expect(() => normalizeSegment("   ", "owner")).toThrow("owner is required");
		expect(() => normalizeSegment("bad/name", "repo")).toThrow("Invalid repo: bad/name");
	});
});
