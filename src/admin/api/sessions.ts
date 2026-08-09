import { apiGet, apiPost } from "./client.js";
import type { LogEntry, Session, SessionLogResponse } from "../app/types.js";

export function fetchSessionLog(
	owner: string,
	repo: string,
	issueNumber: number,
	kindOrSince: Session["kind"] | string = "implementation",
	since?: string,
): Promise<SessionLogResponse> {
	const isKind = kindOrSince === "implementation" || kindOrSince === "refinement";
	const kind: Session["kind"] = isKind ? kindOrSince : "implementation";
	const resolvedSince = isKind ? since : kindOrSince;
	const qs = resolvedSince ? `?since=${encodeURIComponent(resolvedSince)}` : "";
	return apiGet<SessionLogResponse>(
		`/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/${kind}/log${qs}`,
	);
}

export type SessionCommand =
	| { type: "cancel" }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "delete" }
	| { type: "restart" }
	| { type: "mark-failed" }
	| { type: "mark-complete" }
	| { type: "archive" }
	| { type: "prune-worktree"; confirmDirty?: boolean };

export type CommandResult = { ok: boolean; message: string };

export async function sendSessionCommand(
	owner: string,
	repo: string,
	issueNumber: number,
	kindOrCommand: Session["kind"] | SessionCommand,
	maybeCommand?: SessionCommand,
): Promise<CommandResult> {
	const kind: Session["kind"] = typeof kindOrCommand === "string" ? kindOrCommand : "implementation";
	const command = typeof kindOrCommand === "string" ? maybeCommand! : kindOrCommand;
	const path = `/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/${kind}/commands`;
	const payload = command.type === "prune-worktree" ? { confirmDirty: command.confirmDirty ?? true } : undefined;
	try {
		const data = await apiPost<{ message?: string; error?: string }>(path, {
			command: command.type,
			payload,
		});
		return { ok: true, message: data.message ?? "Done." };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message };
	}
}

export type SessionActionConfig = {
	key: string;
	label: string;
	loadingLabel: string;
	variant: string;
	confirmMessage: (session: Session) => string;
	command: (session: Session) => SessionCommand;
	visible: (status: SessionStatus) => boolean;
};

import type { SessionStatus } from "../app/types.js";
import { isTerminalStatus, isPausableStatus } from "../lib/status-helpers.js";

export const SESSION_ACTIONS: readonly SessionActionConfig[] = [
	{
		key: "cancel",
		label: "Stop",
		loadingLabel: "Stopping…",
		variant: "stop",
		confirmMessage: (s) => `Stop Yolomatic on ${s.owner}/${s.repo}#${s.issueNumber}?`,
		command: () => ({ type: "cancel" }),
		visible: (status) => status === "working" || status === "pending" || status === "waiting-feedback",
	},
	{
		key: "pause",
		label: "Pause",
		loadingLabel: "Pausing…",
		variant: "pause",
		confirmMessage: (s) => `Pause Yolomatic on ${s.owner}/${s.repo}#${s.issueNumber}?`,
		command: () => ({ type: "pause" }),
		visible: isPausableStatus,
	},
	{
		key: "resume",
		label: "Resume",
		loadingLabel: "Resuming…",
		variant: "resume",
		confirmMessage: (s) => `Resume Yolomatic on ${s.owner}/${s.repo}#${s.issueNumber}?`,
		command: () => ({ type: "resume" }),
		visible: (status) => status === "paused",
	},
	{
		key: "restart",
		label: "Restart",
		loadingLabel: "Restarting…",
		variant: "restart",
		confirmMessage: (s) =>
			`This will reset the workspace and re-queue the session for ${s.owner}/${s.repo}#${s.issueNumber}. Proceed?`,
		command: () => ({ type: "restart" }),
		visible: (status) => status === "failed" || status === "cancelled",
	},
	{
		key: "delete",
		label: "Delete",
		loadingLabel: "Deleting…",
		variant: "delete",
		confirmMessage: (s) =>
			`Delete session and workspace for ${s.owner}/${s.repo}#${s.issueNumber}? This cannot be undone.`,
		command: () => ({ type: "delete" }),
		visible: isTerminalStatus,
	},
	{
		key: "mark-failed",
		label: "Mark failed",
		loadingLabel: "Marking…",
		variant: "warn",
		confirmMessage: (s) => `Mark ${s.owner}/${s.repo}#${s.issueNumber} failed?`,
		command: () => ({ type: "mark-failed" }),
		visible: (status) => status !== "failed",
	},
	{
		key: "mark-complete",
		label: "Mark complete",
		loadingLabel: "Marking…",
		variant: "complete",
		confirmMessage: (s) => `Mark ${s.owner}/${s.repo}#${s.issueNumber} complete?`,
		command: () => ({ type: "mark-complete" }),
		visible: (status) => status !== "complete",
	},
	{
		key: "archive",
		label: "Archive",
		loadingLabel: "Archiving…",
		variant: "archive",
		confirmMessage: (s) =>
			`Archive ${s.owner}/${s.repo}#${s.issueNumber}? Session files will be moved to archive directory.`,
		command: () => ({ type: "archive" }),
		visible: () => true,
	},
	{
		key: "prune-worktree",
		label: "Prune worktree",
		loadingLabel: "Pruning…",
		variant: "prune",
		confirmMessage: (s) => `Prune worktree for ${s.owner}/${s.repo}#${s.issueNumber}?`,
		command: () => ({ type: "prune-worktree", confirmDirty: true }),
		visible: () => true,
	},
];
