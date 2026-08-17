import { isTerminalStatus, type SessionState, type SessionStatus } from "../../session/store.js";
import type { CollaboratorPermission } from "../../ports/github-service.js";

interface IssueLabel {
	name?: string;
}

export const YOLO_WORKFLOW_LABELS = ["yolomatic-working", "yolomatic-feedback-required", "yolomatic-pr-created", "yolomatic-complete"] as const;
export const YOLO_VISIBLE_LABELS = [...YOLO_WORKFLOW_LABELS, "yolomatic"] as const;
export const DO_NOT_WORK_LABELS = ["wontfix", "invalid"] as const;

export function hasLabel(labels: IssueLabel[] | undefined, label: string): boolean {
	return (labels ?? []).some((item) => item.name === label);
}

export function hasAnyLabel(labels: IssueLabel[] | undefined, searchLabels: string[]): boolean {
	return (labels ?? []).some((item) => item.name && searchLabels.includes(item.name));
}

export function hasYolomaticVisibleLabel(labels: IssueLabel[] | undefined): boolean {
	return hasAnyLabel(labels, [...YOLO_VISIBLE_LABELS]);
}

export function isAssignedToYolomatic(
	issue: { assignee?: { login: string } | null; assignees?: { login: string }[] },
	githubUsername: string,
): boolean {
	if (issue.assignees && issue.assignees.some((a) => a.login === githubUsername)) return true;
	if (issue.assignee?.login === githubUsername) return true;
	return false;
}

export function isAdmin(senderLogin: string, adminGithubUsername: string | undefined): boolean {
	return !!adminGithubUsername && senderLogin === adminGithubUsername;
}

export function isAdminPermission(permission: CollaboratorPermission | null | undefined): boolean {
	return permission === "admin";
}

export function shouldIgnoreIssueEvent(
	payload: {
		action: string;
		issue: { assignee?: { login: string } | null; assignees?: { login: string }[]; labels?: IssueLabel[]; user?: { login: string } };
		sender: { login: string };
	},
	githubUsername: string,
	inFlight: boolean,
): { ignore: true; reason: string } | { ignore: false } {
	const { action, issue, sender } = payload;

	if (hasAnyLabel(issue.labels, [...DO_NOT_WORK_LABELS])) {
		return { ignore: true, reason: "issue marked do-not-work" };
	}

	if (sender.login === githubUsername) {
		return { ignore: true, reason: `event from ${githubUsername}` };
	}

	if (action === "opened" || action === "assigned") {
		if (!isAssignedToYolomatic(issue, githubUsername)) {
			return { ignore: true, reason: `not assigned to ${githubUsername}` };
		}
	}

	if (action === "unassigned") {
		if (isAssignedToYolomatic(issue, githubUsername)) {
			return { ignore: true, reason: "Yolomatic still assigned" };
		}
	}

	if (action === "edited") {
		const hasYolomaticLabel = hasYolomaticVisibleLabel(issue.labels);
		if (!isAssignedToYolomatic(issue, githubUsername) && !hasYolomaticLabel && issue.user?.login !== githubUsername) {
			return { ignore: true, reason: "not a Yolomatic issue" };
		}
	}

	if (inFlight) {
		return { ignore: true, reason: "already in flight" };
	}

	return { ignore: false };
}

/**
 * The `/yolomatic feedback` comment command, used as an explicit trigger for
 * the feedback flow.
 */
export const FEEDBACK_COMMAND = "/yolomatic feedback";

/**
 * Tests whether a comment body begins with the given `/yolomatic` command
 * token. The command must start the trimmed comment (case-insensitive), and
 * the character immediately after the command token must be either absent
 * (the command is the entire trimmed body) or whitespace. This rejects
 * embedded or quoted commands (e.g. `Please run /yolomatic feedback` or
 * `` `/yolomatic feedback` ``) so commands do not trigger when contained in
 * surrounding text. Leading and trailing whitespace around the comment is
 * stripped before matching.
 */
function commentStartsWithCommand(body: string, command: string): boolean {
	const trimmed = body.trim();
	if (trimmed.length === 0) {
		return false;
	}
	const lower = trimmed.toLowerCase();
	if (!lower.startsWith(command)) {
		return false;
	}
	if (trimmed.length === command.length) {
		return true;
	}
	return /\s/.test(trimmed[command.length]!);
}

/**
 * Whether a comment body is the `/yolomatic feedback` command. The command
 * must start the trimmed comment (case-insensitive) and must not be embedded
 * or quoted within surrounding text. Trailing text after the command is
 * allowed and is treated as the feedback payload. This is a trigger marker,
 * not a dispatch command routed to a handler.
 */
export function isFeedbackCommand(body: string): boolean {
	return commentStartsWithCommand(body, FEEDBACK_COMMAND);
}

/**
 * Whether a comment body explicitly triggers feedback by mentioning the
 * configured Yolomatic account (`@{githubUsername}` or `@yolomatic`) or by
 * starting the trimmed comment with the `/yolomatic feedback` command. The
 * Yolomatic-visible label is intentionally not part of this check.
 */
export function commentTriggersFeedback(body: string, githubUsername: string): boolean {
	const isMentioned =
		body.includes(`@${githubUsername}`) ||
		body.toLowerCase().includes("@yolomatic");
	return isMentioned || isFeedbackCommand(body);
}

