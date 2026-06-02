import { isTerminalStatus } from "../session/model.js";
import type { SessionState, SessionStatus } from "../../session/store.js";

interface IssueLabel {
	name?: string;
}

export const TARS_WORKFLOW_LABELS = ["tars-working", "tars-feedback-required", "tars-pr-created", "tars-complete"] as const;
export const TARS_VISIBLE_LABELS = [...TARS_WORKFLOW_LABELS, "tars"] as const;

export function hasLabel(labels: IssueLabel[] | undefined, label: string): boolean {
	return (labels ?? []).some((item) => item.name === label);
}

export function hasAnyLabel(labels: IssueLabel[] | undefined, searchLabels: string[]): boolean {
	return (labels ?? []).some((item) => item.name && searchLabels.includes(item.name));
}

export function hasTarsVisibleLabel(labels: IssueLabel[] | undefined): boolean {
	return hasAnyLabel(labels, [...TARS_VISIBLE_LABELS]);
}

export function isAssignedToTars(
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

	if (sender.login === githubUsername) {
		return { ignore: true, reason: `event from ${githubUsername}` };
	}

	if (action === "opened" || action === "assigned") {
		if (!isAssignedToTars(issue, githubUsername)) {
			return { ignore: true, reason: `not assigned to ${githubUsername}` };
		}
	}

	if (action === "unassigned") {
		if (isAssignedToTars(issue, githubUsername)) {
			return { ignore: true, reason: "TARS still assigned" };
		}
	}

	if (action === "edited") {
		const hasTarsLabel = hasTarsVisibleLabel(issue.labels);
		if (!isAssignedToTars(issue, githubUsername) && !hasTarsLabel && issue.user?.login !== githubUsername) {
			return { ignore: true, reason: "not a TARS issue" };
		}
	}

	if (inFlight) {
		return { ignore: true, reason: "already in flight" };
	}

	return { ignore: false };
}

export function shouldIgnoreCommentEvent(
	payload: {
		action: string;
		comment: { body: string; user: { login: string; type?: string } };
		issue: {
			labels?: IssueLabel[];
			assignee?: { login: string } | null;
			assignees?: { login: string }[];
			user?: { login: string };
		};
	},
	githubUsername: string,
): { ignore: true; reason: string } | { ignore: false; isMentioned: boolean; isCreatedByTars: boolean } {
	if (payload.action !== "created") {
		return { ignore: true, reason: `action is ${payload.action}` };
	}

	if (payload.comment.user.login === githubUsername) {
		return { ignore: true, reason: `comment from ${githubUsername}` };
	}

	if (payload.comment.user.type === "Bot") {
		return { ignore: true, reason: "bot comment" };
	}

	const isAssigned = isAssignedToTars(payload.issue, githubUsername);
	const isCreatedByTars = payload.issue.user?.login === githubUsername;
	const isMentioned =
		payload.comment.body.includes(`@${githubUsername}`) ||
		payload.comment.body.toLowerCase().includes("@tars");
	const hasTarsLabel =
		hasTarsVisibleLabel(payload.issue.labels);

	if (!isAssigned && !isCreatedByTars && !isMentioned) {
		return { ignore: true, reason: "not assigned, not created by TARS, and no mention" };
	}

	if (isAssigned && !hasTarsLabel && !isMentioned) {
		return { ignore: true, reason: "no tars label or mention" };
	}

	return { ignore: false, isMentioned, isCreatedByTars };
}

export function isStopCommand(commentBody: string): boolean {
	return commentBody.trim().toLowerCase() === "/tars stop";
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
