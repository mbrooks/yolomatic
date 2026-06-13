import { describe, expect, it, vi } from "vitest";
import { GitHubServiceAdapter } from "./github-service-adapter.js";

function createMockOctokit(overrides?: Partial<{
	issues: Record<string, ReturnType<typeof vi.fn>>;
	pulls: Record<string, ReturnType<typeof vi.fn>>;
	repos: Record<string, ReturnType<typeof vi.fn>>;
	request: ReturnType<typeof vi.fn>;
	search: Record<string, ReturnType<typeof vi.fn>>;
	users: Record<string, ReturnType<typeof vi.fn>>;
}>) {
	return {
		request: overrides?.request ?? vi.fn(async () => ({ data: { items: [] } })),
		issues: {
			createComment: vi.fn(async () => ({ data: {} })),
			addLabels: vi.fn(async () => ({ data: {} })),
			removeLabel: vi.fn(async () => ({ data: {} })),
			get: vi.fn(async () => ({ data: { state: "open" } })),
			create: vi.fn(async () => ({ data: { number: 1, html_url: "https://github.com/mbrooks/tars/issues/1" } })),
			listLabelsForRepo: vi.fn(async () => ({ data: [] })),
			listForRepo: vi.fn(async () => ({ data: [] })),
			update: vi.fn(async () => ({ data: {} })),
			...(overrides?.issues ?? {}),
		},
		pulls: {
			get: vi.fn(async () => ({ data: { head: { ref: "main" }, state: "open", merged: false } })),
			create: vi.fn(async () => ({ data: { number: 1, html_url: "https://github.com/mbrooks/tars/pulls/1" } })),
			list: vi.fn(async () => ({ data: [] })),
			listReviewComments: vi.fn(async () => ({ data: [] })),
			...(overrides?.pulls ?? {}),
		},
		repos: {
			getContent: vi.fn(async () => ({ data: [] })),
			listCommits: vi.fn(async () => ({ data: [] })),
			listInvitationsForAuthenticatedUser: vi.fn(async () => ({ data: [] })),
			acceptInvitationForAuthenticatedUser: vi.fn(async () => ({ data: {} })),
			get: vi.fn(async () => ({ data: { default_branch: "main" } })),
			createOrUpdateFileContents: vi.fn(async () => ({ data: {} })),
			listForAuthenticatedUser: vi.fn(async () => ({ data: [] })),
			...(overrides?.repos ?? {}),
		},
		search: {
			issuesAndPullRequests: vi.fn(async () => ({ data: { items: [] } })),
			...(overrides?.search ?? {}),
		},
		users: {
			getAuthenticated: vi.fn(async () => ({ data: { login: "testuser" } })),
			...(overrides?.users ?? {}),
		},
	} as any;
}

