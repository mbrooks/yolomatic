import { describe, expect, it, vi } from "vitest";

import { GatewayScopeError, WorkerGitHubGateway, type WorkerWorkspaceGateway } from "./github-gateway.js";
import type {
	GitHubGatewayService,
	GatewayIssueComment,
	GatewayIssueDetail,
	GatewayPullRequestDetail,
	GatewayPullRequestSummary,
} from "../ports/github-gateway-service.js";
import type { SessionState } from "../session/store.js";

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		issueNumber: 502,
		repo: "yeetomatic",
		owner: "mbrooks",
		title: "Expose GitHub management tool to workers",
		body: "Body",
		status: "working",
		sessionPath: "/tmp/session.jsonl",
		workspacePath: "/workspaces/mbrooks-yeetomatic/.worktrees/issue-502",
		lastActivity: new Date().toISOString(),
		seeded: false,
		...overrides,
	};
}

function makeFakeGateway(overrides: Partial<GitHubGatewayService> = {}): GitHubGatewayService {
	const base: GitHubGatewayService = {
		postComment: vi.fn(async () => 100),
		postPRComment: vi.fn(async () => 200),
		addLabels: vi.fn(async () => undefined),
		removeLabel: vi.fn(async () => undefined),
		getPullRequest: vi.fn(async () => null),
		updatePullRequestBranch: vi.fn(async () => undefined),
		createPullRequest: vi.fn(async () => null),
		listPullRequests: vi.fn(async () => []),
		getIssue: vi.fn(async () => null),
		createIssue: vi.fn(async () => ({ number: 1, html_url: "u" })),
		initializeEmptyRepo: vi.fn(async () => undefined),
		fileSelfReport: vi.fn(async () => "u"),
		listReviewComments: vi.fn(async () => []),
		listLabels: vi.fn(async () => []),
		getIssueTemplates: vi.fn(async () => []),
		listRecentCommits: vi.fn(async () => []),
		listRelatedIssues: vi.fn(async () => []),
		listOpenIssues: vi.fn(async () => []),
		listPendingInvitations: vi.fn(async () => []),
		acceptInvitation: vi.fn(async () => undefined),
		updateIssueAssignees: vi.fn(async () => undefined),
		closeIssue: vi.fn(async () => undefined),
		updateIssueBody: vi.fn(async () => undefined),
		updateIssueTitle: vi.fn(async () => undefined),
		getAuthenticatedUser: vi.fn(async () => ({ login: "yeetomatic-bot" })),
		listAccessibleRepositories: vi.fn(async () => []),
		getRepository: vi.fn(async () => null),
		getCollaboratorPermissionLevel: vi.fn(async () => null),
		isCollaborator: vi.fn(async () => false),
		getIssueDetail: vi.fn(async (owner, repo, issueNumber): Promise<GatewayIssueDetail | null> => {
			return {
				number: issueNumber,
				title: "Expose GitHub management tool to workers",
				body: "issue body",
				state: "open",
				labels: ["needs-clarification"],
				assignees: ["mbrooks"],
				html_url: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
				created_at: "2026-08-01T00:00:00Z",
				updated_at: "2026-08-01T00:00:00Z",
			};
		}),
		listIssueComments: vi.fn(async (owner, repo, issueNumber): Promise<GatewayIssueComment[]> => {
			return [
				{
					id: 1,
					body: "first comment",
					author: "mbrooks",
					created_at: "2026-08-01T00:00:00Z",
					updated_at: "2026-08-01T00:00:00Z",
					html_url: `https://github.com/${owner}/${repo}/issues/${issueNumber}#issuecomment-1`,
				},
			];
		}),
		updateIssue: vi.fn(async (owner, repo, issueNumber, fields) => {
		}),
		setLabels: vi.fn(async (owner, repo, issueNumber, labels) => {
		}),
		getPullRequestDetail: vi.fn(async (owner, repo, prNumber): Promise<GatewayPullRequestDetail | null> => {
			return {
				number: prNumber,
				title: "Yeetomatic: Expose GitHub management tool to workers",
				body: "pr body",
				state: "open",
				merged: false,
				head_ref: "yeetomatic/issue-502",
				base_ref: "main",
				html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
				created_at: "2026-08-01T00:00:00Z",
				updated_at: "2026-08-01T00:00:00Z",
			};
		}),
		listPullRequestComments: vi.fn(async (_owner, _repo, _prNumber) => []),
		listPullRequestReviewComments: vi.fn(async () => []),
		listPullRequestsForHead: vi.fn(async (owner, repo, head, _state): Promise<GatewayPullRequestSummary[]> => {
			return [];
		}),
		updatePullRequest: vi.fn(async (owner, repo, prNumber, fields) => {
		}),
		...overrides,
	};
	return base;
}

