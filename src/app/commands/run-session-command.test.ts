import { describe, expect, it, vi } from "vitest";
import { RunSessionCommand } from "./run-session-command.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { Clock } from "../../ports/clock.js";
import type { SessionState } from "../../session/store.js";

function makeMockRepo(state: SessionState | null = null): SessionRepository {
	return {
		get: vi.fn(async () => state),
		getAll: vi.fn(async () => (state ? [state] : [])),
		save: vi.fn(async (s) => s),
		delete: vi.fn(),
		archive: vi.fn(),
		createSession: vi.fn(),
		updateStatus: vi.fn(),
		markSeeded: vi.fn(),
		associatePR: vi.fn(),
		incrementIterationCount: vi.fn(),
		findSessionByPR: vi.fn(),
		cancelSession: vi.fn(),
		pauseSession: vi.fn(),
		unpauseSession: vi.fn(),
		restartSession: vi.fn(),
		markComplete: vi.fn(),
		markFailed: vi.fn(),
		markStale: vi.fn(),
	} as unknown as SessionRepository;
}

function makeState(status: SessionState["status"]): SessionState {
	return {
		owner: "mbrooks",
		repo: "tars",
		issueNumber: 1,
		title: "Test",
		body: "Body",
		status,
		sessionPath: "/tmp/session.jsonl",
		workspacePath: "/tmp/ws",
		lastActivity: new Date().toISOString(),
		seeded: false,
	};
}

function makeCommand(
	state: SessionState | null,
	deps?: Partial<{ workspaces: WorkspaceService; tasks: TaskControlService; archiveDir: string }>,
) {
	const repo = makeMockRepo(state);
	const workspaces: WorkspaceService = deps?.workspaces ?? {
		createOrGetWorktree: vi.fn(),
		removeWorktree: vi.fn(),
		commitAndPush: vi.fn(),
		hasChanges: vi.fn(async () => false),
		getWorktreePath: vi.fn(() => "/tmp/ws"),
	};
	const tasks: TaskControlService = deps?.tasks ?? {
		cancel: vi.fn(() => false),
		isActive: vi.fn(() => false),
		steer: vi.fn(async () => false),
		register: vi.fn(),
		unregister: vi.fn(),
		isDraining: vi.fn(() => false),
		setDraining: vi.fn(),
	};
	const clock: Clock = { now: () => new Date("2026-01-01T00:00:00Z"), uptime: () => 0 };
	const command = new RunSessionCommand(repo, workspaces, tasks, clock, deps?.archiveDir);
	return { command, repo, workspaces, tasks };
}

