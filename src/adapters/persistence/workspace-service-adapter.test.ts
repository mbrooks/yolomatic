import { describe, expect, it, vi } from "vitest";

import { WorkspaceServiceAdapter } from "./workspace-service-adapter.js";

describe("WorkspaceServiceAdapter", () => {
	it("delegates every workspace operation to the manager", async () => {
		const manager = {
			createOrGetWorktree: vi.fn(async () => ({ path: "/tmp/ws", branch: "tars/issue-1" })),
			removeWorktree: vi.fn(async () => undefined),
			commitAndPush: vi.fn(async () => true),
			commitAndPushPath: vi.fn(async () => false),
			hasChanges: vi.fn(async () => true),
			getWorktreePath: vi.fn(() => "/tmp/ws"),
			getGitStatus: vi.fn(async () => " M src/index.ts"),
			getGitDiff: vi.fn(async () => "diff --git a/src/index.ts b/src/index.ts"),
		};
		const service = new WorkspaceServiceAdapter(manager as never);

		await expect(service.createOrGetWorktree("mbrooks", "tars", 1)).resolves.toEqual({
			path: "/tmp/ws",
			branch: "tars/issue-1",
		});
		await expect(service.removeWorktree("mbrooks", "tars", 1)).resolves.toBeUndefined();
		await expect(service.commitAndPush("mbrooks", "tars", 1, "msg")).resolves.toBe(true);
		await expect(service.commitAndPushPath("/tmp/ws", "tars/cron-1", "msg", "main")).resolves.toBe(false);
		await expect(service.hasChanges("/tmp/ws", true)).resolves.toBe(true);
		expect(service.getWorktreePath("mbrooks", "tars", 1)).toBe("/tmp/ws");
		await expect(service.getGitStatus("mbrooks", "tars", 1)).resolves.toBe(" M src/index.ts");
		await expect(service.getGitDiff("mbrooks", "tars", 1)).resolves.toBe(
			"diff --git a/src/index.ts b/src/index.ts",
		);

		expect(manager.createOrGetWorktree).toHaveBeenCalledWith("mbrooks", "tars", 1);
		expect(manager.removeWorktree).toHaveBeenCalledWith("mbrooks", "tars", 1);
		expect(manager.commitAndPush).toHaveBeenCalledWith("mbrooks", "tars", 1, "msg");
		expect(manager.commitAndPushPath).toHaveBeenCalledWith("/tmp/ws", "tars/cron-1", "msg", "main");
		expect(manager.hasChanges).toHaveBeenCalledWith("/tmp/ws", true);
		expect(manager.getWorktreePath).toHaveBeenCalledWith("mbrooks", "tars", 1);
		expect(manager.getGitStatus).toHaveBeenCalledWith("mbrooks", "tars", 1);
		expect(manager.getGitDiff).toHaveBeenCalledWith("mbrooks", "tars", 1);
	});
});