function makeFakeWorkspace(
	overrides: Partial<WorkerWorkspaceGateway> = {},
): WorkerWorkspaceGateway {
	return {
		updateDefaultBranchFromOrigin: vi.fn(async () => ({
			branch: "main",
			before: "old".repeat(10),
			after: "new".repeat(10),
			updated: true,
		})),
		...overrides,
	};
}

describe("WorkerGitHubGateway", () => {
	const state = makeState();

	it("returns the authenticated user", async () => {
		const fake = makeFakeGateway();
		const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
		const res = await gateway.handle(state, { tool: "get_authenticated_user", params: {} });
		expect(res).toEqual({ ok: true, data: { login: "yeetomatic-bot" } });
	});

	it("fetches the session issue with comments by default", async () => {
		const fake = makeFakeGateway();
		const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
		const res = await gateway.handle(state, { tool: "fetch_issue", params: {} });
		expect(res.ok).toBe(true);
		expect((res.data as { issue: { number: number } }).issue.number).toBe(502);
		expect((res.data as { comments: unknown[] }).comments).toHaveLength(1);
		expect(fake.getIssueDetail).toHaveBeenCalledWith("mbrooks", "yeetomatic", 502);
		expect(fake.listIssueComments).toHaveBeenCalledWith("mbrooks", "yeetomatic", 502);
	});

	it("skips issue comments when include_comments is false", async () => {
		const fake = makeFakeGateway();
		const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
		await gateway.handle(state, { tool: "fetch_issue", params: { include_comments: false } });
		expect(fake.listIssueComments).not.toHaveBeenCalled();
	});

	it("posts a comment to the session issue", async () => {
		const fake = makeFakeGateway();
		const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
		const res = await gateway.handle(state, { tool: "set_comment", params: { body: "hi" } });
		expect(res).toEqual({ ok: true, data: { comment_id: 100 } });
		expect(fake.postComment).toHaveBeenCalledWith("mbrooks", "yeetomatic", 502, "hi");
	});

	it("rejects a comment with no body without calling postComment", async () => {
		const fake = makeFakeGateway();
		const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
		const res = await gateway.handle(state, { tool: "set_comment", params: {} });
		expect(res.ok).toBe(false);
		expect(fake.postComment).not.toHaveBeenCalled();
	});

	it("updates issue state and assignee via set_status", async () => {
		const fake = makeFakeGateway();
		const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
		const res = await gateway.handle(state, {
			tool: "set_status",
			params: { state: "closed", assignee: "mbrooks" },
		});
		expect(res.ok).toBe(true);
		expect(fake.updateIssue).toHaveBeenCalledWith("mbrooks", "yeetomatic", 502, {
			state: "closed",
			assignees: ["mbrooks"],
		});
	});

	it("unassigns when assignee is null", async () => {
		const fake = makeFakeGateway();
		const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
		await gateway.handle(state, { tool: "set_status", params: { assignee: null } });
		expect(fake.updateIssue).toHaveBeenCalledWith("mbrooks", "yeetomatic", 502, { assignees: [] });
	});

	it("replaces all labels when labels is provided", async () => {
		const fake = makeFakeGateway();
		const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
		const res = await gateway.handle(state, { tool: "set_labels", params: { labels: ["a", "b"] } });
		expect(res.ok).toBe(true);
		expect(fake.setLabels).toHaveBeenCalledWith("mbrooks", "yeetomatic", 502, ["a", "b"]);
		expect((res.data as { labels: string[] }).labels).toEqual(["a", "b"]);
	});

	it("adds and removes labels relative to current labels", async () => {
		const fake = makeFakeGateway();
		const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
		const res = await gateway.handle(state, {
			tool: "set_labels",
			params: { addLabels: ["new"], removeLabels: ["needs-clarification"] },
		});
		expect(res.ok).toBe(true);
		expect(fake.setLabels).toHaveBeenCalledWith("mbrooks", "yeetomatic", 502, ["new"]);
	});

	it("rejects set_labels with no label arguments", async () => {
		const fake = makeFakeGateway();
		const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
		const res = await gateway.handle(state, { tool: "set_labels", params: {} });
		expect(res.ok).toBe(false);
		expect(fake.setLabels).not.toHaveBeenCalled();
	});

	it("updates issue title and body via update_issue", async () => {
		const fake = makeFakeGateway();
		const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
		const res = await gateway.handle(state, {
			tool: "update_issue",
			params: { title: "New title", body: "New body" },
		});
		expect(res.ok).toBe(true);
		expect(fake.updateIssue).toHaveBeenCalledWith("mbrooks", "yeetomatic", 502, {
			title: "New title",
			body: "New body",
		});
	});

	it("returns an error for an unknown tool", async () => {
		const gateway = new WorkerGitHubGateway(makeFakeGateway(), makeFakeWorkspace());
		const res = await gateway.handle(state, { tool: "nope", params: {} });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("Unknown gateway tool");
	});

	describe("PR scoping", () => {
		it("uses the session linked PR when pr_number is omitted", async () => {
			const linkedState = makeState({ prNumber: 77 });
			const fake = makeFakeGateway();
			const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
			const res = await gateway.handle(linkedState, { tool: "fetch_pr", params: {} });
			expect(res.ok).toBe(true);
			expect(fake.getPullRequestDetail).toHaveBeenCalledWith("mbrooks", "yeetomatic", 77);
			expect(fake.listPullRequestsForHead).not.toHaveBeenCalled();
		});

		it("accepts the linked pr_number explicitly without a branch-PR lookup", async () => {
			const linkedState = makeState({ prNumber: 77 });
			const fake = makeFakeGateway();
			const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
			const res = await gateway.handle(linkedState, { tool: "fetch_pr", params: { pr_number: 77 } });
			expect(res.ok).toBe(true);
			expect(fake.getPullRequestDetail).toHaveBeenCalledWith("mbrooks", "yeetomatic", 77);
			expect(fake.listPullRequestsForHead).not.toHaveBeenCalled();
		});

		it("accepts a branch PR not yet linked to the session", async () => {
			const fake = makeFakeGateway({
				listPullRequestsForHead: vi.fn(async () => [
					{
						number: 88,
						title: "Yeetomatic: ...",
						html_url: "https://github.com/mbrooks/yeetomatic/pull/88",
						head_ref: "yeetomatic/issue-502",
						base_ref: "main",
						state: "open",
						merged: false,
					},
				]),
			});
			const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
			const res = await gateway.handle(state, { tool: "set_pr_comment", params: { body: "x", pr_number: 88 } });
			expect(res.ok).toBe(true);
			expect(fake.postPRComment).toHaveBeenCalledWith("mbrooks", "yeetomatic", 88, "x");
			expect(fake.listPullRequestsForHead).toHaveBeenCalledWith("mbrooks", "yeetomatic", "yeetomatic/issue-502", "open");
		});

		it("rejects an out-of-scope pr_number as a scope error without the target op", async () => {
			const fake = makeFakeGateway();
			const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
			const res = await gateway.handle(state, { tool: "set_pr_comment", params: { body: "x", pr_number: 999 } });
			expect(res.ok).toBe(false);
			expect(res.scopeError).toBe(true);
			expect(res.error).toContain("pr_number 999");
			expect(fake.postPRComment).not.toHaveBeenCalled();
			expect(fake.getPullRequestDetail).not.toHaveBeenCalled();
		});

		it("falls back to the first branch PR when no PR is linked and pr_number omitted", async () => {
			const fake = makeFakeGateway({
				listPullRequestsForHead: vi.fn(async () => [
					{
						number: 42,
						title: "Yeetomatic: ...",
						html_url: "u",
						head_ref: "yeetomatic/issue-502",
						base_ref: "main",
						state: "open",
						merged: false,
					},
				]),
			});
			const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
			const res = await gateway.handle(state, { tool: "fetch_pr", params: {} });
			expect(res.ok).toBe(true);
			expect(fake.getPullRequestDetail).toHaveBeenCalledWith("mbrooks", "yeetomatic", 42);
		});

		it("errors when no associated PR exists and none is requested", async () => {
			const fake = makeFakeGateway();
			const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
			const res = await gateway.handle(state, { tool: "fetch_pr", params: {} });
			expect(res.ok).toBe(false);
			expect(res.error).toContain("No pull request is associated");
		});

		it("updates PR title/body/state/labels", async () => {
			const linkedState = makeState({ prNumber: 77 });
			const fake = makeFakeGateway();
			const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
			const res = await gateway.handle(linkedState, {
				tool: "update_pr",
				params: { title: "T", body: "B", state: "open", labels: ["x"] },
			});
			expect(res.ok).toBe(true);
			expect(fake.updatePullRequest).toHaveBeenCalledWith("mbrooks", "yeetomatic", 77, {
				title: "T",
				body: "B",
				state: "open",
				labels: ["x"],
			});
		});

		it("lists PR review comments for the linked PR", async () => {
			const linkedState = makeState({ prNumber: 77 });
			const fake = makeFakeGateway({
				listPullRequestReviewComments: vi.fn(async () => [
					{ id: 9, body: "nit", user: { login: "rev" }, path: "a.ts", line: 3 },
				]),
			});
			const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
			const res = await gateway.handle(linkedState, { tool: "list_pr_review_comments", params: {} });
			expect(res.ok).toBe(true);
			expect(fake.listPullRequestReviewComments).toHaveBeenCalledWith("mbrooks", "yeetomatic", 77);
		});
	});

	it("wraps gateway errors as failures and does not leak scope errors as generic errors", async () => {
		const fake = makeFakeGateway({
			postComment: vi.fn(async () => {
				throw new Error("rate limited");
			}),
		});
		const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
		const res = await gateway.handle(state, { tool: "set_comment", params: { body: "x" } });
		expect(res).toEqual({ ok: false, error: "rate limited" });
		expect(res.scopeError).toBeUndefined();
	});

	it("GatewayScopeError is throwable and named", () => {
		const err = new GatewayScopeError("nope");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("GatewayScopeError");
	});

	it("records calls so tests can assert ordering", async () => {
		const fake = makeFakeGateway();
const gateway = new WorkerGitHubGateway(fake, makeFakeWorkspace());
		await gateway.handle(state, { tool: "fetch_issue", params: {} });
		expect(fake.getIssueDetail).toHaveBeenCalledWith("mbrooks", "yeetomatic", 502);
	});

	describe("update_main_from_origin", () => {
		it("delegates to the workspace port scoped to the session repo and returns its result", async () => {
			const workspace = makeFakeWorkspace({
				updateDefaultBranchFromOrigin: vi.fn(async (owner, repo) => ({
					branch: "main",
					before: "a".repeat(40),
					after: "b".repeat(40),
					updated: true,
				})),
			});
			const gateway = new WorkerGitHubGateway(makeFakeGateway(), workspace);
			const res = await gateway.handle(state, { tool: "update_main_from_origin", params: {} });
			expect(res).toEqual({
				ok: true,
				data: { branch: "main", before: "a".repeat(40), after: "b".repeat(40), updated: true },
			});
			expect(workspace.updateDefaultBranchFromOrigin).toHaveBeenCalledWith("mbrooks", "yeetomatic");
		});

		it("reports an already-up-to-date ref as updated=false", async () => {
			const sha = "c".repeat(40);
			const workspace = makeFakeWorkspace({
				updateDefaultBranchFromOrigin: vi.fn(async () => ({
					branch: "main",
					before: sha,
					after: sha,
					updated: false,
				})),
			});
			const gateway = new WorkerGitHubGateway(makeFakeGateway(), workspace);
			const res = await gateway.handle(state, { tool: "update_main_from_origin", params: {} });
			expect(res.ok).toBe(true);
			expect((res.data as { updated: boolean }).updated).toBe(false);
		});

		it("returns ok:false with a descriptive error and no scopeError when the remote branch is missing", async () => {
			const workspace = makeFakeWorkspace({
				updateDefaultBranchFromOrigin: vi.fn(async () => {
					throw new Error("origin/main does not exist in /tmp/bare; cannot update local main ref");
				}),
			});
			const gateway = new WorkerGitHubGateway(makeFakeGateway(), workspace);
			const res = await gateway.handle(state, { tool: "update_main_from_origin", params: {} });
			expect(res).toEqual({
				ok: false,
				error: "origin/main does not exist in /tmp/bare; cannot update local main ref",
			});
			expect(res.scopeError).toBeUndefined();
		});

		it("ignores any params (no accepted parameters)", async () => {
			const workspace = makeFakeWorkspace();
			const gateway = new WorkerGitHubGateway(makeFakeGateway(), workspace);
			await gateway.handle(state, {
				tool: "update_main_from_origin",
				params: { owner: "other", repo: "other-repo", branch: "develop" },
			});
			expect(workspace.updateDefaultBranchFromOrigin).toHaveBeenCalledWith("mbrooks", "yeetomatic");
		});
	});
});