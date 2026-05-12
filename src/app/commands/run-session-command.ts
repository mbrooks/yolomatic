import type { Clock } from "../../ports/clock.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import { isTerminalStatus } from "../../domain/session/model.js";
import { canDelete, canPause, canRestart, canResume } from "../../domain/workflow/policy.js";
import { fail, ok, type AppResult } from "../result.js";

export type SessionCommand =
	| "cancel"
	| "restart"
	| "pause"
	| "resume"
	| "delete"
	| "mark-failed"
	| "mark-complete"
	| "archive"
	| "prune-worktree";

export interface CancelResult {
	cancelled: boolean;
	wasActive: boolean;
	status?: string;
	message: string;
}

export interface RestartResult {
	restarted: boolean;
	status: string;
	message: string;
}

export interface PauseResult {
	paused: boolean;
	status: string;
	message: string;
}

export interface ResumeResult {
	resumed: boolean;
	status: string;
	message: string;
}

export interface DeleteResult {
	deleted: boolean;
	message: string;
}

export interface MarkResult {
	status: string;
	message: string;
}

export interface ArchiveResult {
	archived: boolean;
	message: string;
}

export interface PruneWorktreeResult {
	pruned: boolean;
	message: string;
}

export type SessionCommandResult =
	| CancelResult
	| RestartResult
	| PauseResult
	| ResumeResult
	| DeleteResult
	| MarkResult
	| ArchiveResult
	| PruneWorktreeResult;

export class RunSessionCommand {
	constructor(
		private readonly sessions: SessionRepository,
		private readonly workspaces: WorkspaceService,
		private readonly tasks: TaskControlService,
		private readonly clock: Clock,
		private readonly archiveDir?: string,
	) {}

	async execute(
		owner: string,
		repo: string,
		issueNumber: number,
		command: SessionCommand,
		payload?: Record<string, unknown>,
	): Promise<AppResult<SessionCommandResult>> {
		const session = await this.sessions.get(owner, repo, issueNumber);
		if (!session) {
			return fail("not_found", "Session not found");
		}

		const key = `${owner}/${repo}#${issueNumber}`;
		const now = this.clock.now().toISOString();

		switch (command) {
			case "cancel": {
				const wasActive = this.tasks.isActive(key);
				const cancelled = this.tasks.cancel(key);
				if (cancelled) {
					return ok<CancelResult>({
						cancelled: true,
						wasActive,
						message: "Cancellation signal sent. TARS will stop after completing the current step.",
					});
				}
				if (session.status === "working") {
					session.status = "cancelled";
					session.lastActivity = now;
					await this.sessions.save(session);
				}
				return ok<CancelResult>({
					cancelled: false,
					wasActive,
					status: session.status,
					message: session.status === "cancelled" ? "Session marked as cancelled." : "TARS was not active on this session.",
				});
			}

			case "restart": {
				const check = canRestart(session.status);
				if (!check.ok) {
					return fail("invalid_state", check.reason);
				}
				await this.workspaces.removeWorktree(owner, repo, issueNumber);
				const originalStatus = session.status;
				session.status = "pending";
				session.summary = undefined;
				session.prUrl = undefined;
				session.prNumber = undefined;
				session.seeded = false;
				session.iterationCount = undefined;
				session.restartCount = (session.restartCount ?? 0) + 1;
				session.restartedFrom = originalStatus;
				session.lastActivity = now;
				await this.sessions.save(session);
				return ok<RestartResult>({
					restarted: true,
					status: "pending",
					message: "Session restarted. Workspace reset to fresh state. TARS will re-process on the next triggering event.",
				});
			}

			case "pause": {
				const pauseCheck = canPause(session.status);
				if (!pauseCheck.ok) {
					return fail("invalid_state", pauseCheck.reason);
				}
				session.status = "paused";
				session.lastActivity = now;
				await this.sessions.save(session);
				return ok<PauseResult>({
					paused: true,
					status: session.status,
					message: "Session paused. It will not be picked up for execution until resumed.",
				});
			}

			case "resume": {
				const resumeCheck = canResume(session.status);
				if (!resumeCheck.ok) {
					return fail("invalid_state", resumeCheck.reason);
				}
				session.status = "pending";
				session.lastActivity = now;
				await this.sessions.save(session);
				return ok<ResumeResult>({
					resumed: true,
					status: session.status,
					message: "Session resumed. It will be picked up for execution on the next triggering event.",
				});
			}

			case "delete": {
				const deleteCheck = canDelete(session.status);
				if (!deleteCheck.ok) {
					return fail("invalid_state", deleteCheck.reason);
				}
				await this.workspaces.removeWorktree(owner, repo, issueNumber);
				await this.sessions.delete(owner, repo, issueNumber);
				return ok<DeleteResult>({
					deleted: true,
					message: "Session and workspace deleted.",
				});
			}

			case "mark-failed": {
				session.status = "failed";
				session.summary = "Marked failed by admin cleanup.";
				session.lastActivity = now;
				await this.sessions.save(session);
				return ok<MarkResult>({
					status: session.status,
					message: "Session marked as failed.",
				});
			}

			case "mark-complete": {
				session.status = "complete";
				session.lastActivity = now;
				await this.sessions.save(session);
				return ok<MarkResult>({
					status: session.status,
					message: "Session marked as complete.",
				});
			}

			case "archive": {
				if (!this.archiveDir) {
					return fail("internal", "Archive directory not configured");
				}
				session.archivedAt = now;
				await this.sessions.save(session);
				await this.sessions.archive(session, this.archiveDir);
				return ok<ArchiveResult>({
					archived: true,
					message: "Session archived.",
				});
			}

			case "prune-worktree": {
				const worktreePath = this.workspaces.getWorktreePath(owner, repo, issueNumber);
				const dirty = await this.workspaces.hasChanges(worktreePath, false);
				if (dirty && !(payload?.confirmDirty === true)) {
					return fail("conflict", "Worktree is dirty. Pass confirmDirty=true to force.");
				}
				await this.workspaces.removeWorktree(owner, repo, issueNumber);
				return ok<PruneWorktreeResult>({
					pruned: true,
					message: "Worktree pruned.",
				});
			}

			default: {
				return fail("invalid_state", `Unknown command: ${command}`);
			}
		}
	}
}