export function shouldIgnoreCommentEvent(
	payload: {
		action: string;
		comment: { body: string; user: { login: string; type?: string } };
		issue: {
			state?: string;
			labels?: IssueLabel[];
			assignee?: { login: string } | null;
			assignees?: { login: string }[];
			user?: { login: string };
		};
	},
	githubUsername: string,
): { ignore: true; reason: string } | { ignore: false; isMentioned: boolean; isFeedbackCommand: boolean; isCreatedByYolomatic: boolean } {
	if (payload.action !== "created") {
		return { ignore: true, reason: `action is ${payload.action}` };
	}

	if (payload.issue.state === "closed") {
		return { ignore: true, reason: "issue is closed" };
	}

	if (payload.comment.user.login === githubUsername) {
		return { ignore: true, reason: `comment from ${githubUsername}` };
	}

	if (payload.comment.user.type === "Bot") {
		return { ignore: true, reason: "bot comment" };
	}

	const isAssigned = isAssignedToYolomatic(payload.issue, githubUsername);
	if (!isAssigned) {
		return { ignore: true, reason: `not assigned to ${githubUsername}` };
	}

	const isCreatedByYolomatic = payload.issue.user?.login === githubUsername;
	const isMentioned =
		payload.comment.body.includes(`@${githubUsername}`) ||
		payload.comment.body.toLowerCase().includes("@yolomatic");
	const isFeedbackCmd = isFeedbackCommand(payload.comment.body);

	// The comment gate requires assignment AND an explicit trigger (mention or
	// `/yolomatic feedback`). The Yolomatic-visible label is no longer part of
	// the gate (neither required nor sufficient).
	if (!isMentioned && !isFeedbackCmd) {
		return { ignore: true, reason: "no mention or /yolomatic feedback command" };
	}

	return { ignore: false, isMentioned, isFeedbackCommand: isFeedbackCmd, isCreatedByYolomatic };
}

const ISSUE_REFINEMENT_COMMAND = "/yolomatic issue-refinement";

/**
 * Parse an issue-refinement command from a comment body.
 *
 * Matching reuses the shared {@link commentStartsWithCommand} helper so the
 * start-of-body rule is identical to the other `/yolomatic` commands: the
 * command must start the trimmed comment (case-insensitive), and the character
 * after the command token must be either absent or whitespace. This rejects
 * embedded or quoted commands (e.g. `` `/yolomatic issue-refinement` `` or
 * `Please run /yolomatic issue-refinement`) and Markdown-wrapped tokens.
 *
 * When the command is the entire trimmed body, `steeringPrompt` is the empty
 * string. When the command is followed by whitespace then additional text, the
 * text after the command token (trimmed) is returned as the `steeringPrompt`.
 */
export function parseIssueRefinementCommand(
	body: string,
): { matched: true; steeringPrompt: string } | { matched: false } {
	if (!commentStartsWithCommand(body, ISSUE_REFINEMENT_COMMAND)) {
		return { matched: false };
	}
	const steeringPrompt = body.trim().slice(ISSUE_REFINEMENT_COMMAND.length).trim();
	return { matched: true, steeringPrompt };
}

export function isIssueRefinementCommand(commentBody: string): boolean {
	return parseIssueRefinementCommand(commentBody).matched;
}

export const FIX_MERGE_CONFLICTS_COMMAND = "/yolomatic fix-merge-conflicts";

/**
 * Whether a comment body is the `/yolomatic fix-merge-conflicts` command. The
 * command must start the trimmed comment (case-insensitive) and must not be
 * embedded or quoted within surrounding text. Trailing text after the command
 * token is allowed (and ignored); the command takes no arguments, but a
 * maintainer may add a short note without breaking the match.
 */
export function isFixMergeConflictsCommand(commentBody: string): boolean {
	return commentStartsWithCommand(commentBody, FIX_MERGE_CONFLICTS_COMMAND);
}

const STOP_COMMAND = "/yolomatic stop";

/**
 * Whether a comment body is the `/yolomatic stop` command. The command must
 * start the trimmed comment (case-insensitive) and must not be embedded or
 * quoted within surrounding text. No trailing text is accepted: stop takes no
 * arguments.
 */
export function isStopCommand(commentBody: string): boolean {
	return commentBody.trim().toLowerCase() === STOP_COMMAND;
}

export function canPause(status: SessionStatus): { ok: true } | { ok: false; reason: string } {
	if (status === "paused") return { ok: false, reason: "Session is already paused." };
	if (isTerminalStatus(status)) return { ok: false, reason: `Cannot pause a session in '${status}' status.` };
	return { ok: true };
}

export function canResume(status: SessionStatus): { ok: true } | { ok: false; reason: string } {
	if (status !== "paused") return { ok: false, reason: `Cannot resume a session in '${status}' status. Only paused sessions can be resumed.` };
	return { ok: true };
}

export function canRestart(status: SessionStatus): { ok: true } | { ok: false; reason: string } {
	if (status === "complete") return { ok: false, reason: "Cannot restart a completed session." };
	if (!isTerminalStatus(status)) return { ok: false, reason: `Cannot restart session in '${status}' status. Only failed or cancelled sessions can be restarted.` };
	return { ok: true };
}

export function canDelete(status: SessionStatus): { ok: true } | { ok: false; reason: string } {
	if (!isTerminalStatus(status)) {
		return { ok: false, reason: `Cannot delete session in '${status}' status. Only terminal sessions (complete, failed, cancelled) can be deleted.` };
	}
	return { ok: true };
}

export function formatUptime(seconds: number): string {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	const parts: string[] = [];
	if (d > 0) parts.push(`${d}d`);
	if (h > 0) parts.push(`${h}h`);
	if (m > 0) parts.push(`${m}m`);
	if (s > 0 || parts.length === 0) parts.push(`${s}s`);
	return parts.join(" ");
}
