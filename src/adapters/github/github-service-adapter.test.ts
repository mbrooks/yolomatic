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
			create: vi.fn(async () => ({ data: { number: 1, html_url: "https://github.com/mbrooks/yeetomatic/issues/1" } })),
			listLabelsForRepo: vi.fn(async () => ({ data: [] })),
			listForRepo: vi.fn(async () => ({ data: [] })),
			update: vi.fn(async () => ({ data: {} })),
			setLabels: vi.fn(async () => ({ data: [] })),
			...(overrides?.issues ?? {}),
		},
		pulls: {
			get: vi.fn(async () => ({ data: { head: { ref: "main" }, state: "open", merged: false } })),
			create: vi.fn(async () => ({ data: { number: 1, html_url: "https://github.com/mbrooks/yeetomatic/pulls/1" } })),
			list: vi.fn(async () => ({ data: [] })),
			listReviewComments: vi.fn(async () => ({ data: [] })),
			updateBranch: vi.fn(async () => ({ data: { message: "update" } })),
			update: vi.fn(async () => ({ data: {} })),
			...(overrides?.pulls ?? {}),
		},
		repos: {
			getContent: vi.fn(async () => ({ data: [] })),
			listCommits: vi.fn(async () => ({ data: [] })),
			listInvitationsForAuthenticatedUser: vi.fn(async () => ({ data: [] })),
			acceptInvitationForAuthenticatedUser: vi.fn(async () => ({ data: {} })),
			get: vi.fn(async () => ({ data: { default_branch: "main", full_name: "mbrooks/yeetomatic", visibility: "private" } })),
			createOrUpdateFileContents: vi.fn(async () => ({ data: {} })),
			listForAuthenticatedUser: vi.fn(async () => ({ data: [] })),
			getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: "read" } })),
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
			await adapter.postComment("mbrooks", "yeetomatic", 1, "hello");
			expect(octokit.issues.createComment).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", issue_number: 1, body: "hello" });
		});
	});

	describe("postPRComment", () => {
		it("calls issues.createComment with prNumber", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.postPRComment("mbrooks", "yeetomatic", 2, "review");
			expect(octokit.issues.createComment).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", issue_number: 2, body: "review" });
		});
	});

	describe("addLabels", () => {
		it("calls issues.addLabels", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.addLabels("mbrooks", "yeetomatic", 1, ["bug", "ui"]);
			expect(octokit.issues.addLabels).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", issue_number: 1, labels: ["bug", "ui"] });
		});
	});

	describe("removeLabel", () => {
		it("calls issues.removeLabel", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.removeLabel("mbrooks", "yeetomatic", 1, "bug");
			expect(octokit.issues.removeLabel).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", issue_number: 1, name: "bug" });
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
			await expect(adapter.removeLabel("mbrooks", "yeetomatic", 1, "bug")).resolves.toBeUndefined();
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
			await expect(adapter.removeLabel("mbrooks", "yeetomatic", 1, "bug")).rejects.toThrow("Server Error");
		});
	});

	describe("getPullRequest", () => {
		it("returns mapped PR info", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getPullRequest("mbrooks", "yeetomatic", 1);
			expect(result).toEqual({ head: { ref: "main" }, state: "open", merged: false });
		});

		it("returns null on error", async () => {
			const octokit = createMockOctokit({
				pulls: {
					get: vi.fn(async () => { throw new Error("Not found"); }),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getPullRequest("mbrooks", "yeetomatic", 99);
			expect(result).toBeNull();
		});
	});

	describe("createPullRequest", () => {
		it("returns created PR", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.createPullRequest("mbrooks", "yeetomatic", "Title", "Body", "feature", "main");
			expect(result).toEqual({ number: 1, html_url: "https://github.com/mbrooks/yeetomatic/pulls/1" });
		});

		it("returns null when no commits between branches", async () => {
			const octokit = createMockOctokit({
				pulls: {
					create: vi.fn(async () => { throw new Error("No commits between main and feature"); }),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.createPullRequest("mbrooks", "yeetomatic", "Title", "Body", "feature", "main");
			expect(result).toBeNull();
		});

		it("rethrows other errors", async () => {
			const octokit = createMockOctokit({
				pulls: {
					create: vi.fn(async () => { throw new Error("Auth failed"); }),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await expect(adapter.createPullRequest("mbrooks", "yeetomatic", "Title", "Body", "feature", "main")).rejects.toThrow("Auth failed");
		});
	});

	describe("updatePullRequestBranch", () => {
		it("calls pulls.updateBranch without expected_head_sha by default", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.updatePullRequestBranch("mbrooks", "yeetomatic", 42);
			expect(octokit.pulls.updateBranch).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", pull_number: 42 });
		});

		it("passes expected_head_sha when provided", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.updatePullRequestBranch("mbrooks", "yeetomatic", 42, "abcdef");
			expect(octokit.pulls.updateBranch).toHaveBeenCalledWith({
				owner: "mbrooks",
				repo: "yeetomatic",
				pull_number: 42,
				expected_head_sha: "abcdef",
			});
		});

		it("wraps merge-conflict errors with guidance", async () => {
			const octokit = createMockOctokit({
				pulls: { updateBranch: vi.fn(async () => { throw new Error("422 Unprocessable Entity: merge conflict"); }) },
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await expect(adapter.updatePullRequestBranch("mbrooks", "yeetomatic", 42)).rejects.toThrow(/update-branch failed/);
		});

		it("rethrows non-conflict errors unchanged", async () => {
			const octokit = createMockOctokit({
				pulls: { updateBranch: vi.fn(async () => { throw new Error("network down"); }) },
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await expect(adapter.updatePullRequestBranch("mbrooks", "yeetomatic", 42)).rejects.toThrow("network down");
		});
	});

	describe("listPullRequests", () => {
		it("returns mapped PRs", async () => {
			const octokit = createMockOctokit({
				pulls: {
					list: vi.fn(async () => ({
						data: [
							{ number: 1, html_url: "https://github.com/mbrooks/yeetomatic/pulls/1" },
							{ number: 2, html_url: "https://github.com/mbrooks/yeetomatic/pulls/2" },
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listPullRequests("mbrooks", "yeetomatic", { head: "feature", base: "main", state: "open" });
			expect(result).toHaveLength(2);
			expect(result[0].number).toBe(1);
		});
	});

	describe("getIssue", () => {
		it("returns issue state", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getIssue("mbrooks", "yeetomatic", 1);
			expect(result).toEqual({ state: "open" });
		});

		it("returns null on error", async () => {
			const octokit = createMockOctokit({
				issues: {
					get: vi.fn(async () => { throw new Error("Not found"); }),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getIssue("mbrooks", "yeetomatic", 99);
			expect(result).toBeNull();
		});
	});

	describe("createIssue", () => {
		it("returns created issue", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.createIssue("mbrooks", "yeetomatic", "Title", "Body", ["bug"], ["mbrooks"]);
			expect(result).toEqual({ number: 1, html_url: "https://github.com/mbrooks/yeetomatic/issues/1" });
		});
	});

	describe("initializeEmptyRepo", () => {
		it("fetches repo default branch and creates README via contents API", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.initializeEmptyRepo("mbrooks", "yeetomatic", "main");
			expect(octokit.repos.get).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic" });
			expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith({
				owner: "mbrooks",
				repo: "yeetomatic",
				path: "README.md",
				message: "Initial commit",
				content: Buffer.from("# yeetomatic\n\nAuto-initialized by Yeetomatic.\n").toString("base64"),
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
			await adapter.initializeEmptyRepo("mbrooks", "yeetomatic", "master");
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
			const result = await adapter.listReviewComments("mbrooks", "yeetomatic", 1, 10);
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
			const result = await adapter.listReviewComments("mbrooks", "yeetomatic", 1, 10);
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
			const result = await adapter.listLabels("mbrooks", "yeetomatic");
			expect(result).toEqual(["bug", "feature"]);
		});

		it("returns empty array on error", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listLabels("mbrooks", "yeetomatic");
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
			const result = await adapter.getIssueTemplates("mbrooks", "yeetomatic");
			expect(result).toEqual([{ name: "bug", body: "Template body" }]);
		});

		it("returns empty array when data is not array", async () => {
			const octokit = createMockOctokit({
				repos: {
					getContent: vi.fn(async () => ({ data: {} })),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getIssueTemplates("mbrooks", "yeetomatic");
			expect(result).toEqual([]);
		});

		it("returns empty array on error", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getIssueTemplates("mbrooks", "yeetomatic");
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
			const result = await adapter.listRecentCommits("mbrooks", "yeetomatic", 5);
			expect(result).toEqual(["abc1234: first commit", "def1234: second commit"]);
		});

		it("returns empty array on error", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listRecentCommits("mbrooks", "yeetomatic");
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
			const result = await adapter.listRelatedIssues("mbrooks", "yeetomatic", "bug", 5);
			expect(result).toEqual([{ number: 1, title: "Bug", state: "open" }]);
			expect(request).toHaveBeenCalledWith("GET /search/issues", {
				q: "repo:mbrooks/yeetomatic is:issue bug in:title",
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
			const result = await adapter.listRelatedIssues("mbrooks", "yeetomatic", "bug");
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
								html_url: "https://github.com/mbrooks/yeetomatic/issues/1",
							},
							{
								number: 2,
								title: "Feature request",
								body: null,
								state: "open",
								labels: [],
								assignees: [],
								html_url: "https://github.com/mbrooks/yeetomatic/issues/2",
							},
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listOpenIssues("mbrooks", "yeetomatic");
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({
				number: 1,
				title: "Bug report",
				body: "Something is broken",
				state: "open",
				labels: ["bug"],
				assignees: ["mbrooks"],
				html_url: "https://github.com/mbrooks/yeetomatic/issues/1",
			});
			expect(result[1]).toEqual({
				number: 2,
				title: "Feature request",
				body: "",
				state: "open",
				labels: [],
				assignees: [],
				html_url: "https://github.com/mbrooks/yeetomatic/issues/2",
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
								html_url: "https://github.com/mbrooks/yeetomatic/issues/1",
							},
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listOpenIssues("mbrooks", "yeetomatic");
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
								html_url: "https://github.com/mbrooks/yeetomatic/issues/1",
							},
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listOpenIssues("mbrooks", "yeetomatic");
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
			const result = await adapter.listOpenIssues("mbrooks", "yeetomatic");
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
			await adapter.updateIssueAssignees("mbrooks", "yeetomatic", 1, ["yeetomatic-bot"]);
			expect(octokit.issues.update).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", issue_number: 1, assignees: ["yeetomatic-bot"] });
		});
	});

	describe("closeIssue", () => {
		it("calls issues.update with state closed", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.closeIssue("mbrooks", "yeetomatic", 1);
			expect(octokit.issues.update).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", issue_number: 1, state: "closed" });
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
		it("returns mapped repositories with visibility", async () => {
			const octokit = createMockOctokit({
				repos: {
					listForAuthenticatedUser: vi.fn(async () => ({
						data: [
							{ name: "yeetomatic", full_name: "mbrooks/yeetomatic", owner: { login: "mbrooks" }, visibility: "private" },
							{ name: "hello-world", full_name: "octocat/hello-world", owner: { login: "octocat" }, visibility: "public" },
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listAccessibleRepositories();
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({ owner: "mbrooks", repo: "yeetomatic", fullName: "mbrooks/yeetomatic", visibility: "private" });
			expect(result[1]).toEqual({ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", visibility: "public" });
		});

		it("falls back to private flag when visibility is missing", async () => {
			const octokit = createMockOctokit({
				repos: {
					listForAuthenticatedUser: vi.fn(async () => ({
						data: [
							{ name: "yeetomatic", full_name: "mbrooks/yeetomatic", owner: { login: "mbrooks" }, private: true },
							{ name: "hello-world", full_name: "octocat/hello-world", owner: { login: "octocat" }, private: false },
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.listAccessibleRepositories();
			expect(result[0].visibility).toBe("private");
			expect(result[1].visibility).toBe("public");
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

	describe("getRepository", () => {
		it("returns repository info with visibility", async () => {
			const octokit = createMockOctokit({
				repos: {
					get: vi.fn(async () => ({
						data: { name: "yeetomatic", full_name: "mbrooks/yeetomatic", owner: { login: "mbrooks" }, visibility: "private" },
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getRepository("mbrooks", "yeetomatic");
			expect(result).toEqual({ owner: "mbrooks", repo: "yeetomatic", fullName: "mbrooks/yeetomatic", visibility: "private" });
			expect(octokit.repos.get).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic" });
		});

		it("falls back to private flag when visibility is missing", async () => {
			const octokit = createMockOctokit({
				repos: {
					get: vi.fn(async () => ({
						data: { name: "hello-world", full_name: "octocat/hello-world", owner: { login: "octocat" }, private: false },
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getRepository("octocat", "hello-world");
			expect(result?.visibility).toBe("public");
		});

		it("returns null when repo is not accessible", async () => {
			const octokit = createMockOctokit({
				repos: {
					get: vi.fn(async () => { throw new Error("Not found"); }),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getRepository("unknown", "missing");
			expect(result).toBeNull();
		});
	});

	describe("getCollaboratorPermissionLevel", () => {
		it("returns the permission level when it is a known value", async () => {
			const octokit = createMockOctokit({
				repos: {
					getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: "admin" } })),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getCollaboratorPermissionLevel("mbrooks", "yeetomatic", "octocat");
			expect(result).toBe("admin");
			expect(octokit.repos.getCollaboratorPermissionLevel).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", username: "octocat" });
		});

		it("returns null when the permission value is unrecognized", async () => {
			const octokit = createMockOctokit({
				repos: {
					getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: "unknown" } })),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getCollaboratorPermissionLevel("mbrooks", "yeetomatic", "octocat");
			expect(result).toBeNull();
		});

		it("returns null when permission is missing", async () => {
			const octokit = createMockOctokit({
				repos: {
					getCollaboratorPermissionLevel: vi.fn(async () => ({ data: {} })),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getCollaboratorPermissionLevel("mbrooks", "yeetomatic", "octocat");
			expect(result).toBeNull();
		});

		it("returns null on error", async () => {
			const octokit = createMockOctokit({
				repos: {
					getCollaboratorPermissionLevel: vi.fn(async () => { throw new Error("Not found"); }),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const result = await adapter.getCollaboratorPermissionLevel("mbrooks", "yeetomatic", "octocat");
			expect(result).toBeNull();
		});
	});

	describe("getIssueDetail", () => {
		it("maps issue fields including labels and assignees", async () => {
			const octokit = createMockOctokit({
				issues: {
					get: vi.fn(async () => ({
						data: {
							number: 502,
							title: "Expose gateway",
							body: "body text",
							state: "open",
							labels: [{ name: "bug" }, "ui"],
							assignees: [{ login: "mbrooks" }],
							html_url: "https://github.com/mbrooks/yeetomatic/issues/502",
							created_at: "2026-08-01T00:00:00Z",
							updated_at: "2026-08-01T01:00:00Z",
						},
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const detail = await adapter.getIssueDetail("mbrooks", "yeetomatic", 502);
			expect(detail).toEqual({
				number: 502,
				title: "Expose gateway",
				body: "body text",
				state: "open",
				labels: ["bug", "ui"],
				assignees: ["mbrooks"],
				html_url: "https://github.com/mbrooks/yeetomatic/issues/502",
				created_at: "2026-08-01T00:00:00Z",
				updated_at: "2026-08-01T01:00:00Z",
			});
		});

		it("returns null when the issue fetch fails", async () => {
			const octokit = createMockOctokit({
				issues: { get: vi.fn(async () => { throw new Error("nope"); }) },
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			expect(await adapter.getIssueDetail("mbrooks", "yeetomatic", 1)).toBeNull();
		});

		it("treats closed state as closed and null body as empty", async () => {
			const octokit = createMockOctokit({
				issues: {
					get: vi.fn(async () => ({
						data: { number: 1, title: "t", body: null, state: "closed", labels: [], assignees: [], html_url: "u", created_at: "a", updated_at: "b" },
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const detail = await adapter.getIssueDetail("mbrooks", "yeetomatic", 1);
			expect(detail?.state).toBe("closed");
			expect(detail?.body).toBe("");
		});
	});

	describe("listIssueComments", () => {
		it("maps comments with author and timestamps", async () => {
			const octokit = createMockOctokit({
				issues: {
					listComments: vi.fn(async () => ({
						data: [
							{ id: 1, body: "c1", user: { login: "mbrooks" }, created_at: "a", updated_at: "b", html_url: "u1" },
							{ id: 2, body: null, user: null, created_at: "a", updated_at: "b", html_url: "u2" },
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const comments = await adapter.listIssueComments("mbrooks", "yeetomatic", 1);
			expect(comments).toEqual([
				{ id: 1, body: "c1", author: "mbrooks", created_at: "a", updated_at: "b", html_url: "u1" },
				{ id: 2, body: "", author: "unknown", created_at: "a", updated_at: "b", html_url: "u2" },
			]);
		});

		it("returns empty on error", async () => {
			const octokit = createMockOctokit({
				issues: { listComments: vi.fn(async () => { throw new Error("nope"); }) },
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			expect(await adapter.listIssueComments("mbrooks", "yeetomatic", 1)).toEqual([]);
		});
	});

	describe("updateIssue", () => {
		it("sends only provided fields to issues.update", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.updateIssue("mbrooks", "yeetomatic", 1, { title: "T", state: "closed", assignees: ["a"], labels: ["b"] });
			expect(octokit.issues.update).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", issue_number: 1, title: "T", state: "closed", assignees: ["a"], labels: ["b"] });
		});

		it("is a no-op when no fields are provided", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.updateIssue("mbrooks", "yeetomatic", 1, {});
			expect(octokit.issues.update).not.toHaveBeenCalled();
		});

		it("sends body when provided", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.updateIssue("mbrooks", "yeetomatic", 1, { body: "new body" });
			expect(octokit.issues.update).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", issue_number: 1, body: "new body" });
		});
	});

	describe("setLabels", () => {
		it("calls issues.setLabels with the given labels", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.setLabels("mbrooks", "yeetomatic", 1, ["a", "b"]);
			expect(octokit.issues.setLabels).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", issue_number: 1, labels: ["a", "b"] });
		});

		it("swallows 404 when clearing labels on an unlabeled issue", async () => {
			const octokit = createMockOctokit({
				issues: {
					setLabels: vi.fn(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await expect(adapter.setLabels("mbrooks", "yeetomatic", 1, [])).resolves.toBeUndefined();
		});

		it("rethrows non-404 errors from setLabels", async () => {
			const octokit = createMockOctokit({
				issues: {
					setLabels: vi.fn(async () => { throw Object.assign(new Error("Boom"), { status: 500 }); }),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await expect(adapter.setLabels("mbrooks", "yeetomatic", 1, ["x"])).rejects.toThrow("Boom");
		});
	});

	describe("getPullRequestDetail", () => {
		it("maps PR detail fields", async () => {
			const octokit = createMockOctokit({
				pulls: {
					get: vi.fn(async () => ({
						data: {
							number: 7, title: "PR", body: "b", state: "open", merged: false,
							head: { ref: "yeetomatic/issue-502" }, base: { ref: "main" },
							html_url: "u", created_at: "a", updated_at: "b",
						},
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const pr = await adapter.getPullRequestDetail("mbrooks", "yeetomatic", 7);
			expect(pr).toEqual({
				number: 7, title: "PR", body: "b", state: "open", merged: false,
				head_ref: "yeetomatic/issue-502", base_ref: "main", html_url: "u", created_at: "a", updated_at: "b",
			});
		});

		it("returns null on error", async () => {
			const octokit = createMockOctokit({
				pulls: { get: vi.fn(async () => { throw new Error("nope"); }) },
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			expect(await adapter.getPullRequestDetail("mbrooks", "yeetomatic", 1)).toBeNull();
		});

		it("maps closed state and null body", async () => {
			const octokit = createMockOctokit({
				pulls: {
					get: vi.fn(async () => ({
						data: { number: 1, title: "t", body: null, state: "closed", merged: true, head: { ref: "h" }, base: { ref: "b" }, html_url: "u", created_at: "a", updated_at: "b" },
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const pr = await adapter.getPullRequestDetail("mbrooks", "yeetomatic", 1);
			expect(pr?.state).toBe("closed");
			expect(pr?.body).toBe("");
			expect(pr?.merged).toBe(true);
		});
	});

	describe("listPullRequestComments", () => {
		it("delegates to the issue comment mapping", async () => {
			const octokit = createMockOctokit({
				issues: {
					listComments: vi.fn(async () => ({
						data: [{ id: 9, body: "prc", user: { login: "r" }, created_at: "a", updated_at: "b", html_url: "u" }],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const comments = await adapter.listPullRequestComments("mbrooks", "yeetomatic", 7);
			expect(octokit.issues.listComments).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", issue_number: 7, per_page: 100 });
			expect(comments).toHaveLength(1);
			expect(comments[0].author).toBe("r");
		});
	});

	describe("listPullRequestReviewComments", () => {
		it("maps review comments", async () => {
			const octokit = createMockOctokit({
				pulls: {
					listReviewComments: vi.fn(async () => ({
						data: [
							{ id: 1, body: "nit", user: { login: "rev" }, path: "a.ts", line: 3 },
							{ id: 2, body: null, user: null, path: "b.ts", line: null },
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const comments = await adapter.listPullRequestReviewComments("mbrooks", "yeetomatic", 7);
			expect(octokit.pulls.listReviewComments).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", pull_number: 7, per_page: 100 });
			expect(comments).toEqual([
				{ id: 1, body: "nit", user: { login: "rev" }, path: "a.ts", line: 3 },
				{ id: 2, body: "", user: undefined, path: "b.ts", line: null },
			]);
		});

		it("returns empty on error", async () => {
			const octokit = createMockOctokit({
				pulls: { listReviewComments: vi.fn(async () => { throw new Error("nope"); }) },
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			expect(await adapter.listPullRequestReviewComments("mbrooks", "yeetomatic", 7)).toEqual([]);
		});
	});

	describe("listPullRequestsForHead", () => {
		it("maps PR summaries for a head branch", async () => {
			const octokit = createMockOctokit({
				pulls: {
					list: vi.fn(async () => ({
						data: [
							{ number: 88, title: "PR", html_url: "u", head: { ref: "yeetomatic/issue-502" }, base: { ref: "main" }, state: "open" },
						],
					})),
				},
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			const prs = await adapter.listPullRequestsForHead("mbrooks", "yeetomatic", "yeetomatic/issue-502", "open");
			expect(octokit.pulls.list).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", head: "yeetomatic/issue-502", state: "open", per_page: 100 });
			expect(prs).toEqual([{ number: 88, title: "PR", html_url: "u", head_ref: "yeetomatic/issue-502", base_ref: "main", state: "open", merged: false }]);
		});

		it("returns empty on error", async () => {
			const octokit = createMockOctokit({
				pulls: { list: vi.fn(async () => { throw new Error("nope"); }) },
			});
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			expect(await adapter.listPullRequestsForHead("mbrooks", "yeetomatic", "h", "open")).toEqual([]);
		});
	});

	describe("updatePullRequest", () => {
		it("updates title/body/state via pulls.update", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.updatePullRequest("mbrooks", "yeetomatic", 7, { title: "T", body: "B", state: "open" });
			expect(octokit.pulls.update).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", pull_number: 7, title: "T", body: "B", state: "open" });
			expect(octokit.issues.setLabels).not.toHaveBeenCalled();
		});

		it("sets labels via the issues API when labels provided", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.updatePullRequest("mbrooks", "yeetomatic", 7, { labels: ["x"] });
			expect(octokit.pulls.update).not.toHaveBeenCalled();
			expect(octokit.issues.setLabels).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", issue_number: 7, labels: ["x"] });
		});

		it("updates both metadata and labels when both provided", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.updatePullRequest("mbrooks", "yeetomatic", 7, { title: "T", labels: ["x"] });
			expect(octokit.pulls.update).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", pull_number: 7, title: "T" });
			expect(octokit.issues.setLabels).toHaveBeenCalledWith({ owner: "mbrooks", repo: "yeetomatic", issue_number: 7, labels: ["x"] });
		});

		it("is a no-op when no fields are provided", async () => {
			const octokit = createMockOctokit();
			const adapter = new GitHubServiceAdapter({ githubToken: "token", octokit: octokit as never });
			await adapter.updatePullRequest("mbrooks", "yeetomatic", 7, {});
			expect(octokit.pulls.update).not.toHaveBeenCalled();
			expect(octokit.issues.setLabels).not.toHaveBeenCalled();
		});
	});
});
