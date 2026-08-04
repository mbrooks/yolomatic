/**
 * GitHub Issues Extension for pi-coding-agent (worker/gateway mode)
 *
 * Provides scoped GitHub issue and pull-request management tools for the
 * Yeetomatic disposable worker. The worker never receives `GITHUB_TOKEN`;
 * every tool call is routed over the worker session WebSocket to the
 * control-plane {@link WorkerGitHubGateway}, which performs the GitHub call on
 * the worker's behalf and enforces session scope (current issue + its PRs).
 *
 * Tools are scoped to the live session: `owner`/`repo`/`issue_number` are not
 * accepted as parameters because they are implied by the session. PR tools
 * accept an optional `pr_number` that must match the session's linked PR or an
 * open PR on the session branch; any other target is rejected by the gateway.
 *
 * Tools:
 * - github_get_authenticated_user: Get the GitHub user the control plane authenticates as.
 * - github_fetch_issue: Read the live session issue (title, body, state, labels, assignees) + comments.
 * - github_set_comment: Add a comment to the live session issue.
 * - github_set_status: Update the live session issue state (open/closed) and/or assignee.
 * - github_set_labels: Replace/add/remove labels on the live session issue.
 * - github_update_issue: Update the live session issue title/body/state/labels/assignees.
 * - github_fetch_pr: Read the associated PR (metadata + issue-style comments).
 * - github_set_pr_comment: Add a comment to the associated PR.
 * - github_update_pr: Update the associated PR title/body/state/labels.
 * - github_list_pr_review_comments: Read review comments on the associated PR.
 *
 * Broad discovery tools (github_query_issues, github_assigned_open_issues) and
 * the token-probe form of github_get_authenticated_user are intentionally NOT
 * exposed: they cannot be scoped to the current issue.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { callGitHubGateway } from "../../src/worker/github-gateway-client.js";
import {
	formatIssue,
	formatPullRequest,
	type FetchedComment,
	type FetchedIssue,
	type FetchedPullRequest,
} from "../../src/worker/github-issues-format.js";


function ok(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function fail(action: string, message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: action ? `Error ${action}: ${message}` : message }],
		details: { success: false, error: message },
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown error";
}

export default function githubIssuesExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "github_get_authenticated_user",
		label: "GitHub Get Authenticated User",
		description:
			"Get the GitHub username the control plane authenticates as for this session. No token is exposed to the worker.",
		parameters: Type.Object({}),
		async execute() {
			try {
				const user = (await callGitHubGateway("get_authenticated_user", {})) as { login: string } | null;
				if (!user) return fail("", "Could not determine the authenticated GitHub user.");
				return ok(`Authenticated as ${user.login}`, { user, success: true });
			} catch (error) {
				return fail("fetching authenticated user", messageOf(error));
			}
		},
	});

	pi.registerTool({
		name: "github_fetch_issue",
		label: "GitHub Fetch Issue",
		description:
			"Read the live session issue: title, body, state, labels, assignees, and (by default) comments. Scoped to the current issue; no owner/repo/issue_number parameters.",
		parameters: Type.Object({
			include_comments: Type.Optional(Type.Boolean({ description: "Include issue comments (default: true)" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = (await callGitHubGateway("fetch_issue", {
					include_comments: params.include_comments ?? true,
				})) as { issue: FetchedIssue; comments: FetchedComment[] };
				return ok(formatIssue(result.issue, result.comments ?? []), {
					issue: result.issue,
					comments: result.comments,
					success: true,
				});
			} catch (error) {
				return fail("fetching issue", messageOf(error));
			}
		},
	});

	pi.registerTool({
		name: "github_set_comment",
		label: "GitHub Set Comment",
		description: "Add a comment to the live session issue. Scoped to the current issue.",
		parameters: Type.Object({
			body: Type.String({ description: "Comment text (Markdown supported)" }),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = (await callGitHubGateway("set_comment", { body: params.body })) as { comment_id: number };
				return ok("Comment added to the session issue", { comment_id: result.comment_id, success: true });
			} catch (error) {
				return fail("adding comment", messageOf(error));
			}
		},
	});

	pi.registerTool({
		name: "github_set_status",
		label: "GitHub Set Status",
		description:
			"Update the live session issue state (open/closed) and/or assignee. Scoped to the current issue.",
		parameters: Type.Object({
			state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
			assignee: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = (await callGitHubGateway("set_status", {
					...(params.state !== undefined ? { state: params.state } : {}),
					...(params.assignee !== undefined ? { assignee: params.assignee } : {}),
				})) as { state?: string; assignees?: string[] };
				return ok("Session issue updated", {
					state: result.state,
					assignees: result.assignees ?? [],
					success: true,
				});
			} catch (error) {
				return fail("updating issue", messageOf(error));
			}
		},
	});

	pi.registerTool({
		name: "github_set_labels",
		label: "GitHub Set Labels",
		description:
			"Replace, add, or remove labels on the live session issue. Scoped to the current issue.",
		parameters: Type.Object({
			labels: Type.Optional(Type.Array(Type.String(), { description: "Replace all labels with this array" })),
			addLabels: Type.Optional(Type.Array(Type.String(), { description: "Add these labels to existing labels" })),
			removeLabels: Type.Optional(Type.Array(Type.String(), { description: "Remove these labels from existing labels" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = (await callGitHubGateway("set_labels", {
					...(params.labels !== undefined ? { labels: params.labels } : {}),
					...(params.addLabels !== undefined ? { addLabels: params.addLabels } : {}),
					...(params.removeLabels !== undefined ? { removeLabels: params.removeLabels } : {}),
				})) as { labels: string[] };
				return ok("Labels updated on the session issue", { labels: result.labels, success: true });
			} catch (error) {
				return fail("updating labels", messageOf(error));
			}
		},
	});

	pi.registerTool({
		name: "github_update_issue",
		label: "GitHub Update Issue",
		description:
			"Update the live session issue title, body, state, labels, and/or assignees. Scoped to the current issue.",
		parameters: Type.Object({
			title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
			labels: Type.Optional(Type.Array(Type.String())),
			assignees: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_toolCallId, params) {
			try {
				await callGitHubGateway("update_issue", {
					...(params.title !== undefined ? { title: params.title } : {}),
					...(params.body !== undefined ? { body: params.body } : {}),
					...(params.state !== undefined ? { state: params.state } : {}),
					...(params.labels !== undefined ? { labels: params.labels } : {}),
					...(params.assignees !== undefined ? { assignees: params.assignees } : {}),
				});
				return ok("Session issue updated", { success: true });
			} catch (error) {
				return fail("updating issue", messageOf(error));
			}
		},
	});

	pi.registerTool({
		name: "github_fetch_pr",
		label: "GitHub Fetch Pull Request",
		description:
			"Read the PR associated with the session (metadata + issue-style comments). If pr_number is omitted, the session's linked PR (or the open PR on the session branch) is used.",
		parameters: Type.Object({
			pr_number: Type.Optional(Type.Number({ description: "Optional in-scope PR number; defaults to the session's PR" })),
			include_comments: Type.Optional(Type.Boolean({ description: "Include issue-style PR comments (default: true)" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = (await callGitHubGateway("fetch_pr", {
					...(params.pr_number !== undefined ? { pr_number: params.pr_number } : {}),
					include_comments: params.include_comments ?? true,
				})) as { pr: FetchedPullRequest; comments: FetchedComment[] };
				return ok(formatPullRequest(result.pr, result.comments ?? []), {
					pr: result.pr,
					comments: result.comments,
					success: true,
				});
			} catch (error) {
				return fail("fetching pull request", messageOf(error));
			}
		},
	});

	pi.registerTool({
		name: "github_set_pr_comment",
		label: "GitHub Set PR Comment",
		description: "Add a comment to the PR associated with the session.",
		parameters: Type.Object({
			body: Type.String({ description: "Comment text (Markdown supported)" }),
			pr_number: Type.Optional(Type.Number({ description: "Optional in-scope PR number; defaults to the session's PR" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = (await callGitHubGateway("set_pr_comment", {
					body: params.body,
					...(params.pr_number !== undefined ? { pr_number: params.pr_number } : {}),
				})) as { comment_id: number };
				return ok("Comment added to the session PR", { comment_id: result.comment_id, success: true });
			} catch (error) {
				return fail("adding PR comment", messageOf(error));
			}
		},
	});

	pi.registerTool({
		name: "github_update_pr",
		label: "GitHub Update Pull Request",
		description:
			"Update the PR associated with the session: title, body, state (open/closed), and/or labels. Does not merge or create PRs.",
		parameters: Type.Object({
			title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
			labels: Type.Optional(Type.Array(Type.String())),
			pr_number: Type.Optional(Type.Number({ description: "Optional in-scope PR number; defaults to the session's PR" })),
		}),
		async execute(_toolCallId, params) {
			try {
				await callGitHubGateway("update_pr", {
					...(params.title !== undefined ? { title: params.title } : {}),
					...(params.body !== undefined ? { body: params.body } : {}),
					...(params.state !== undefined ? { state: params.state } : {}),
					...(params.labels !== undefined ? { labels: params.labels } : {}),
					...(params.pr_number !== undefined ? { pr_number: params.pr_number } : {}),
				});
				return ok("Session PR updated", { success: true });
			} catch (error) {
				return fail("updating pull request", messageOf(error));
			}
		},
	});

	pi.registerTool({
		name: "github_list_pr_review_comments",
		label: "GitHub List PR Review Comments",
		description: "Read code review comments on the PR associated with the session.",
		parameters: Type.Object({
			pr_number: Type.Optional(Type.Number({ description: "Optional in-scope PR number; defaults to the session's PR" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = (await callGitHubGateway("list_pr_review_comments", {
					...(params.pr_number !== undefined ? { pr_number: params.pr_number } : {}),
				})) as { comments: unknown };
				return ok("Fetched review comments for the session PR", { comments: result.comments, success: true });
			} catch (error) {
				return fail("fetching PR review comments", messageOf(error));
			}
		},
	});
}