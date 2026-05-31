import { describe, expect, it } from "vitest";

import type { WorkspaceService } from "./workspace-service.js";

describe("WorkspaceService", () => {
	it("includes path-based push operations in the contract", () => {
		const service: WorkspaceService = {
			createOrGetWorktree: async () => ({ path: "/tmp/ws", branch: "tars/issue-1" }),
			removeWorktree: async () => undefined,
			commitAndPush: async () => true,
			commitAndPushPath: async () => false,
			hasChanges: async () => false,
			getWorktreePath: () => "/tmp/ws",
			getGitStatus: async () => "",
			getGitDiff: async () => "",
		};

		expect(typeof service.commitAndPushPath).toBe("function");
	});
});
