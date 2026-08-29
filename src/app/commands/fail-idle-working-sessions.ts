import type { SessionKind, SessionState, SessionStatus } from "../../session/store.js";

/**
 * Human-readable stale/failure reason recorded on sessions failed by the
 * idle-working sweep. Threshold-accurate (the threshold is configurable), and
 * visible in the admin UI via `staleReason`/`summary`.
 */
export function idleWorkingFailReason(thresholdMs: number): string {
	const minutes = Math.max(1, Math.round(thresholdMs / 60000));
	return `no activity for over ${minutes} minutes`;
}

/**
 * Narrow session operations {@link FailIdleWorkingSessions} can call: list
 * every session and mark one failed. Composed from {@link SessionRepository}
 * (e.g. {@link SessionManager}) at the wiring boundary via structural typing.
 */
export interface IdleWorkingSweepSessionPort {
	getAll(): Promise<SessionState[]>;
	markFailed(
		owner: string,
		repo: string,
		issueNumber: number,
		reason?: string,
		kind?: SessionKind,
	): Promise<SessionState>;
}

/**
 * Narrow task-control operations {@link FailIdleWorkingSessions} can call:
 * check whether a session's task is currently registered as in-flight.
 * {@link GitHubIssueHandlers.isInFlight} satisfies this structurally and also
 * consults the {@link TaskControlService} registry.
 */
export interface IdleWorkingSweepTaskPort {
	isInFlight(owner: string, repo: string, issueNumber: number): boolean;
}

/**
 * Recurring sweep that fails sessions stuck in `working` with no activity for
 * longer than the configured idle timeout (default one hour). A wedged or lost
 * worker leaves a session showing `working` indefinitely; worker heartbeats
 * refresh `lastActivity` every few seconds, so an idle session is genuinely
 * stalled.
 *
 * Guards:
 * - Only `working` status is considered. `pending`, `waiting-feedback`,
 *   `paused`, and terminal sessions are ignored.
 * - A session whose task is registered as in-flight is never failed. The guard
 *   is essential for refinement runs, which do not refresh `lastActivity`
 *   while executing.
 * - Failing a session is store-only (stale reason + summary, matching the
 *   startup stale detection); no GitHub side effects are performed.
 */
export class FailIdleWorkingSessions {
	constructor(
		private readonly sessions: IdleWorkingSweepSessionPort,
		private readonly tasks: IdleWorkingSweepTaskPort,
	) {}

	async execute(thresholdMs: number, now: () => number = Date.now): Promise<{ failed: number; errors: number }> {
		const all = await this.sessions.getAll();
		const reason = idleWorkingFailReason(thresholdMs);
		let failed = 0;
		let errors = 0;

		for (const session of all) {
			if (session.status !== "working") {
				continue;
			}
			const idleMs = now() - new Date(session.lastActivity).getTime();
			// Strictly greater: a session idle for exactly the threshold has not
			// yet exceeded it.
			if (idleMs <= thresholdMs) {
				continue;
			}
			if (this.tasks.isInFlight(session.owner, session.repo, session.issueNumber)) {
				continue;
			}
			try {
				await this.sessions.markFailed(
					session.owner,
					session.repo,
					session.issueNumber,
					reason,
					session.kind ?? "implementation",
				);
				failed++;
				process.stdout.write(
					`[idle-sweep] failed ${session.owner}/${session.repo}#${session.issueNumber}: ${reason}\n`,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				errors++;
				process.stdout.write(
					`[idle-sweep] failed to mark ${session.owner}/${session.repo}#${session.issueNumber} as failed: ${message}\n`,
				);
			}
		}

		if (failed > 0 || errors > 0) {
			process.stdout.write(`[idle-sweep] ${failed} failed, ${errors} errors out of ${all.length} sessions\n`);
		}
		return { failed, errors };
	}
}