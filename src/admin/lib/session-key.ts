import type { Session } from "../app/types.js";

/**
 * Build the canonical session key for a session identity, matching the
 * persisted `SessionMetric.sessionKey` produced by the server's
 * `sessionStorageKey`. Reproduced here (rather than imported from the server
 * session store) so the admin bundle stays browser-safe and free of
 * `node:sqlite`.
 */
export function sessionKey(
	owner: string,
	repo: string,
	issueNumber: number,
	kind: Session["kind"],
): string {
	return `github-${owner}-${repo}-issue-${issueNumber}-${kind}`;
}