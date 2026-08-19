import type { ReviewComment } from "../../../../ports/github-service.js";
import type { GatewayIssueComment } from "../../../../ports/github-gateway-service.js";

/**
 * Shared response mappers for GitHub Octokit payloads that are normalized in
 * more than one place. Kept here (rather than per-delegate) so the normalized
 * shapes stay single-sourced and unit-testable in isolation.
 */

export type OctokitIssueLabelItem = string | { name?: string };

/** Normalize a GitHub issue/PR label list to non-empty name strings. */
export function mapIssueLabels(labels: readonly OctokitIssueLabelItem[] | undefined): string[] {
	return (labels ?? [])
		.map((label) => (typeof label === "string" ? label : label.name ?? ""))
		.filter((label): label is string => label.length > 0);
}

export interface OctokitIssueCommentData {
	id: number;
	body?: string | null;
	user?: { login: string } | null;
	created_at: string;
	updated_at: string;
	html_url: string;
}

/** Normalize a GitHub issue-style comment (issues or PRs) to the gateway shape. */
export function mapIssueComment(comment: OctokitIssueCommentData): GatewayIssueComment {
	return {
		id: comment.id,
		body: comment.body ?? "",
		author: comment.user?.login ?? "unknown",
		created_at: comment.created_at,
		updated_at: comment.updated_at,
		html_url: comment.html_url,
	};
}

export interface OctokitReviewCommentData {
	id: number;
	body?: string | null;
	user?: { login: string } | null;
	path?: string;
	line?: number | null;
}

/** Normalize a GitHub pull-request review comment to the shared review shape. */
export function mapReviewComment(rc: OctokitReviewCommentData): ReviewComment {
	return {
		id: rc.id,
		body: rc.body ?? "",
		user: rc.user ? { login: rc.user.login } : undefined,
		path: rc.path,
		line: rc.line,
	};
}