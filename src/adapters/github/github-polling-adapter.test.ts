import { describe, expect, it, vi } from "vitest";
import { GitHubPollingAdapter } from "./github-polling-adapter.js";

function createMockOctokit(overrides?: Partial<{
	issues: Record<string, ReturnType<typeof vi.fn>>;
	pulls: Record<string, ReturnType<typeof vi.fn>>;
	repos: Record<string, ReturnType<typeof vi.fn>>;
}>) {
	return {
		issues: {
			get: vi.fn(async () => ({ data: { state: "open" } })),
			listForRepo: vi.fn(async () => ({ data: [] })),
			listCommentsForRepo: vi.fn(async () => ({ data: [] })),
			listEventsForTimeline: vi.fn(async () => ({ data: [] })),
			...(overrides?.issues ?? {}),
		},
		pulls: {
			get: vi.fn(async () => ({ data: { head: { ref: "main" }, state: "open", merged: false } })),
			list: vi.fn(async () => ({ data: [] })),
			listReviews: vi.fn(async () => ({ data: [] })),
			listReviewCommentsForRepo: vi.fn(async () => ({ data: [] })),
			...(overrides?.pulls ?? {}),
		},
		repos: {
			listForAuthenticatedUser: vi.fn(async () => ({ data: [] })),
			...(overrides?.repos ?? {}),
		},
	} as any;
}

