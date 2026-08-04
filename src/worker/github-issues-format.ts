/**
 * Pure formatters that render gateway issue/PR/comment payloads as the text
 * content returned to the worker's agent model.
 *
 * The pi extension (`.pi/extensions/github-issues.ts`) calls the control-plane
 * gateway and hands the result to these formatters. The gateway result is also
 * attached to the tool `details` for logs/UI, but `details` is never shown to
 * the model; only the `content` text is. These formatters are therefore the
 * thing that makes `github_fetch_issue` / `github_fetch_pr` actually useful:
 * they put the body, state, labels, assignees, and comments into the text the
 * model can read.
 *
 * The shapes mirror `GatewayIssueDetail`, `GatewayIssueComment`, and
 * `GatewayPullRequestDetail` in `src/ports/github-gateway-service.ts` but are
 * redeclared locally so this module has no runtime dependency on the gateway
 * types and stays trivially unit-testable.
 */

export interface FetchedIssue {
	number: number;
	title: string;
	body: string;
	state: "open" | "closed";
	labels: string[];
	assignees: string[];
	html_url: string;
	created_at: string;
	updated_at: string;
}

export interface FetchedComment {
	id: number;
	body: string;
	author: string;
	created_at: string;
	updated_at: string;
	html_url: string;
}

export interface FetchedPullRequest {
	number: number;
	title: string;
	body: string;
	state: "open" | "closed";
	merged: boolean;
	head_ref: string;
	base_ref: string;
	html_url: string;
	created_at: string;
	updated_at: string;
}

function appendComments(lines: string[], comments: FetchedComment[]): void {
	if (comments.length === 0) return;
	lines.push("");
	lines.push(`Comments (${comments.length}):`);
	for (const comment of comments) {
		lines.push("");
		lines.push(`--- @${comment.author} (${comment.created_at}) ---`);
		lines.push(comment.body);
	}
}

/**
 * Render an issue and (optionally) its comments as the model-visible text
 * content of the `github_fetch_issue` tool.
 */
export function formatIssue(issue: FetchedIssue, comments: FetchedComment[]): string {
	const lines: string[] = [];
	lines.push(`Issue #${issue.number}: ${issue.title}`);
	lines.push(`State: ${issue.state}`);
	if (issue.labels.length > 0) {
		lines.push(`Labels: ${issue.labels.join(", ")}`);
	}
	if (issue.assignees.length > 0) {
		lines.push(`Assignees: ${issue.assignees.join(", ")}`);
	}
	lines.push(`URL: ${issue.html_url}`);
	lines.push("");
	lines.push("Body:");
	lines.push(issue.body.length > 0 ? issue.body : "(no body)");
	appendComments(lines, comments);
	return lines.join("\n");
}

/**
 * Render a pull request and (optionally) its issue-style comments as the
 * model-visible text content of the `github_fetch_pr` tool.
 */
export function formatPullRequest(pr: FetchedPullRequest, comments: FetchedComment[]): string {
	const lines: string[] = [];
	const merged = pr.merged ? " (merged)" : "";
	lines.push(`PR #${pr.number}: ${pr.title} [${pr.state}${merged}]`);
	lines.push(`Branch: ${pr.head_ref} -> ${pr.base_ref}`);
	lines.push(`URL: ${pr.html_url}`);
	lines.push("");
	lines.push("Body:");
	lines.push(pr.body.length > 0 ? pr.body : "(no body)");
	appendComments(lines, comments);
	return lines.join("\n");
}