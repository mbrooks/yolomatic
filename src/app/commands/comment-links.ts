import type { SessionKind } from "../../session/store.js";

/**
 * Helpers for building and appending admin status-tracking links to the
 * user-facing comments Yeetomatic posts on issues.
 *
 * The admin SPA deep-links to a specific issue management view via the hash
 * route `#/repos/{owner}/{repo}/issues/{number}`, and to a live session view
 * via `#/repos/{owner}/{repo}/{issueNumber}/{kind}`. Constructing an
 * absolute, clickable URL requires a configured public admin base URL
 * (`admin_base_url`); when it is empty, links are omitted entirely.
 */

/** Remove a single trailing slash from a base URL (preserving the root `/`). */
function trimTrailingSlash(value: string): string {
	if (value.length > 1 && value.endsWith("/")) {
		return value.slice(0, -1);
	}
	return value;
}

/**
 * Build the absolute admin deep-link to a specific issue, or return
 * `undefined` when no public admin base URL is configured (callers omit the
 * link in that case).
 */
export function buildAdminIssueUrl(
	adminBaseUrl: string | undefined,
	owner: string,
	repo: string,
	issueNumber: number,
): string | undefined {
	if (!adminBaseUrl) {
		return undefined;
	}
	const trimmed = adminBaseUrl.trim();
	if (!trimmed) {
		return undefined;
	}
	return `${trimTrailingSlash(trimmed)}#/repos/${owner}/${repo}/issues/${issueNumber}`;
}

/**
 * Build the absolute admin deep-link to the live session view for a specific
 * issue and session kind (`#/repos/{owner}/{repo}/{issueNumber}/{kind}`), or
 * return `undefined` when no public admin base URL is configured (callers
 * omit the link in that case).
 */
export function buildAdminSessionUrl(
	adminBaseUrl: string | undefined,
	owner: string,
	repo: string,
	issueNumber: number,
	kind: SessionKind,
): string | undefined {
	if (!adminBaseUrl) {
		return undefined;
	}
	const trimmed = adminBaseUrl.trim();
	if (!trimmed) {
		return undefined;
	}
	return `${trimTrailingSlash(trimmed)}#/repos/${owner}/${repo}/${issueNumber}/${kind}`;
}

/**
 * Resolve the admin issue link to append to a comment, honoring the
 * "Enable links to admin in comments" toggle. Returns `undefined` when the
 * toggle is disabled or no admin base URL is configured.
 */
export function resolveAdminIssueUrl(
	adminBaseUrl: string | undefined,
	issueAdminLinkInCommentsEnabled: boolean | undefined,
	owner: string,
	repo: string,
	issueNumber: number,
): string | undefined {
	if (issueAdminLinkInCommentsEnabled === false) {
		return undefined;
	}
	return buildAdminIssueUrl(adminBaseUrl, owner, repo, issueNumber);
}

/**
 * Resolve the admin session-view link to append to a "picked up" progress
 * comment, honoring the "Enable links to admin in comments" toggle. Returns
 * `undefined` when the toggle is disabled or no admin base URL is configured.
 */
export function resolveAdminSessionUrl(
	adminBaseUrl: string | undefined,
	issueAdminLinkInCommentsEnabled: boolean | undefined,
	owner: string,
	repo: string,
	issueNumber: number,
	kind: SessionKind,
): string | undefined {
	if (issueAdminLinkInCommentsEnabled === false) {
		return undefined;
	}
	return buildAdminSessionUrl(adminBaseUrl, owner, repo, issueNumber, kind);
}

/**
 * Append a one-line status-tracking footer (`Track status: {url}`) to an
 * existing comment body when `adminIssueUrl` is provided. Returns the body
 * unchanged when no URL is supplied, and is idempotent: a body that already
 * contains a `Track status:` footer is returned as-is.
 */
export function appendAdminLink(body: string, adminIssueUrl?: string): string {
	if (!adminIssueUrl) {
		return body;
	}
	if (body.includes("Track status:")) {
		return body;
	}
	return `${body}\n\nTrack status: ${adminIssueUrl}`;
}