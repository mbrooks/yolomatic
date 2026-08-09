import { describe, expect, it, vi } from "vitest";
import { RunSessionCommand } from "./run-session-command.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { Clock } from "../../ports/clock.js";
import type { SessionState } from "../../session/store.js";

vi.mock("../../logging/session-log-store.js", () => ({
	clearSessionLogs: vi.fn(),
	recordSessionLog: vi.fn(),
}));

function makeMockRepo(state: SessionState | null = null): SessionRepository {
	return {
		get: vi.fn(async () => state),
		getAll: vi.fn(async () => (state ? [state] : [])),
		save: vi.fn(async (s) => s),
		delete: vi.fn(),
		archive: vi.fn(),
		createSession: vi.fn(),
		updateStatus: vi.fn(async (_owner, _repo, _issueNumber, status, updates) => ({
			...(state as SessionState),
			status,
			...updates,
		})),
		markSeeded: vi.fn(),
		associatePR: vi.fn(),
		incrementIterationCount: vi.fn(),
		findSessionByPR: vi.fn(),
		cancelSession: vi.fn(async () => ({ ...(state as SessionState), status: "cancelled" as const })),
		pauseSession: vi.fn(async () => ({ ...(state as SessionState), status: "paused" as const })),
		unpauseSession: vi.fn(async () => ({ ...(state as SessionState), status: "pending" as const })),
		restartSession: vi.fn(
			async () =>
				({
					...(state as SessionState),
					status: "pending" as const,
					summary: undefined,
					prNumber: undefined,
				}) satisfies SessionState,
		),
		markComplete: vi.fn(async () => ({ ...(state as SessionState), status: "complete" as const })),
		markFailed: vi.fn(async () => ({ ...(state as SessionState), status: "failed" as const })),
		markStale: vi.fn(),
	} as unknown as SessionRepository;
}

