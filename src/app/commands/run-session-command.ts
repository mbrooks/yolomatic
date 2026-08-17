import type { Clock } from "../../ports/clock.js";
import { isTerminalStatus, type SessionState } from "../../session/store.js";
import { canDelete, canPause, canRestart, canResume } from "../../domain/workflow/policy.js";
import { clearSessionLogs } from "../../logging/session-log-store.js";
import { sessionStorageKey } from "../../session/store.js";
import type { SessionKind } from "../../session/store.js";
import { fail, ok, type AppResult } from "../result.js";

/**
 * Narrow session operations {@link RunSessionCommand} can call. Composed from
 * {@link SessionRepository} at the wiring boundary via structural typing;
 * production adapters keep implementing the full interface.
 */
export interface RunSessionCommandSessionPort {
	get(owner: string, repo: string, issueNumber: number, kind?: SessionState["kind"]): Promise<SessionState | null>;
	cancelSession(owner: string, repo: string, issueNumber: number): Promise<SessionState>;
	pauseSession(owner: string, repo: string, issueNumber: number): Promise<SessionState>;
	unpauseSession(owner: string, repo: string, issueNumber: number): Promise<SessionState>;
	restartSession(owner: string, repo: string, issueNumber: number, kind?: SessionState["kind"]): Promise<SessionState>;
	delete(owner: string, repo: string, issueNumber: number, kind?: SessionState["kind"]): Promise<void>;
	markFailed(owner: string, repo: string, issueNumber: number, reason?: string, kind?: SessionState["kind"]): Promise<SessionState>;
	markComplete(owner: string, repo: string, issueNumber: number, kind?: SessionState["kind"]): Promise<SessionState>;
	updateStatus(
		owner: string,
		repo: string,
		issueNumber: number,
		status: SessionState["status"],
		updates?: Partial<Omit<SessionState, "repo" | "issueNumber" | "sessionPath">>,
		kind?: SessionState["kind"],
	): Promise<SessionState>;
	save(state: SessionState): Promise<SessionState>;
	archive(state: SessionState, archiveDir: string): Promise<void>;
}

/**
 * Narrow workspace operations {@link RunSessionCommand} can call: resolve a
 * worktree path, check for uncommitted changes, and remove a worktree.
 */
export interface RunSessionCommandWorkspacePort {
	getWorktreePath(owner: string, repo: string, issueNumber: number): string;
	hasChanges(workspacePath: string, cached?: boolean): Promise<boolean>;
	removeWorktree(owner: string, repo: string, issueNumber: number): Promise<void>;
}

/**
 * Narrow task-control operations {@link RunSessionCommand} can call: check
 * active execution, signal cancellation, and consult draining mode.
 */
export interface RunSessionCommandTaskPort {
	isActive(key: string): boolean;
	cancel(key: string): boolean;
	isDraining(): boolean;
}

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
		private readonly sessions: RunSessionCommandSessionPort,
		private readonly workspaces: RunSessionCommandWorkspacePort,
		private readonly tasks: RunSessionCommandTaskPort,
		private readonly clock: Clock,
		private readonly archiveDir?: string,
		private readonly restartSession?: RestartSessionDispatcher,
		private readonly restartRefinement?: RestartSessionDispatcher,
	) {}

	async execute(
		owner: string,
		repo: string,
		issueNumber: number,
		command: SessionCommand,
		payload?: Record<string, unknown>,
		kind: SessionKind = "implementation",
	): Promise<AppResult<SessionCommandResult>> {
		if (kind === "refinement" && command !== "restart" && command !== "mark-complete") {
			return fail("invalid_state", "Restart and Mark complete are the only commands available for refinement sessions");
		}
		const session = await this.sessions.get(owner, repo, issueNumber, kind);
		if (!session) {
			return fail("not_found", "Session not found");
		}

		const key = `${owner}/${repo}#${issueNumber}`;
		const logKey = sessionStorageKey(owner, repo, issueNumber, kind);
		const now = this.clock.now().toISOString();

		switch (command) {
			case "cancel": {
				const wasActive = this.tasks.isActive(key);
				const cancelled = this.tasks.cancel(key);
				if (cancelled) {
					return ok<CancelResult>({
						cancelled: true,
						wasActive,
						message: "Cancellation signal sent. Yolomatic will stop after completing the current step.",
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
					message: session.status === "cancelled" ? "Session marked as cancelled." : "Yolomatic was not active on this session.",
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
				if (kind === "refinement" && draining) {
					return fail("conflict", "Refinement cannot restart while a deployment is in progress");
				}
				const dispatcher = kind === "refinement" ? this.restartRefinement : this.restartSession;
				if (!draining && !dispatcher) {
					return fail("internal", "Session restart dispatcher is not configured");
				}
				if (kind === "implementation") {
					await this.workspaces.removeWorktree(owner, repo, issueNumber);
				}
				clearSessionLogs(logKey);
				const restarted = kind === "refinement"
					? await this.sessions.restartSession(owner, repo, issueNumber, kind)
					: await this.sessions.restartSession(owner, repo, issueNumber);
				if (draining) {
					const queued = await this.sessions.updateStatus(owner, repo, issueNumber, "pending", {
						resumeOnBoot: true,
					});
					return ok<RestartResult>({
						restarted: true,
						dispatched: false,
						status: queued.status,
						message: "Session reset and queued. Yolomatic will restart it after the deploy completes.",
					});
				}

				void dispatcher!(owner, repo, issueNumber).catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[admin] failed to dispatch restart for ${key}: ${message}\n`);
					const markFailed = kind === "refinement"
						? this.sessions.markFailed(owner, repo, issueNumber, `Admin restart dispatch failed: ${message}`, kind)
						: this.sessions.markFailed(owner, repo, issueNumber, `Admin restart dispatch failed: ${message}`);
					void markFailed
						.catch((markError: unknown) => {
							const markMessage = markError instanceof Error ? markError.message : String(markError);
							process.stdout.write(`[admin] failed to record restart failure for ${key}: ${markMessage}\n`);
						});
				});
				return ok<RestartResult>({
					restarted: true,
					dispatched: true,
					status: restarted.status,
					message: "Session reset and restart dispatched. Yolomatic is starting execution.",
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
				clearSessionLogs(logKey);
				await this.sessions.delete(owner, repo, issueNumber, "implementation");
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
				if (kind === "refinement") {
					if (this.tasks.isActive(key)) {
						return fail("conflict", "Refinement is currently active");
					}
					if (session.status !== "failed" && session.status !== "cancelled") {
						return fail("invalid_state", "Only failed or cancelled refinement sessions can be marked complete");
					}
				}
				const updated = kind === "refinement"
					? await this.sessions.markComplete(owner, repo, issueNumber, kind)
					: await this.sessions.markComplete(owner, repo, issueNumber);
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