describe("GitHubPollingAdapter", () => {
	it("lists issues updated since", async () => {
		const octokit = createMockOctokit({
			issues: {
				listForRepo: vi.fn(async () => ({
					data: [{
						number: 1,
						title: "Issue",
						body: "Body",
						state: "open",
						created_at: "2026-06-01T00:00:00Z",
						updated_at: "2026-06-01T00:01:00Z",
						labels: [{ name: "tars" }],
						assignee: { login: "tars-bot" },
						assignees: [{ login: "tars-bot" }],
						user: { login: "human" },
					}],
				})),
			},
		});
		const adapter = new GitHubPollingAdapter({ githubToken: "token", octokit: octokit as never });
		const result = await adapter.listIssuesUpdatedSince("mbrooks", "tars", "2026-06-01T00:00:00Z");
		expect(result[0]).toEqual(expect.objectContaining({
			number: 1,
			labels: [{ name: "tars" }],
			assignees: [{ login: "tars-bot" }],
		}));
	});

	it("filters out closed issues when listing issues updated since", async () => {
		const issues = [
			{
				number: 1,
				title: "Open issue",
				body: "Body",
				state: "open",
				created_at: "2026-06-01T00:00:00Z",
				updated_at: "2026-06-01T00:01:00Z",
				labels: [],
				assignee: { login: "tars-bot" },
				assignees: [{ login: "tars-bot" }],
				user: { login: "human" },
			},
			{
				number: 2,
				title: "Closed issue",
				body: "Body",
				state: "closed",
				created_at: "2026-06-01T00:00:00Z",
				updated_at: "2026-06-01T00:02:00Z",
				labels: [],
				assignee: { login: "tars-bot" },
				assignees: [{ login: "tars-bot" }],
				user: { login: "human" },
			},
		];
		const octokit = createMockOctokit({
			issues: {
				listForRepo: vi.fn(async ({ state }: { state?: string }) => ({
					data: state === "open" ? issues.filter((issue) => issue.state === "open") : issues,
				})),
			},
		});
		const adapter = new GitHubPollingAdapter({ githubToken: "token", octokit: octokit as never });
		const result = await adapter.listIssuesUpdatedSince("mbrooks", "tars", "2026-06-01T00:00:00Z");
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual(expect.objectContaining({ number: 1, state: "open" }));
		expect(octokit.issues.listForRepo).toHaveBeenCalledWith(
			expect.objectContaining({ owner: "mbrooks", repo: "tars", state: "open" }),
		);
	});

	it("lists issue comments with issue context", async () => {
		const octokit = createMockOctokit({
			issues: {
				listCommentsForRepo: vi.fn(async () => ({
					data: [{
						id: 10,
						body: "Comment",
						created_at: "2026-06-01T00:00:00Z",
						updated_at: "2026-06-01T00:00:00Z",
						issue_url: "https://api.github.com/repos/mbrooks/tars/issues/1",
						user: { login: "human", type: "User" },
					}],
				})),
				get: vi.fn(async () => ({
					data: {
						number: 1,
						title: "Issue",
						body: "Body",
						state: "open",
						created_at: "2026-06-01T00:00:00Z",
						updated_at: "2026-06-01T00:00:00Z",
						labels: [],
						assignees: [],
						user: { login: "human" },
					},
				})),
			},
		});
		const adapter = new GitHubPollingAdapter({ githubToken: "token", octokit: octokit as never });
		const result = await adapter.listIssueCommentsSince("mbrooks", "tars", "2026-06-01T00:00:00Z");
		expect(result[0]).toEqual(expect.objectContaining({
			id: 10,
			issue: expect.objectContaining({ number: 1 }),
		}));
	});

	it("lists pull requests and review comments updated since", async () => {
		const octokit = createMockOctokit({
			pulls: {
				list: vi.fn(async () => ({
					data: [{
						number: 2,
						title: "PR",
						body: "Body",
						state: "open",
						merged: false,
						created_at: "2026-06-01T00:00:00Z",
						updated_at: "2026-06-01T00:05:00Z",
						head: { ref: "tars/issue-1" },
						user: { login: "human" },
					}],
				})),
				get: vi.fn(async () => ({
					data: {
						number: 2,
						title: "PR",
						body: "Body",
						state: "open",
						merged: false,
						created_at: "2026-06-01T00:00:00Z",
						updated_at: "2026-06-01T00:05:00Z",
						head: { ref: "tars/issue-1" },
						user: { login: "human" },
					},
				})),
				listReviewCommentsForRepo: vi.fn(async () => ({
					data: [{
						id: 20,
						body: "Fix this",
						created_at: "2026-06-01T00:05:00Z",
						updated_at: "2026-06-01T00:05:00Z",
						pull_request_url: "https://api.github.com/repos/mbrooks/tars/pulls/2",
						user: { login: "reviewer" },
						path: "src/a.ts",
						line: 4,
					}],
				})),
			},
		});
		const adapter = new GitHubPollingAdapter({ githubToken: "token", octokit: octokit as never });
		await expect(adapter.listPullRequestsUpdatedSince("mbrooks", "tars", "2026-06-01T00:01:00Z")).resolves.toHaveLength(1);
		const comments = await adapter.listPRReviewCommentsSince("mbrooks", "tars", "2026-06-01T00:01:00Z");
		expect(comments[0]).toEqual(expect.objectContaining({
			id: 20,
			pull_request: expect.objectContaining({ number: 2 }),
		}));
	});

	it("lists assignment timeline events and PR reviews", async () => {
		const octokit = createMockOctokit({
			issues: {
				listForRepo: vi.fn(async () => ({
					data: [{
						number: 1,
						title: "Issue",
						body: null,
						state: "open",
						created_at: "2026-06-01T00:00:00Z",
						updated_at: "2026-06-01T00:01:00Z",
						labels: [],
						assignee: null,
						assignees: [],
						user: { login: "human" },
					}],
				})),
				listEventsForTimeline: vi.fn(async () => ({
					data: [
						{ id: 1, event: "assigned", created_at: "2026-06-01T00:02:00Z", actor: { login: "human" }, assignee: { login: "tars-bot" } },
						{ id: 2, event: "labeled", created_at: "2026-06-01T00:02:00Z", actor: { login: "human" } },
						{ id: 3, event: "unassigned", created_at: "2026-05-31T00:02:00Z", actor: { login: "human" } },
					],
				})),
			},
			pulls: {
				list: vi.fn(async () => ({
					data: [{
						number: 2,
						title: "PR",
						body: null,
						state: "open",
						merged: false,
						created_at: "2026-06-01T00:00:00Z",
						updated_at: "2026-06-01T00:02:00Z",
						head: { ref: "tars/issue-1" },
						user: { login: "human" },
					}],
				})),
				listReviews: vi.fn(async () => ({
					data: [
						{ id: 30, body: "Review", state: "COMMENTED", submitted_at: "2026-06-01T00:03:00Z", user: { login: "reviewer" } },
						{ id: 31, body: "Old", state: "COMMENTED", submitted_at: "2026-05-31T00:03:00Z", user: { login: "reviewer" } },
					],
				})),
			},
		});
		const adapter = new GitHubPollingAdapter({ githubToken: "token", octokit: octokit as never });
		await expect(adapter.listIssueEventsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).resolves.toHaveLength(1);
		await expect(adapter.listPRReviewsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).resolves.toHaveLength(1);
	});

	it("returns empty arrays when polling reads fail", async () => {
		const octokit = createMockOctokit({
			issues: {
				listForRepo: vi.fn(async () => { throw new Error("issues failed"); }),
				listCommentsForRepo: vi.fn(async () => { throw new Error("comments failed"); }),
			},
			pulls: {
				list: vi.fn(async () => { throw new Error("prs failed"); }),
				listReviewCommentsForRepo: vi.fn(async () => { throw new Error("review comments failed"); }),
			},
		});
		const adapter = new GitHubPollingAdapter({ githubToken: "token", octokit: octokit as never });
		await expect(adapter.listIssuesUpdatedSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).resolves.toEqual([]);
		await expect(adapter.listIssueEventsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).resolves.toEqual([]);
		await expect(adapter.listIssueCommentsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).resolves.toEqual([]);
		await expect(adapter.listPullRequestsUpdatedSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).resolves.toEqual([]);
		await expect(adapter.listPRReviewsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).resolves.toEqual([]);
		await expect(adapter.listPRReviewCommentsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).resolves.toEqual([]);
	});

	it("skips comments when related issue or PR context cannot be loaded", async () => {
		const octokit = createMockOctokit({
			issues: {
				listCommentsForRepo: vi.fn(async () => ({
					data: [
						{ id: 1, issue_url: "", body: "no issue", created_at: "2026-06-01T00:00:00Z", user: { login: "human" } },
						{ id: 2, issue_url: "https://api.github.com/repos/mbrooks/tars/issues/2", body: "missing issue", created_at: "2026-06-01T00:00:00Z", user: { login: "human" } },
					],
				})),
				get: vi.fn(async () => { throw new Error("missing"); }),
			},
			pulls: {
				listReviewCommentsForRepo: vi.fn(async () => ({
					data: [
						{ id: 3, pull_request_url: "", body: "no pr", created_at: "2026-06-01T00:00:00Z", user: { login: "human" } },
						{ id: 4, pull_request_url: "https://api.github.com/repos/mbrooks/tars/pulls/4", body: "missing pr", created_at: "2026-06-01T00:00:00Z", user: { login: "human" } },
					],
				})),
				get: vi.fn(async () => { throw new Error("missing"); }),
			},
		});
		const adapter = new GitHubPollingAdapter({ githubToken: "token", octokit: octokit as never });
		await expect(adapter.listIssueCommentsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).resolves.toEqual([]);
		await expect(adapter.listPRReviewCommentsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).resolves.toEqual([]);
	});

	it("maps sparse polling API responses through fallback fields", async () => {
		const octokit = createMockOctokit({
			issues: {
				listForRepo: vi.fn(async () => ({
					data: [{
						number: 1,
						labels: ["tars", {}],
						assignees: [{ login: "" }, { login: "tars-bot" }],
					}],
				})),
				listCommentsForRepo: vi.fn(async () => ({
					data: [{
						id: 11,
						issue_url: "https://api.github.com/repos/mbrooks/tars/issues/1",
						created_at: "2026-06-01T00:00:00Z",
					}],
				})),
				get: vi.fn(async () => ({ data: { number: 1 } })),
				listEventsForTimeline: vi.fn(async () => ({
					data: [{ event: "assigned", created_at: "2026-06-01T00:00:00Z" }],
				})),
			},
			pulls: {
				list: vi.fn(async () => ({
					data: [{ number: 2, updated_at: "2026-06-01T00:00:00Z" }],
				})),
				get: vi.fn(async () => ({ data: { number: 2 } })),
				listReviews: vi.fn(async () => ({
					data: [
						{ id: 31, state: "COMMENTED", submitted_at: "" },
						{ id: 32, state: "COMMENTED", submitted_at: "2026-06-01T00:00:00Z" },
					],
				})),
				listReviewCommentsForRepo: vi.fn(async () => ({
					data: [{
						id: 21,
						pull_request_url: "https://api.github.com/repos/mbrooks/tars/pulls/2",
						created_at: "2026-06-01T00:00:00Z",
					}],
				})),
			},
			repos: {
				listForAuthenticatedUser: vi.fn(async () => ({ data: [{}] })),
			},
		});
		const adapter = new GitHubPollingAdapter({ githubToken: "token", octokit: octokit as never });

		expect(await adapter.listAccessibleRepositories()).toEqual([{ owner: "", repo: "", fullName: "", visibility: "public" }]);
		expect(await adapter.listIssuesUpdatedSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).toEqual([
			expect.objectContaining({
				title: "",
				body: null,
				state: "",
				labels: [{ name: "tars" }, { name: undefined }],
				assignee: null,
				assignees: [{ login: "tars-bot" }],
				user: undefined,
				pull_request: undefined,
			}),
		]);
		expect(await adapter.listIssueEventsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).toEqual([
			expect.objectContaining({ id: 0, actor: undefined, assignee: undefined }),
		]);
		expect(await adapter.listIssueCommentsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).toEqual([
			expect.objectContaining({ body: "", user: { login: "", type: undefined } }),
		]);
		expect(await adapter.listPullRequestsUpdatedSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).toEqual([
			expect.objectContaining({ title: "", body: null, state: "", merged: false, head: { ref: "" }, user: undefined }),
		]);
		expect(await adapter.listPRReviewsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).toEqual([
			expect.objectContaining({ body: null, user: { login: "" } }),
		]);
		expect(await adapter.listPRReviewCommentsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).toEqual([
			expect.objectContaining({ body: "", updated_at: "2026-06-01T00:00:00Z", user: { login: "" } }),
		]);
	});

	it("continues when per-issue or per-PR polling sub-requests fail", async () => {
		const octokit = createMockOctokit({
			issues: {
				listForRepo: vi.fn(async () => ({ data: [{ number: 1, updated_at: "2026-06-01T00:00:00Z" }] })),
				listEventsForTimeline: vi.fn(async () => { throw new Error("timeline failed"); }),
			},
			pulls: {
				list: vi.fn(async () => ({ data: [{ number: 2, updated_at: "2026-06-01T00:00:00Z" }] })),
				listReviews: vi.fn(async () => { throw new Error("reviews failed"); }),
			},
		});
		const adapter = new GitHubPollingAdapter({ githubToken: "token", octokit: octokit as never });
		await expect(adapter.listIssueEventsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).resolves.toEqual([]);
		await expect(adapter.listPRReviewsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).resolves.toEqual([]);
	});
});
