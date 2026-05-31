import { describe, expect, it } from "vitest";
import { EmptyRepositoryError } from "./errors.js";

describe("EmptyRepositoryError", () => {
	it("has the correct name and message", () => {
		const error = new EmptyRepositoryError("/tmp/workspaces/mbrooks-tars");
		expect(error.name).toBe("EmptyRepositoryError");
		expect(error.message).toContain("Cannot resolve base branch");
		expect(error.message).toContain("/tmp/workspaces/mbrooks-tars");
		expect(error.message).toContain("appears to be empty");
	});

	it("exposes the bareRepoPath", () => {
		const error = new EmptyRepositoryError("/some/path");
		expect(error.bareRepoPath).toBe("/some/path");
	});
});
