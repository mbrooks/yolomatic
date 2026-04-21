/**
 * GitHub Issues Extension for pi-coding-agent
 *
 * Provides GitHub issue management tools for TARS and direct pi-agent workflows.
 * 
 * Tools:
 * - github_get_authenticated_user: Get the GitHub username associated with the API token
 * - github_query_issues: Search/query for issues with filters
 * - github_fetch_issue: Get full details of a single issue including comments
 * - github_set_comment: Add a comment to an issue
 * - github_set_status: Update issue state (open/close) and/or assignee
 * - github_set_labels: Add/remove labels on an issue
 * - github_assigned_open_issues: Look up your username and query all open issues assigned to you across all repositories
 *
 * Requires GITHUB_TOKEN environment variable.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Octokit } from "@octokit/rest";
import { readFile } from "node:fs/promises";

// GitHub API types for return values
interface GitHubIssue {
	number: number;
	title: string;
	body: string;
	labels: Array<{ name: string }>;
	state: "open" | "closed";
	created_at: string;
	updated_at: string;
}

interface GitHubComment {
	id: number;
	body: string;
	user: { login: string };
	created_at: string;
	updated_at: string;
	html_url: string;
}

interface GitHubIssueFull extends GitHubIssue {
	comments?: GitHubComment[];
	html_url: string;
	assignees?: Array<{ login: string }>;
}

interface GitHubSearchIssue {
	url: string;
	repository_url: string;
	html_url: string;
	number: number;
	title: string;
	state: "open" | "closed";
	labels: Array<{ name: string }>;
	created_at: string;
	updated_at: string;
	repository: { full_name: string };
	assignees: Array<{ login: string }>;
}

function parseDotEnv(content: string): Map<string, string> {
	const values = new Map<string, string>();

	for (const rawLine of content.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}

		const separatorIndex = line.indexOf("=");
		if (separatorIndex <= 0) {
			continue;
		}

		const key = line.slice(0, separatorIndex).trim();
		let value = line.slice(separatorIndex + 1).trim();

		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		values.set(key, value);
	}

	return values;
}

async function getGitHubToken(cwd: string): Promise<string | null> {
	const direct = process.env.GITHUB_TOKEN?.trim();
	if (direct) {
		return direct;
	}

	try {
		const envFile = await readFile(`${cwd}/.env`, "utf-8");
		return parseDotEnv(envFile).get("GITHUB_TOKEN")?.trim() ?? null;
	} catch {
		return null;
	}
}

// Helper to get Octokit instance
async function getOctokit(cwd: string): Promise<Octokit> {
	const token = await getGitHubToken(cwd);
	if (!token) {
		throw new Error("GITHUB_TOKEN environment variable is not set");
	}
	return new Octokit({ auth: token });
}

// Validate owner/repo format
function validateOwnerRepo(owner: string, repo: string): void {
	if (!owner || !/^[a-zA-Z0-9_-]+$/.test(owner)) {
		throw new Error(`Invalid owner: ${owner}`);
	}
	if (!repo || !/^[a-zA-Z0-9._-]+$/.test(repo)) {
		throw new Error(`Invalid repo: ${repo}`);
	}
}

export default function githubIssuesExtension(pi: ExtensionAPI) {
	// Tool 1: github_get_authenticated_user
	pi.registerTool({
		name: "github_get_authenticated_user",
		label: "GitHub Get Authenticated User",
		description: "Get the GitHub username and profile info associated with the current API token",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
			try {
				const octokit = await getOctokit(ctx.cwd);

				const response = await octokit.users.getAuthenticated();

				const user = {
					login: response.data.login,
					name: response.data.name || null,
					email: response.data.email || null,
					avatar_url: response.data.avatar_url,
					html_url: response.data.html_url,
				};

				return {
					content: [{
						type: "text",
						text: `Authenticated as ${user.login}${user.name ? ` (${user.name})` : ""}`,
					}],
					details: { user, success: true },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return {
					content: [{ type: "text", text: `Error fetching authenticated user: ${message}` }],
					details: { user: null as unknown as { login: string }, success: false, error: message },
				};
			}
		},
	});

	// Tool 2: github_query_issues
	pi.registerTool({
		name: "github_query_issues",
		label: "GitHub Query Issues",
		description: "Search/query for GitHub issues with filters (owner, repo, state, labels, assignee, etc.)",
		parameters: Type.Object({
			owner: Type.String({ description: "GitHub repository owner (username or organization)" }),
			repo: Type.String({ description: "GitHub repository name" }),
			state: Type.Optional(Type.Union([
				Type.Literal("open"),
				Type.Literal("closed"),
				Type.Literal("all"),
			])),
			labels: Type.Optional(Type.Array(Type.String())),
			assignee: Type.Optional(Type.String()),
			creator: Type.Optional(Type.String()),
			mentioned: Type.Optional(Type.String()),
			since: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			try {
				validateOwnerRepo(params.owner, params.repo);
				const octokit = await getOctokit(ctx.cwd);

				const response = await octokit.issues.listForRepo({
					owner: params.owner,
					repo: params.repo,
					state: params.state || "open",
					labels: params.labels?.join(","),
					assignee: params.assignee,
					creator: params.creator,
					mentioned: params.mentioned,
					since: params.since,
					per_page: params.limit || 10,
				});

				const issues: GitHubIssue[] = response.data.map((issue) => ({
					number: issue.number,
					title: issue.title,
					body: issue.body || "",
					labels: issue.labels.map((label) => 
						typeof label === "string" ? { name: label } : { name: label.name || "" }
					),
					state: issue.state as "open" | "closed",
					created_at: issue.created_at,
					updated_at: issue.updated_at,
				}));

				return {
					content: [{
						type: "text",
						text: `Found ${issues.length} issue(s) in ${params.owner}/${params.repo}`,
					}],
					details: { issues },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return {
					content: [{ type: "text", text: `Error querying issues: ${message}` }],
					details: { issues: [] as GitHubIssue[], error: message },
				};
			}
		},
	});

	// Tool 3: github_fetch_issue
	pi.registerTool({
		name: "github_fetch_issue",
		label: "GitHub Fetch Issue",
		description: "Get full details of a single GitHub issue including comments",
		parameters: Type.Object({
			owner: Type.String({ description: "GitHub repository owner (username or organization)" }),
			repo: Type.String({ description: "GitHub repository name" }),
			issue_number: Type.Number({ description: "Issue number" }),
			include_comments: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			try {
				validateOwnerRepo(params.owner, params.repo);
				const octokit = await getOctokit(ctx.cwd);

				// Fetch issue details
				const issueResponse = await octokit.issues.get({
					owner: params.owner,
					repo: params.repo,
					issue_number: params.issue_number,
				});

				const issue: GitHubIssueFull = {
					number: issueResponse.data.number,
					title: issueResponse.data.title,
					body: issueResponse.data.body || "",
					labels: issueResponse.data.labels.map((label) =>
						typeof label === "string" ? { name: label } : { name: label.name || "" }
					),
					state: issueResponse.data.state as "open" | "closed",
					created_at: issueResponse.data.created_at,
					updated_at: issueResponse.data.updated_at,
					assignees: issueResponse.data.assignees?.map((a) => ({ login: a.login })),
					html_url: issueResponse.data.html_url,
				};

				// Fetch comments if requested
				if (params.include_comments !== false) {
					const commentsResponse = await octokit.issues.listComments({
						owner: params.owner,
						repo: params.repo,
						issue_number: params.issue_number,
						per_page: 100,
					});

					issue.comments = commentsResponse.data.map((comment) => ({
						id: comment.id,
						body: comment.body || "",
						user: { login: comment.user?.login || "unknown" },
						created_at: comment.created_at,
						updated_at: comment.updated_at,
						html_url: comment.html_url,
					}));
				}

				return {
					content: [{
						type: "text",
						text: `Fetched issue #${issue.number}: ${issue.title}`,
					}],
					details: { issue },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return {
					content: [{ type: "text", text: `Error fetching issue: ${message}` }],
					details: { issue: null as unknown as GitHubIssueFull, error: message },
				};
			}
		},
	});

	// Tool 4: github_set_comment
	pi.registerTool({
		name: "github_set_comment",
		label: "GitHub Set Comment",
		description: "Add a comment to a GitHub issue",
		parameters: Type.Object({
			owner: Type.String({ description: "GitHub repository owner (username or organization)" }),
			repo: Type.String({ description: "GitHub repository name" }),
			issue_number: Type.Number({ description: "Issue number" }),
			body: Type.String({ description: "Comment text (Markdown supported)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			try {
				validateOwnerRepo(params.owner, params.repo);
				const octokit = await getOctokit(ctx.cwd);

				const response = await octokit.issues.createComment({
					owner: params.owner,
					repo: params.repo,
					issue_number: params.issue_number,
					body: params.body,
				});

				return {
					content: [{
						type: "text",
						text: `Comment added to issue #${params.issue_number}`,
					}],
					details: {
						comment_url: response.data.html_url,
						comment_id: response.data.id,
						success: true,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return {
					content: [{ type: "text", text: `Error adding comment: ${message}` }],
					details: { comment_url: "", comment_id: 0, success: false, error: message },
				};
			}
		},
	});

	// Tool 5: github_set_status
	pi.registerTool({
		name: "github_set_status",
		label: "GitHub Set Status",
		description: "Update GitHub issue state (open/close) and/or assignee",
		parameters: Type.Object({
			owner: Type.String({ description: "GitHub repository owner (username or organization)" }),
			repo: Type.String({ description: "GitHub repository name" }),
			issue_number: Type.Number({ description: "Issue number" }),
			state: Type.Optional(Type.Union([
				Type.Literal("open"),
				Type.Literal("closed"),
			])),
			assignee: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			try {
				validateOwnerRepo(params.owner, params.repo);
				const octokit = await getOctokit(ctx.cwd);

				// Build update payload
				const updatePayload: Record<string, unknown> = {};
				if (params.state !== undefined) {
					updatePayload.state = params.state;
				}
				if (params.assignee !== undefined) {
					// GitHub API: empty array to unassign, array with usernames to assign
					updatePayload.assignees = params.assignee === null ? [] : [params.assignee];
				}

				const response = await octokit.issues.update({
					owner: params.owner,
					repo: params.repo,
					issue_number: params.issue_number,
					...updatePayload,
				});

				return {
					content: [{
						type: "text",
						text: `Issue #${params.issue_number} updated`,
					}],
					details: {
						state: response.data.state,
						assignees: response.data.assignees?.map((a) => a.login) || [],
						success: true,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return {
					content: [{ type: "text", text: `Error updating issue: ${message}` }],
					details: { state: "", assignees: [], success: false, error: message },
				};
			}
		},
	});

	// Tool 6: github_set_labels
	pi.registerTool({
		name: "github_set_labels",
		label: "GitHub Set Labels",
		description: "Add/remove labels on a GitHub issue",
		parameters: Type.Object({
			owner: Type.String({ description: "GitHub repository owner (username or organization)" }),
			repo: Type.String({ description: "GitHub repository name" }),
			issue_number: Type.Number({ description: "Issue number" }),
			labels: Type.Optional(Type.Array(Type.String())),
			addLabels: Type.Optional(Type.Array(Type.String())),
			removeLabels: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			try {
				validateOwnerRepo(params.owner, params.repo);
				const octokit = await getOctokit(ctx.cwd);

				let finalLabels: string[];

				if (params.labels !== undefined) {
					// Replace all labels
					finalLabels = params.labels;
				} else {
					// Get current labels first
					const issueResponse = await octokit.issues.get({
						owner: params.owner,
						repo: params.repo,
						issue_number: params.issue_number,
					});

					const currentLabels = issueResponse.data.labels.map((label) =>
						typeof label === "string" ? label : label.name || ""
					);

					finalLabels = [...currentLabels];

					// Add labels
					if (params.addLabels && params.addLabels.length > 0) {
						for (const label of params.addLabels) {
							if (!finalLabels.includes(label)) {
								finalLabels.push(label);
							}
						}
					}

					// Remove labels
					if (params.removeLabels && params.removeLabels.length > 0) {
						finalLabels = finalLabels.filter((label) => !params.removeLabels!.includes(label));
					}
				}

				// Update labels
				const response = await octokit.issues.setLabels({
					owner: params.owner,
					repo: params.repo,
					issue_number: params.issue_number,
					labels: finalLabels,
				});

				return {
					content: [{
						type: "text",
						text: `Labels updated on issue #${params.issue_number}`,
					}],
					details: {
						labels: response.data.map((label) => label.name),
						success: true,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return {
					content: [{ type: "text", text: `Error updating labels: ${message}` }],
					details: { labels: [], success: false, error: message },
				};
			}
		},
	});

	// Tool 7: github_assigned_open_issues
	pi.registerTool({
		name: "github_assigned_open_issues",
		label: "GitHub Assigned Open Issues",
		description: "Look up your GitHub username and query all open issues across all repositories that are assigned to you",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
			try {
				const octokit = await getOctokit(ctx.cwd);

				// Get authenticated user
				const userResponse = await octokit.users.getAuthenticated();
				const username = userResponse.data.login;

				// Search for all open issues assigned to the user across all repos
				// Using GitHub search API: is:issue is:open assignee:username
				const searchResponse = await octokit.search.issuesAndPullRequests({
					q: `is:issue is:open assignee:${username}`,
					sort: "updated",
					order: "desc",
					per_page: 100,
				});

				const issues: GitHubSearchIssue[] = searchResponse.data.items.map((issue) => ({
					url: issue.url,
					repository_url: issue.repository_url,
					html_url: issue.html_url,
					number: issue.number,
					title: issue.title,
					state: issue.state as "open" | "closed",
					labels: issue.labels.map((label) => ({ name: label.name || "" })),
					created_at: issue.created_at,
					updated_at: issue.updated_at,
					repository: { full_name: issue.repository_url.replace("https://api.github.com/repos/", "") },
					assignees: issue.assignees?.map((a) => ({ login: a.login })) || [],
				}));

				// Group by repository for better readability
				const byRepo = new Map<string, GitHubSearchIssue[]>();
				for (const issue of issues) {
					const repo = issue.repository.full_name;
					if (!byRepo.has(repo)) {
						byRepo.set(repo, []);
					}
					byRepo.get(repo)!.push(issue);
				}

				let summary = `Found ${issues.length} open issue(s) assigned to ${username}\n\n`;
				for (const [repo, repoIssues] of byRepo.entries()) {
					summary += `**${repo}** (${repoIssues.length} issues):\n`;
					for (const issue of repoIssues) {
						const labels = issue.labels.length > 0 ? ` [${issue.labels.map(l => l.name).join(", ")}]` : "";
						summary += `  - #${issue.number}: ${issue.title}${labels}\n    ${issue.html_url}\n`;
					}
					summary += "\n";
				}

				return {
					content: [{ type: "text", text: summary.trim() }],
					details: { username, issues, byRepository: Object.fromEntries(byRepo), success: true },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return {
					content: [{ type: "text", text: `Error fetching assigned issues: ${message}` }],
					details: { username: "", issues: [], byRepository: {}, success: false, error: message },
				};
			}
		},
	});
}
