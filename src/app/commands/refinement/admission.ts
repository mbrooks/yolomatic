import { parseIssueRefinementCommand } from "../../../domain/workflow/policy.js";

/**
 * Named reasons a refinement command is ignored before authorization is
 * considered. These cover the synchronous admission checks performed before
 * any GitHub or task-control I/O.
 */
export type RefinementAdmissionReason =
	| "ignored-action"
	| "unmatched-command"
	| "self-comment"
	| "bot-comment"
	| "pull-request-comment"
	| "closed-issue"
	| "unmanaged-repo"
	| "refinement-disabled";

/**
 * Named reasons a refinement command that passed the synchronous admission
 * checks is rejected before execution begins. Each carries the comment, log,
 * and stdout text the façade must emit, preserving the historical messages.
 */
export type RefinementConflictReason =
	| "unauthorized"
	| "already-in-flight"
	| "active-task"
	| "active-session"
	| "task-key-claimed";

export interface RefinementConflictDecision {
	outcome: "reject" | "proceed";
	reason?: RefinementConflictReason;
	comment?: string;
	log?: { level: "warn"; message: string };
	stdout?: string;
}

/** Inputs to {@link evaluateRefinementConflict} (the combined test entrypoint). */
export interface RefinementConflictInput {
	authorized: boolean;
	alreadyInFlight: boolean;
	taskActive: boolean;
	activeSessionKind?: "implementation" | "refinement";
	taskRegistered: boolean;
	senderLogin: string;
	key: string;
}

export interface RefinementRequestInput {
	action: string;
	commentBody: string;
	commentUserLogin: string;
	commentUserType?: string;
	issuePullRequest?: { url: string };
	issueState?: string;
	isRepoManaged: boolean;
	refinementEnabled: boolean | undefined;
	githubUsername: string;
	senderLogin: string;
	owner: string;
	repo: string;
	issueNumber: number;
}

export interface RefinementRequestDecision {
	outcome: "ignore" | "admit";
	reason?: RefinementAdmissionReason;
	/** stdout line emitted for the ignore case (after the command-received line, if any). */
	stdout?: string;
	/** stdout line emitted when the command was matched, before the ignore checks run. */
	commandStdout?: string;
	/** activity log emitted when the command was matched. */
	commandLog?: { level: "info"; message: string; details?: Record<string, unknown> };
	/** steering prompt trailing the command (empty string when none). */
	steeringPrompt?: string;
}

/**
 * Evaluate the synchronous admission checks for a refinement command. The
 * façade has already resolved the issue context. This function performs no
 * I/O; it returns either an {@link RefinementAdmissionReason} ignore decision
 * or an "admit" decision carrying the command-received log/stdout and steering
 * prompt so the façade can emit them in order before authorizing.
 */
export function evaluateRefinementRequest(input: RefinementRequestInput): RefinementRequestDecision {
	if (input.action !== "created") {
		return {
			outcome: "ignore",
			reason: "ignored-action",
			stdout: `[refinement] ignored: action is ${input.action}`,
		};
	}

	const parsed = parseIssueRefinementCommand(input.commentBody);
	if (!parsed.matched) {
		return { outcome: "ignore", reason: "unmatched-command" };
	}

	const steering = parsed.steeringPrompt;
	const commandLog: { level: "info"; message: string; details?: Record<string, unknown> } = {
		level: "info",
		message: `Refinement command received from @${input.senderLogin}`,
	};
	if (steering) commandLog.details = { steeringPrompt: steering };

	const commandStdout = `[refinement] command received for ${input.owner}/${input.repo}#${input.issueNumber}`;
	const base: RefinementRequestDecision = {
		outcome: "admit",
		commandStdout,
		commandLog,
		steeringPrompt: steering,
	};

	if (input.commentUserLogin === input.githubUsername) {
		return { ...base, outcome: "ignore", reason: "self-comment", stdout: `[refinement] ignored: comment from ${input.githubUsername}` };
	}
	if (input.commentUserType === "Bot") {
		return { ...base, outcome: "ignore", reason: "bot-comment", stdout: `[refinement] ignored: bot comment` };
	}
	if (input.issuePullRequest) {
		return { ...base, outcome: "ignore", reason: "pull-request-comment", stdout: `[refinement] ignored: comment is on a pull request` };
	}
	if (input.issueState === "closed") {
		return { ...base, outcome: "ignore", reason: "closed-issue", stdout: `[refinement] ignored: issue is closed` };
	}
	if (!input.isRepoManaged) {
		return { ...base, outcome: "ignore", reason: "unmanaged-repo", stdout: `[refinement] ignored: repository not managed` };
	}
	if (input.refinementEnabled === false) {
		return { ...base, outcome: "ignore", reason: "refinement-disabled", stdout: `[refinement] ignored: refinement disabled` };
	}

	return base;
}

