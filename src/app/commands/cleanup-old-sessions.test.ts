import { describe, expect, it, vi } from "vitest";

import { CleanupOldSessions, type CleanupSessionPort, type CleanupWorkspacePort } from "./cleanup-old-sessions.js";
import type { SessionState } from "../../session/store.js";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
	return {
		owner: "mbrooks",
		repo: "yolomatic",
		issueNumber: 341,
		title: "test",
		body: "",
		status: "complete",
		sessionPath: "/tmp/session.jsonl",
		workspacePath: "/tmp/worktree",
		lastActivity: new Date(0).toISOString(),
		seeded: false,
		...overrides,
	} as SessionState;
}

describe("CleanupOldSessions", () => {
	it("deletes stale terminal sessions and removes their worktrees", async () => {
		const stale = makeSession({ issueNumber: 341, status: "complete" });
		const recent = makeSession({
			issueNumber: 342,
			status: "complete",
			lastActivity: new Date().toISOString(),
		});
		const working = makeSession({
			issueNumber: 343,
			status: "working",
			lastActivity: new Date(0).toISOString(),
		});

		const sessions = {
			getAll: vi.fn(async () => [stale, recent, working]),
			delete: vi.fn(async () => {}),
		} satisfies CleanupSessionPort;
		const workspaces = {
			removeWorktree: vi.fn(async () => {}),
		} satisfies CleanupWorkspacePort;

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const command = new CleanupOldSessions(sessions, workspaces);
		const result = await command.execute(7);

		expect(result).toEqual({ deleted: 1, failed: 0 });
		expect(workspaces.removeWorktree).toHaveBeenCalledWith("mbrooks", "yolomatic", 341);
		expect(workspaces.removeWorktree).not.toHaveBeenCalledWith("mbrooks", "yolomatic", 342);
		expect(sessions.delete).toHaveBeenCalledWith("mbrooks", "yolomatic", 341, "implementation");

		writeSpy.mockRestore();
	});

	it("increments failed and does not delete the session when removeWorktree throws", async () => {
		const stale = makeSession({ issueNumber: 341, status: "failed" });

		const sessions = {
			getAll: vi.fn(async () => [stale]),
			delete: vi.fn(async () => {}),
		} satisfies CleanupSessionPort;
		const workspaces = {
			removeWorktree: vi.fn(async () => {
				throw new Error("git worktree remove failed");
			}),
		} satisfies CleanupWorkspacePort;

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const command = new CleanupOldSessions(sessions, workspaces);
		const result = await command.execute(7);

		expect(result).toEqual({ deleted: 0, failed: 1 });
		expect(sessions.delete).not.toHaveBeenCalled();
		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("failed to delete mbrooks/yolomatic#341"));

		writeSpy.mockRestore();
	});

	it("increments deleted and calls sessions.delete when removeWorktree succeeds with a dirty worktree", async () => {
		const stale = makeSession({ issueNumber: 341, status: "complete" });

		const sessions = {
			getAll: vi.fn(async () => [stale]),
			delete: vi.fn(async () => {}),
		} satisfies CleanupSessionPort;
		const workspaces = {
			removeWorktree: vi.fn(async () => {
				// Successful safe removal (stash + force fallback handled inside WorktreeManager).
			}),
		} satisfies CleanupWorkspacePort;

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const command = new CleanupOldSessions(sessions, workspaces);
		const result = await command.execute(7);

		expect(result).toEqual({ deleted: 1, failed: 0 });
		expect(workspaces.removeWorktree).toHaveBeenCalledWith("mbrooks", "yolomatic", 341);
		expect(sessions.delete).toHaveBeenCalledWith("mbrooks", "yolomatic", 341, "implementation");

		writeSpy.mockRestore();
	});
});
