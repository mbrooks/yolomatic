import type { SessionStatus } from "../app/types.js";

export const TERMINAL_STATUSES: readonly SessionStatus[] = ["complete", "failed", "cancelled"];
export const IN_PROGRESS_STATUSES: readonly SessionStatus[] = ["working", "pending", "waiting-feedback", "paused"];
export const PAUSABLE_STATUSES: readonly SessionStatus[] = ["working", "pending", "waiting-feedback"];

export function isTerminalStatus(status: SessionStatus): boolean {
	return TERMINAL_STATUSES.includes(status);
}

export function isInProgressStatus(status: SessionStatus): boolean {
	return IN_PROGRESS_STATUSES.includes(status);
}

export function isPausableStatus(status: SessionStatus): boolean {
	return PAUSABLE_STATUSES.includes(status);
}