/**
 * Stage 1 of conflict evaluation: the synchronous checks that need no session
 * or task-control I/O — authorization result, the in-flight guard, and the
 * active-task guard. The façade supplies `alreadyInFlight` from its in-flight
 * set (checked before the set is mutated) and `taskActive` from the task
 * control service. Returns `proceed` when all three pass.
 */
export function evaluateRefinementPreConflict(input: {
	authorized: boolean;
	alreadyInFlight: boolean;
	taskActive: boolean;
	senderLogin: string;
	key: string;
}): RefinementConflictDecision {
	if (!input.authorized) {
		return {
			outcome: "reject",
			reason: "unauthorized",
			comment: "Only repository collaborators can run issue refinement.",
			log: { level: "warn", message: `Refinement rejected: @${input.senderLogin} is not a repository collaborator` },
			stdout: `[refinement] ignored: ${input.senderLogin} is not a repository collaborator`,
		};
	}
	if (input.alreadyInFlight) {
		return {
			outcome: "reject",
			reason: "already-in-flight",
			comment: "Refinement is already running for this issue.",
			stdout: `[refinement] ignored: ${input.key} is already being refined`,
		};
	}
	if (input.taskActive) {
		return {
			outcome: "reject",
			reason: "active-task",
			comment: "Yolomatic is currently working on this issue. Refinement cannot overlap with implementation.",
			log: { level: "warn", message: "Refinement skipped: an implementation task is active" },
			stdout: `[refinement] ignored: ${input.key} has an active implementation task`,
		};
	}
	return { outcome: "proceed" };
}

/**
 * Stage 2 of conflict evaluation: the active-session guard. The façade has
 * fetched the persisted implementation/refinement sessions and supplies the
 * kind of the first working one (if any). Returns `proceed` when no working
 * session is active.
 */
export function evaluateRefinementSessionConflict(input: {
	activeSessionKind?: "implementation" | "refinement";
	key: string;
}): RefinementConflictDecision {
	if (input.activeSessionKind) {
		const kind = input.activeSessionKind;
		return {
			outcome: "reject",
			reason: "active-session",
			comment: "Yolomatic is currently working on this issue. Refinement cannot overlap with implementation.",
			log: { level: "warn", message: `Refinement skipped: an active ${kind} session exists` },
			stdout: `[refinement] ignored: ${input.key} has an active ${kind} session`,
		};
	}
	return { outcome: "proceed" };
}

/**
 * Stage 3 of conflict evaluation: the task-key registration guard. The façade
 * has attempted to register the task key and supplies whether registration
 * succeeded. Returns `proceed` when the key was claimed.
 */
export function evaluateRefinementRegistrationConflict(input: { taskRegistered: boolean; key: string }): RefinementConflictDecision {
	if (!input.taskRegistered) {
		return {
			outcome: "reject",
			reason: "task-key-claimed",
			comment: "Yolomatic is currently active on this issue. Refinement cannot overlap with implementation.",
			log: { level: "warn", message: "Refinement skipped: task key is already claimed" },
			stdout: `[refinement] ignored: ${input.key} task key is already claimed`,
		};
	}
	return { outcome: "proceed" };
}

/**
 * Combined conflict decision over all stages, taking every input at once.
 * Used by tests to assert the priority ordering of rejection reasons; the
 * façade calls the staged functions individually so it can short-circuit I/O
 * (session fetches and task registration) before later stages run.
 */
export function evaluateRefinementConflict(input: RefinementConflictInput): RefinementConflictDecision {
	const pre = evaluateRefinementPreConflict(input);
	if (pre.outcome === "reject") return pre;
	const session = evaluateRefinementSessionConflict(input);
	if (session.outcome === "reject") return session;
	return evaluateRefinementRegistrationConflict(input);
}