describe("RunSessionCommand", () => {
	it("cancels an active session", async () => {
		const state = makeState("working");
		const { command, tasks } = makeCommand(state);
		(tasks.cancel as ReturnType<typeof vi.fn>).mockReturnValue(true);
		const result = await command.execute("mbrooks", "tars", 1, "cancel");
		expect(result.success).toBe(true);
		if (result.success) {
			expect("cancelled" in result.data && result.data.cancelled).toBe(true);
		}
		expect(tasks.cancel).toHaveBeenCalledWith("mbrooks/tars#1");
	});

	it("marks session cancelled when not active", async () => {
		const state = makeState("working");
		const { command, repo } = makeCommand(state);
		const result = await command.execute("mbrooks", "tars", 1, "cancel");
		expect(result.success).toBe(true);
		expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
	});

	it("pauses a working session", async () => {
		const state = makeState("working");
		const { command, repo } = makeCommand(state);
		const result = await command.execute("mbrooks", "tars", 1, "pause");
		expect(result.success).toBe(true);
		expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ status: "paused" }));
	});

	it("rejects pausing an already paused session", async () => {
		const state = makeState("paused");
		const { command } = makeCommand(state);
		const result = await command.execute("mbrooks", "tars", 1, "pause");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("invalid_state");
		}
	});

	it("resumes a paused session", async () => {
		const state = makeState("paused");
		const { command, repo } = makeCommand(state);
		const result = await command.execute("mbrooks", "tars", 1, "resume");
		expect(result.success).toBe(true);
		expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
	});

	it("rejects resuming a working session", async () => {
		const state = makeState("working");
		const { command } = makeCommand(state);
		const result = await command.execute("mbrooks", "tars", 1, "resume");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("invalid_state");
		}
	});

	it("restarts a failed session", async () => {
		const state = makeState("failed");
		const { command, repo, workspaces } = makeCommand(state);
		const result = await command.execute("mbrooks", "tars", 1, "restart");
		expect(result.success).toBe(true);
		expect(workspaces.removeWorktree).toHaveBeenCalledWith("mbrooks", "tars", 1);
		expect(repo.save).toHaveBeenCalledWith(
			expect.objectContaining({ status: "pending", summary: undefined, prNumber: undefined }),
		);
	});

	it("rejects restarting a completed session", async () => {
		const state = makeState("complete");
		const { command } = makeCommand(state);
		const result = await command.execute("mbrooks", "tars", 1, "restart");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("invalid_state");
		}
	});

	it("deletes a terminal session", async () => {
		const state = makeState("complete");
		const { command, repo, workspaces } = makeCommand(state);
		const result = await command.execute("mbrooks", "tars", 1, "delete");
		expect(result.success).toBe(true);
		expect(workspaces.removeWorktree).toHaveBeenCalledWith("mbrooks", "tars", 1);
		expect(repo.delete).toHaveBeenCalledWith("mbrooks", "tars", 1);
	});

	it("rejects deleting a working session", async () => {
		const state = makeState("working");
		const { command } = makeCommand(state);
		const result = await command.execute("mbrooks", "tars", 1, "delete");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("invalid_state");
		}
	});

	it("marks session as failed", async () => {
		const state = makeState("working");
		const { command, repo } = makeCommand(state);
		const result = await command.execute("mbrooks", "tars", 1, "mark-failed");
		expect(result.success).toBe(true);
		expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
	});

	it("marks session as complete", async () => {
		const state = makeState("working");
		const { command, repo } = makeCommand(state);
		const result = await command.execute("mbrooks", "tars", 1, "mark-complete");
		expect(result.success).toBe(true);
		expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ status: "complete" }));
	});

	it("archives a session when archiveDir is configured", async () => {
		const state = makeState("complete");
		const { command, repo } = makeCommand(state, { archiveDir: "/tmp/archive" });
		const result = await command.execute("mbrooks", "tars", 1, "archive");
		expect(result.success).toBe(true);
		expect(repo.save).toHaveBeenCalled();
		expect(repo.archive).toHaveBeenCalledWith(expect.objectContaining({ archivedAt: expect.any(String) }), "/tmp/archive");
	});

	it("rejects archive when archiveDir is not configured", async () => {
		const state = makeState("complete");
		const { command } = makeCommand(state);
		const result = await command.execute("mbrooks", "tars", 1, "archive");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("internal");
		}
	});

	it("prunes a worktree", async () => {
		const state = makeState("complete");
		const { command, workspaces } = makeCommand(state);
		const result = await command.execute("mbrooks", "tars", 1, "prune-worktree");
		expect(result.success).toBe(true);
		expect(workspaces.removeWorktree).toHaveBeenCalledWith("mbrooks", "tars", 1);
	});

	it("rejects pruning a dirty worktree without confirmation", async () => {
		const state = makeState("complete");
		const { command, workspaces } = makeCommand(state);
		(workspaces.hasChanges as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const result = await command.execute("mbrooks", "tars", 1, "prune-worktree");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("conflict");
		}
	});

	it("allows pruning a dirty worktree with confirmation", async () => {
		const state = makeState("complete");
		const { command, workspaces } = makeCommand(state);
		(workspaces.hasChanges as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const result = await command.execute("mbrooks", "tars", 1, "prune-worktree", { confirmDirty: true });
		expect(result.success).toBe(true);
		expect(workspaces.removeWorktree).toHaveBeenCalledWith("mbrooks", "tars", 1);
	});

	it("returns not_found when session does not exist", async () => {
		const { command } = makeCommand(null);
		const result = await command.execute("mbrooks", "tars", 1, "cancel");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("not_found");
		}
	});
});
