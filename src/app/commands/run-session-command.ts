import type { Clock } from "../../ports/clock.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import { isTerminalStatus } from "../../domain/session/model.js";
import { canDelete, canPause, canRestart, canResume } from "../../domain/workflow/policy.js";
import { clearSessionLogs } from "../../logging/session-log-store.js";
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
	dispatched: boolean;
	status: string;
	message: string;
}

export type RestartSessionDispatcher = (owner: string, repo: string, issueNumber: number) => Promise<void>;

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
		private readonly restartSession?: RestartSessionDispatcher,
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
						message: "Cancellation signal sent. Yeetomatic will stop after completing the current step.",
					});
				}
				if (session.status === "working") {
					const updated = await this.sessions.cancelSession(owner, repo, issueNumber);
					session.status = updated.status;
				}
				return ok<CancelResult>({
					cancelled: false,
					wasActive,
					status: session.status,
					message: session.status === "cancelled" ? "Session marked as cancelled." : "Yeetomatic was not active on this session.",
				});
			}

			case "restart": {
				const check = canRestart(session.status);
				if (!check.ok) {
					return fail("invalid_state", check.reason);
				}
				if (this.tasks.isActive(key)) {
					return fail("conflict", "Session is already being executed");
				}
				const draining = this.tasks.isDraining();
				if (!draining && !this.restartSession) {
					return fail("internal", "Session restart dispatcher is not configured");
				}
				await this.workspaces.removeWorktree(owner, repo, issueNumber);
				clearSessionLogs(key);
				const restarted = await this.sessions.restartSession(owner, repo, issueNumber);
				if (draining) {
					const queued = await this.sessions.updateStatus(owner, repo, issueNumber, "pending", {
						resumeOnBoot: true,
					});
					return ok<RestartResult>({
						restarted: true,
						dispatched: false,
						status: queued.status,
						message: "Session reset and queued. Yeetomatic will restart it after the deploy completes.",
					});
				}

				void this.restartSession!(owner, repo, issueNumber).catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[admin] failed to dispatch restart for ${key}: ${message}\n`);
					void this.sessions
						.markFailed(owner, repo, issueNumber, `Admin restart dispatch failed: ${message}`)
						.catch((markError: unknown) => {
							const markMessage = markError instanceof Error ? markError.message : String(markError);
							process.stdout.write(`[admin] failed to record restart failure for ${key}: ${markMessage}\n`);
						});
				});
				return ok<RestartResult>({
					restarted: true,
					dispatched: true,
					status: restarted.status,
					message: "Session reset and restart dispatched. Yeetomatic is starting execution.",
				});
			}

			case "pause": {
				const pauseCheck = canPause(session.status);
				if (!pauseCheck.ok) {
					return fail("invalid_state", pauseCheck.reason);
				}
				const paused = await this.sessions.pauseSession(owner, repo, issueNumber);
				return ok<PauseResult>({
					paused: true,
					status: paused.status,
					message: "Session paused. It will not be picked up for execution until resumed.",
				});
			}

			case "resume": {
				const resumeCheck = canResume(session.status);
				if (!resumeCheck.ok) {
					return fail("invalid_state", resumeCheck.reason);
				}
				const resumed = await this.sessions.unpauseSession(owner, repo, issueNumber);
				return ok<ResumeResult>({
					resumed: true,
					status: resumed.status,
					message: "Session resumed. It will be picked up for execution on the next triggering event.",
				});
			}

			case "delete": {
				const deleteCheck = canDelete(session.status);
				if (!deleteCheck.ok) {
					return fail("invalid_state", deleteCheck.reason);
				}
				await this.workspaces.removeWorktree(owner, repo, issueNumber);
				clearSessionLogs(key);
				await this.sessions.delete(owner, repo, issueNumber);
				return ok<DeleteResult>({
					deleted: true,
					message: "Session and workspace deleted.",
				});
			}

			case "mark-failed": {
				let updated = await this.sessions.markFailed(owner, repo, issueNumber);
				if (!updated.summary) {
					updated = await this.sessions.updateStatus(owner, repo, issueNumber, updated.status, {
						summary: "Marked failed by admin cleanup.",
						staleDetectedAt: updated.staleDetectedAt,
						staleReason: updated.staleReason,
					});
				}
				return ok<MarkResult>({
					status: updated.status,
					message: "Session marked as failed.",
				});
			}

			case "mark-complete": {
				const updated = await this.sessions.markComplete(owner, repo, issueNumber);
				return ok<MarkResult>({
					status: updated.status,
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
