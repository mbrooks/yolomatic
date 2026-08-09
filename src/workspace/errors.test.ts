import { describe, expect, it } from "vitest";
import { EmptyRepositoryError, WorktreeBranchDivergedError } from "./errors.js";

describe("EmptyRepositoryError", () => {
	it("has the correct name and message", () => {
		const error = new EmptyRepositoryError("/tmp/workspaces/mbrooks-yolomatic");
		expect(error.name).toBe("EmptyRepositoryError");
		expect(error.message).toContain("Cannot resolve base branch");
		expect(error.message).toContain("/tmp/workspaces/mbrooks-yolomatic");
		expect(error.message).toContain("appears to be empty");
	});

	it("exposes the bareRepoPath", () => {
		const error = new EmptyRepositoryError("/some/path");
		expect(error.bareRepoPath).toBe("/some/path");
	});
});

describe("WorktreeBranchDivergedError", () => {
	it("has the correct name, branch, and remoteRef", () => {
		const error = new WorktreeBranchDivergedError("yolomatic/issue-472", "origin/yolomatic/issue-472");
		expect(error.name).toBe("WorktreeBranchDivergedError");
		expect(error.branch).toBe("yolomatic/issue-472");
		expect(error.remoteRef).toBe("origin/yolomatic/issue-472");
		expect(error.message).toContain("diverged");
		expect(error.message).toContain("update-branch");
	});
});