describe("GitHubServiceAdapter", () => {
	it("creates octokit when not provided", () => {
		// createOctokit will fail without valid token, but constructor should not throw immediately
		expect(() => new GitHubServiceAdapter({ githubToken: "ghp_test" })).not.toThrow();
	});

	describe("postComment", () => {
		it("calls issues.createComment", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.postComment("mbrooks", "tars", 1, "hello");
			expect(octokit.issues.createComment).toHaveBeenCalledWith({ owner: "mbrooks", repo: "tars", issue_number: 1, body: "hello" });
		});
	});

	describe("postPRComment", () => {
		it("calls issues.createComment with prNumber", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.postPRComment("mbrooks", "tars", 2, "review");
			expect(octokit.issues.createComment).toHaveBeenCalledWith({ owner: "mbrooks", repo: "tars", issue_number: 2, body: "review" });
		});
	});

	describe("addLabels", () => {
		it("calls issues.addLabels", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.addLabels("mbrooks", "tars", 1, ["bug", "ui"]);
			expect(octokit.issues.addLabels).toHaveBeenCalledWith({ owner: "mbrooks", repo: "tars", issue_number: 1, labels: ["bug", "ui"] });
		});
	});

	describe("removeLabel", () => {
		it("calls issues.removeLabel", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.removeLabel("mbrooks", "tars", 1, "bug");
			expect(octokit.issues.removeLabel).toHaveBeenCalledWith({ owner: "mbrooks", repo: "tars", issue_number: 1, name: "bug" });
		});

		it("silently swallows 404 errors", async () => {
			const octokit = createMockOctokit({
				issues: {
					removeLabel: vi.fn(async () => {
						throw Object.assign(new Error("Not Found"), { status: 404 });
					}),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await expect(adapter.removeLabel("mbrooks", "tars", 1, "bug")).resolves.toBeUndefined();
		});

		it("rethrows non-404 errors", async () => {
			const octokit = createMockOctokit({
				issues: {
					removeLabel: vi.fn(async () => {
						throw Object.assign(new Error("Server Error"), { status: 500 });
					}),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await expect(adapter.removeLabel("mbrooks", "tars", 1, "bug")).rejects.toThrow("Server Error");
		});
	});

	describe("getPullRequest", () => {
		it("returns mapped PR info", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getPullRequest("mbrooks", "tars", 1);
			expect(result).toEqual({ head: { ref: "main" }, state: "open", merged: false });
		});

		it("returns null on error", async () => {
			const octokit = createMockOctokit({
				pulls: {
					get: vi.fn(async () => { throw new Error("Not found"); }),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getPullRequest("mbrooks", "tars", 99);
			expect(result).toBeNull();
		});
	});

	describe("createPullRequest", () => {
		it("returns created PR", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.createPullRequest("mbrooks", "tars", "Title", "Body", "feature", "main");
			expect(result).toEqual({ number: 1, html_url: "https://github.com/mbrooks/tars/pulls/1" });
		});

		it("returns null when no commits between branches", async () => {
			const octokit = createMockOctokit({
				pulls: {
					create: vi.fn(async () => { throw new Error("No commits between main and feature"); }),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.createPullRequest("mbrooks", "tars", "Title", "Body", "feature", "main");
			expect(result).toBeNull();
		});

		it("rethrows other errors", async () => {
			const octokit = createMockOctokit({
				pulls: {
					create: vi.fn(async () => { throw new Error("Auth failed"); }),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await expect(adapter.createPullRequest("mbrooks", "tars", "Title", "Body", "feature", "main")).rejects.toThrow("Auth failed");
		});
	});

	describe("listPullRequests", () => {
		it("returns mapped PRs", async () => {
			const octokit = createMockOctokit({
				pulls: {
					list: vi.fn(async () => ({
						data: [
							{ number: 1, html_url: "https://github.com/mbrooks/tars/pulls/1" },
							{ number: 2, html_url: "https://github.com/mbrooks/tars/pulls/2" },
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listPullRequests("mbrooks", "tars", { head: "feature", base: "main", state: "open" });
			expect(result).toHaveLength(2);
			expect(result[0].number).toBe(1);
		});
	});

	describe("getIssue", () => {
		it("returns issue state", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getIssue("mbrooks", "tars", 1);
			expect(result).toEqual({ state: "open" });
		});

		it("returns null on error", async () => {
			const octokit = createMockOctokit({
				issues: {
					get: vi.fn(async () => { throw new Error("Not found"); }),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getIssue("mbrooks", "tars", 99);
			expect(result).toBeNull();
		});
	});

	describe("createIssue", () => {
		it("returns created issue", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.createIssue("mbrooks", "tars", "Title", "Body", ["bug"], ["mbrooks"]);
			expect(result).toEqual({ number: 1, html_url: "https://github.com/mbrooks/tars/issues/1" });
		});
	});

	describe("initializeEmptyRepo", () => {
		it("fetches repo default branch and creates README via contents API", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.initializeEmptyRepo("mbrooks", "tars", "main");
			expect(octokit.repos.get).toHaveBeenCalledWith({ owner: "mbrooks", repo: "tars" });
			expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith({
				owner: "mbrooks",
				repo: "tars",
				path: "README.md",
				message: "Initial commit",
				content: Buffer.from("# tars\n\nAuto-initialized by TARS.\n").toString("base64"),
				branch: "main",
			});
		});

		it("falls back to provided default branch when repo has no default_branch", async () => {
			const octokit = createMockOctokit({
				repos: {
					get: vi.fn(async () => ({ data: { default_branch: undefined } })),
					createOrUpdateFileContents: vi.fn(async () => ({ data: {} })),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.initializeEmptyRepo("mbrooks", "tars", "master");
			expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
				expect.objectContaining({ branch: "master" }),
			);
		});
	});

	describe("listReviewComments", () => {
		it("returns mapped comments", async () => {
			const octokit = createMockOctokit({
				pulls: {
					listReviewComments: vi.fn(async () => ({
						data: [
							{ id: 1, body: "nice", user: { login: "a" }, path: "f.ts", line: 5 },
							{ id: 2, body: null, user: null, path: undefined, line: null },
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listReviewComments("mbrooks", "tars", 1, 10);
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({ id: 1, body: "nice", user: { login: "a" }, path: "f.ts", line: 5 });
			expect(result[1]).toEqual({ id: 2, body: "", user: undefined, path: undefined, line: null });
		});

		it("returns empty array on error", async () => {
			const octokit = createMockOctokit({
				pulls: {
					listReviewComments: vi.fn(async () => { throw new Error("fail"); }),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listReviewComments("mbrooks", "tars", 1, 10);
			expect(result).toEqual([]);
		});
	});

	describe("listLabels", () => {
		it("returns label names", async () => {
			const octokit = createMockOctokit({
				issues: {
					listLabelsForRepo: vi.fn(async () => ({
						data: [{ name: "bug" }, { name: "feature" }],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listLabels("mbrooks", "tars");
			expect(result).toEqual(["bug", "feature"]);
		});

		it("returns empty array on error", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listLabels("mbrooks", "tars");
			expect(result).toEqual([]);
		});
	});

	describe("getIssueTemplates", () => {
		it("returns templates from directory", async () => {
			const octokit = createMockOctokit({
				repos: {
					getContent: vi.fn(async ({ path }: { path: string }) => {
						if (path === ".github/ISSUE_TEMPLATE") {
							return {
								data: [
									{ type: "file", name: "bug.md", path: ".github/ISSUE_TEMPLATE/bug.md" },
									{ type: "dir", name: "other", path: ".github/ISSUE_TEMPLATE/other" },
								],
							};
						}
						return {
							data: { content: Buffer.from("Template body").toString("base64") },
						};
					}),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getIssueTemplates("mbrooks", "tars");
			expect(result).toEqual([{ name: "bug", body: "Template body" }]);
		});

		it("returns empty array when data is not array", async () => {
			const octokit = createMockOctokit({
				repos: {
					getContent: vi.fn(async () => ({ data: {} })),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getIssueTemplates("mbrooks", "tars");
			expect(result).toEqual([]);
		});

		it("returns empty array on error", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getIssueTemplates("mbrooks", "tars");
			expect(result).toEqual([]);
		});
	});

	describe("listRecentCommits", () => {
		it("returns formatted commits", async () => {
			const octokit = createMockOctokit({
				repos: {
					listCommits: vi.fn(async () => ({
						data: [
							{ sha: "abc1234567890", commit: { message: "first commit" } },
							{ sha: "def1234567890", commit: { message: "second commit\nwith body" } },
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listRecentCommits("mbrooks", "tars", 5);
			expect(result).toEqual(["abc1234: first commit", "def1234: second commit"]);
		});

		it("returns empty array on error", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listRecentCommits("mbrooks", "tars");
			expect(result).toEqual([]);
		});
	});

	describe("listRelatedIssues", () => {
		it("returns mapped search results", async () => {
			const request = vi.fn(async () => ({
				data: {
					items: [
						{ number: 1, title: "Bug", state: "open" },
					],
				},
			}));
			const octokit = createMockOctokit({
				request,
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listRelatedIssues("mbrooks", "tars", "bug", 5);
			expect(result).toEqual([{ number: 1, title: "Bug", state: "open" }]);
			expect(request).toHaveBeenCalledWith("GET /search/issues", {
				q: "repo:mbrooks/tars is:issue bug in:title",
				per_page: 5,
			});
			expect(octokit.search.issuesAndPullRequests).not.toHaveBeenCalled();
		});

		it("returns empty array on error", async () => {
			const octokit = createMockOctokit({
				request: vi.fn(async () => {
					throw new Error("Search failed");
				}),
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listRelatedIssues("mbrooks", "tars", "bug");
			expect(result).toEqual([]);
		});
	});

	describe("listOpenIssues", () => {
		it("returns open issues mapped from octokit response", async () => {
			const octokit = createMockOctokit({
				issues: {
					listForRepo: vi.fn(async () => ({
						data: [
							{
								number: 1,
								title: "Bug report",
								body: "Something is broken",
								state: "open",
								labels: [{ name: "bug" }],
								assignees: [{ login: "mbrooks" }],
								html_url: "https://github.com/mbrooks/tars/issues/1",
							},
							{
								number: 2,
								title: "Feature request",
								body: null,
								state: "open",
								labels: [],
								assignees: [],
								html_url: "https://github.com/mbrooks/tars/issues/2",
							},
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listOpenIssues("mbrooks", "tars");
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({
				number: 1,
				title: "Bug report",
				body: "Something is broken",
				state: "open",
				labels: ["bug"],
				assignees: ["mbrooks"],
				html_url: "https://github.com/mbrooks/tars/issues/1",
			});
			expect(result[1]).toEqual({
				number: 2,
				title: "Feature request",
				body: "",
				state: "open",
				labels: [],
				assignees: [],
				html_url: "https://github.com/mbrooks/tars/issues/2",
			});
		});

		it("filters out empty label names", async () => {
			const octokit = createMockOctokit({
				issues: {
					listForRepo: vi.fn(async () => ({
						data: [
							{
								number: 1,
								title: "Bug",
								body: "",
								state: "open",
								labels: [{ name: "" }, { name: "bug" }],
								assignees: [{ login: "" }, { login: "user" }],
								html_url: "https://github.com/mbrooks/tars/issues/1",
							},
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listOpenIssues("mbrooks", "tars");
			expect(result[0].labels).toEqual(["bug"]);
			expect(result[0].assignees).toEqual(["user"]);
		});

		it("handles string labels", async () => {
			const octokit = createMockOctokit({
				issues: {
					listForRepo: vi.fn(async () => ({
						data: [
							{
								number: 1,
								title: "Bug",
								body: "",
								state: "open",
								labels: ["bug", "ui"],
								assignees: [],
								html_url: "https://github.com/mbrooks/tars/issues/1",
							},
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listOpenIssues("mbrooks", "tars");
			expect(result[0].labels).toEqual(["bug", "ui"]);
		});

		it("returns empty array on error", async () => {
			const octokit = createMockOctokit({
				issues: {
					listForRepo: vi.fn(async () => {
						throw new Error("Network error");
					}),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listOpenIssues("mbrooks", "tars");
			expect(result).toEqual([]);
		});
	});

	describe("listPendingInvitations", () => {
		it("returns mapped invitations", async () => {
			const octokit = createMockOctokit({
				repos: {
					listInvitationsForAuthenticatedUser: vi.fn(async () => ({
						data: [
							{
								id: 1,
								repository: { full_name: "octocat/Hello-World", name: "Hello-World", owner: { login: "octocat" } },
								inviter: { login: "octocat" },
								permissions: "write",
								created_at: "2024-01-01T00:00:00Z",
								html_url: "https://github.com/octocat/Hello-World/invitations",
							},
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listPendingInvitations();
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({
				id: 1,
				repository: { full_name: "octocat/Hello-World", name: "Hello-World", owner: { login: "octocat" } },
				inviter: { login: "octocat" },
				permissions: "write",
				created_at: "2024-01-01T00:00:00Z",
				html_url: "https://github.com/octocat/Hello-World/invitations",
			});
		});

		it("returns empty array on error", async () => {
			const octokit = createMockOctokit({
				repos: {
					listInvitationsForAuthenticatedUser: vi.fn(async () => {
						throw new Error("Network error");
					}),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listPendingInvitations();
			expect(result).toEqual([]);
		});

		it("handles sparse invitation data", async () => {
			const octokit = createMockOctokit({
				repos: {
					listInvitationsForAuthenticatedUser: vi.fn(async () => ({
						data: [
							{
								id: 3,
								repository: { full_name: undefined, name: undefined, owner: undefined },
								inviter: null,
								permissions: undefined,
								created_at: "2024-01-01T00:00:00Z",
								html_url: undefined,
							},
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listPendingInvitations();
			expect(result[0]).toEqual({
				id: 3,
				repository: { full_name: "", name: "", owner: { login: "" } },
				inviter: null,
				permissions: "read",
				created_at: "2024-01-01T00:00:00Z",
				html_url: "",
			});
		});
	});

	describe("acceptInvitation", () => {
		it("calls acceptInvitationForAuthenticatedUser", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.acceptInvitation(1);
			expect(octokit.repos.acceptInvitationForAuthenticatedUser).toHaveBeenCalledWith({ invitation_id: 1 });
		});

		it("rethrows errors", async () => {
			const octokit = createMockOctokit({
				repos: {
					acceptInvitationForAuthenticatedUser: vi.fn(async () => {
						throw new Error("Not found");
					}),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await expect(adapter.acceptInvitation(1)).rejects.toThrow("Not found");
		});
	});

	describe("updateIssueAssignees", () => {
		it("calls issues.update with assignees", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.updateIssueAssignees("mbrooks", "tars", 1, ["tars-bot"]);
			expect(octokit.issues.update).toHaveBeenCalledWith({ owner: "mbrooks", repo: "tars", issue_number: 1, assignees: ["tars-bot"] });
		});
	});

	describe("getAuthenticatedUser", () => {
		it("returns the authenticated user's login", async () => {
			const octokit = createMockOctokit({
				users: {
					getAuthenticated: vi.fn(async () => ({ data: { login: "octocat" } })),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getAuthenticatedUser();
			expect(result).toEqual({ login: "octocat" });
		});

		it("returns null when the user has no login", async () => {
			const octokit = createMockOctokit({
				users: {
					getAuthenticated: vi.fn(async () => ({ data: { login: undefined } })),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getAuthenticatedUser();
			expect(result).toBeNull();
		});

		it("returns null on error", async () => {
			const octokit = createMockOctokit({
				users: {
					getAuthenticated: vi.fn(async () => { throw new Error("Auth failed"); }),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getAuthenticatedUser();
			expect(result).toBeNull();
		});
	});

	describe("listAccessibleRepositories", () => {
		it("returns mapped repositories", async () => {
			const octokit = createMockOctokit({
				repos: {
					listForAuthenticatedUser: vi.fn(async () => ({
						data: [
							{ name: "tars", full_name: "mbrooks/tars", owner: { login: "mbrooks" } },
							{ name: "hello-world", full_name: "octocat/hello-world", owner: { login: "octocat" } },
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listAccessibleRepositories();
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({ owner: "mbrooks", repo: "tars", fullName: "mbrooks/tars" });
			expect(result[1]).toEqual({ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" });
		});

		it("returns empty array on error", async () => {
			const octokit = createMockOctokit({
				repos: {
					listForAuthenticatedUser: vi.fn(async () => { throw new Error("Network error"); }),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listAccessibleRepositories();
			expect(result).toEqual([]);
		});
	});

	describe("polling reads", () => {
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
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listIssuesUpdatedSince("mbrooks", "tars", "2026-06-01T00:00:00Z");
			expect(result[0]).toEqual(expect.objectContaining({
				number: 1,
				labels: [{ name: "tars" }],
				assignees: [{ login: "tars-bot" }],
			}));
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
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
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
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
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
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
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
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
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
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
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
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });

			expect(await adapter.listAccessibleRepositories()).toEqual([{ owner: "", repo: "", fullName: "" }]);
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
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await expect(adapter.listIssueEventsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).resolves.toEqual([]);
			await expect(adapter.listPRReviewsSince("mbrooks", "tars", "2026-06-01T00:00:00Z")).resolves.toEqual([]);
		});
	});
});