function makeState(status: SessionState["status"]): SessionState {
	return {
		owner: "mbrooks",
		repo: "yolomatic",
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
	deps?: Partial<{
		workspaces: WorkspaceService;
		tasks: TaskControlService;
		archiveDir: string;
		restartSession: ((owner: string, repo: string, issueNumber: number) => Promise<void>) | null;
	}>,
) {
	const repo = makeMockRepo(state);
	const workspaces: WorkspaceService = deps?.workspaces ?? {
		createOrGetWorktree: vi.fn(),
		updateDefaultBranchFromOrigin: vi.fn(async () => ({ branch: "main", before: null, after: "sha", updated: true })),
		syncWorktree: vi.fn(async () => undefined),
		removeWorktree: vi.fn(),
		commitAndPush: vi.fn(),
		commitAndPushPath: vi.fn(),
		hasChanges: vi.fn(async () => false),
		getWorktreePath: vi.fn(() => "/tmp/ws"),
		getGitStatus: vi.fn(async () => ""),
		getGitDiff: vi.fn(async () => ""),
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
	const restartSession =
		deps && "restartSession" in deps ? deps.restartSession ?? undefined : vi.fn(async () => undefined);
	const command = new RunSessionCommand(repo, workspaces, tasks, clock, deps?.archiveDir, restartSession);
	return { command, repo, workspaces, tasks, restartSession };
}

describe("RunSessionCommand", () => {
	it("cancels an active session", async () => {
		const state = makeState("working");
		const { command, tasks } = makeCommand(state);
		(tasks.cancel as ReturnType<typeof vi.fn>).mockReturnValue(true);
		const result = await command.execute("mbrooks", "yolomatic", 1, "cancel");
		expect(result.success).toBe(true);
		if (result.success) {
			expect("cancelled" in result.data && result.data.cancelled).toBe(true);
		}
		expect(tasks.cancel).toHaveBeenCalledWith("mbrooks/yolomatic#1");
	});

	it("marks session cancelled when not active", async () => {
		const state = makeState("working");
		const { command, repo } = makeCommand(state);
		const result = await command.execute("mbrooks", "yolomatic", 1, "cancel");
		expect(result.success).toBe(true);
		expect(repo.cancelSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
	});

	it("pauses a working session", async () => {
		const state = makeState("working");
		const { command, repo } = makeCommand(state);
		const result = await command.execute("mbrooks", "yolomatic", 1, "pause");
		expect(result.success).toBe(true);
		expect(repo.pauseSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
	});

	it("rejects pausing an already paused session", async () => {
		const state = makeState("paused");
		const { command } = makeCommand(state);
		const result = await command.execute("mbrooks", "yolomatic", 1, "pause");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("invalid_state");
		}
	});

	it("resumes a paused session", async () => {
		const state = makeState("paused");
		const { command, repo } = makeCommand(state);
		const result = await command.execute("mbrooks", "yolomatic", 1, "resume");
		expect(result.success).toBe(true);
		expect(repo.unpauseSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
	});

	it("rejects resuming a working session", async () => {
		const state = makeState("working");
		const { command } = makeCommand(state);
		const result = await command.execute("mbrooks", "yolomatic", 1, "resume");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("invalid_state");
		}
	});

	it("restarts a failed session", async () => {
		const state = makeState("failed");
		const { command, repo, workspaces, restartSession } = makeCommand(state);
		const result = await command.execute("mbrooks", "yolomatic", 1, "restart");
		expect(result.success).toBe(true);
		if (result.success && "dispatched" in result.data) {
			expect(result.data.dispatched).toBe(true);
		}
		expect(workspaces.removeWorktree).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
		expect(repo.restartSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
		expect(restartSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
	});

	it("restarts a cancelled session", async () => {
		const state = makeState("cancelled");
		const { command, restartSession } = makeCommand(state);
		const result = await command.execute("mbrooks", "yolomatic", 1, "restart");
		expect(result.success).toBe(true);
		expect(restartSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
	});

	it("rejects restart when the session is already active", async () => {
		const state = makeState("failed");
		const { command, tasks, repo, workspaces, restartSession } = makeCommand(state);
		(tasks.isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);
		const result = await command.execute("mbrooks", "yolomatic", 1, "restart");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("conflict");
		}
		expect(workspaces.removeWorktree).not.toHaveBeenCalled();
		expect(repo.restartSession).not.toHaveBeenCalled();
		expect(restartSession).not.toHaveBeenCalled();
	});

	it("queues restart for boot while draining", async () => {
		const state = makeState("failed");
		const { command, tasks, repo, restartSession } = makeCommand(state);
		(tasks.isDraining as ReturnType<typeof vi.fn>).mockReturnValue(true);
		const result = await command.execute("mbrooks", "yolomatic", 1, "restart");
		expect(result.success).toBe(true);
		if (result.success && "dispatched" in result.data) {
			expect(result.data.dispatched).toBe(false);
		}
		expect(repo.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "pending", {
			resumeOnBoot: true,
		});
		expect(restartSession).not.toHaveBeenCalled();
	});

	it("fails before resetting when restart dispatch is not configured", async () => {
		const state = makeState("failed");
		const { command, repo, workspaces } = makeCommand(state, { restartSession: null });
		const result = await command.execute("mbrooks", "yolomatic", 1, "restart");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("internal");
		}
		expect(workspaces.removeWorktree).not.toHaveBeenCalled();
		expect(repo.restartSession).not.toHaveBeenCalled();
	});

	it("marks a restarted session failed when dispatch rejects", async () => {
		const state = makeState("failed");
		const restartSession = vi.fn(async () => {
			throw new Error("dispatch unavailable");
		});
		const { command, repo } = makeCommand(state, { restartSession });
		const result = await command.execute("mbrooks", "yolomatic", 1, "restart");
		expect(result.success).toBe(true);
		await vi.waitFor(() => {
			expect(repo.markFailed).toHaveBeenCalledWith(
				"mbrooks",
				"yolomatic",
				1,
				"Admin restart dispatch failed: dispatch unavailable",
			);
		});
	});

	it("rejects restarting a completed session", async () => {
		const state = makeState("complete");
		const { command } = makeCommand(state);
		const result = await command.execute("mbrooks", "yolomatic", 1, "restart");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("invalid_state");
		}
	});

	it("deletes a terminal session", async () => {
		const state = makeState("complete");
		const { command, repo, workspaces } = makeCommand(state);
		const result = await command.execute("mbrooks", "yolomatic", 1, "delete");
		expect(result.success).toBe(true);
		expect(workspaces.removeWorktree).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
		expect(repo.delete).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "implementation");
	});

	it("rejects deleting a working session", async () => {
		const state = makeState("working");
		const { command } = makeCommand(state);
		const result = await command.execute("mbrooks", "yolomatic", 1, "delete");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("invalid_state");
		}
	});

	it("marks session as failed", async () => {
		const state = makeState("working");
		const { command, repo } = makeCommand(state);
		const result = await command.execute("mbrooks", "yolomatic", 1, "mark-failed");
		expect(result.success).toBe(true);
		expect(repo.markFailed).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
		expect(repo.updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			"failed",
			expect.objectContaining({ summary: "Marked failed by admin cleanup." }),
		);
	});

	it("marks session as complete", async () => {
		const state = makeState("working");
		const { command, repo } = makeCommand(state);
		const result = await command.execute("mbrooks", "yolomatic", 1, "mark-complete");
		expect(result.success).toBe(true);
		expect(repo.markComplete).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
	});

	it("archives a session when archiveDir is configured", async () => {
		const state = makeState("complete");
		const { command, repo } = makeCommand(state, { archiveDir: "/tmp/archive" });
		const result = await command.execute("mbrooks", "yolomatic", 1, "archive");
		expect(result.success).toBe(true);
		expect(repo.save).toHaveBeenCalled();
		expect(repo.archive).toHaveBeenCalledWith(expect.objectContaining({ archivedAt: expect.any(String) }), "/tmp/archive");
	});

	it("rejects archive when archiveDir is not configured", async () => {
		const state = makeState("complete");
		const { command } = makeCommand(state);
		const result = await command.execute("mbrooks", "yolomatic", 1, "archive");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("internal");
		}
	});

	it("prunes a worktree", async () => {
		const state = makeState("complete");
		const { command, workspaces } = makeCommand(state);
		const result = await command.execute("mbrooks", "yolomatic", 1, "prune-worktree");
		expect(result.success).toBe(true);
		expect(workspaces.removeWorktree).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
	});

	it("rejects pruning a dirty worktree without confirmation", async () => {
		const state = makeState("complete");
		const { command, workspaces } = makeCommand(state);
		(workspaces.hasChanges as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const result = await command.execute("mbrooks", "yolomatic", 1, "prune-worktree");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("conflict");
		}
	});

	it("allows pruning a dirty worktree with confirmation", async () => {
		const state = makeState("complete");
		const { command, workspaces } = makeCommand(state);
		(workspaces.hasChanges as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const result = await command.execute("mbrooks", "yolomatic", 1, "prune-worktree", { confirmDirty: true });
		expect(result.success).toBe(true);
		expect(workspaces.removeWorktree).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
	});

	it("returns not_found when session does not exist", async () => {
		const { command } = makeCommand(null);
		const result = await command.execute("mbrooks", "yolomatic", 1, "cancel");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("not_found");
		}
	});
});
