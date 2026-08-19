import { describe, expect, it, vi } from "vitest";
import { PullRequestDelegate } from "./pull-request-delegate.js";

type MockOctokit = Record<string, Record<string, ReturnType<typeof vi.fn>>>;

interface OctokitOverrides {
	pulls?: Record<string, ReturnType<typeof vi.fn>>;
	issues?: Record<string, ReturnType<typeof vi.fn>>;
	graphql?: ReturnType<typeof vi.fn>;
}

function mockOctokit(overrides: OctokitOverrides = {}): MockOctokit {
	return {
		pulls: {
			get: vi.fn(async () => ({ data: { head: { ref: "main" }, state: "open", merged: false } })),
			create: vi.fn(async () => ({ data: { number: 1, html_url: "https://github.com/o/r/pulls/1" } })),
			list: vi.fn(async () => ({ data: [] })),
			listReviewComments: vi.fn(async () => ({ data: [] })),
			updateBranch: vi.fn(async () => ({ data: { message: "ok" } })),
			update: vi.fn(async () => ({ data: {} })),
			...(overrides.pulls ?? {}),
		},
		issues: {
			createComment: vi.fn(async () => ({ data: { id: 202 } })),
			...(overrides.issues ?? {}),
		},
		graphql: overrides.graphql ?? vi.fn(async () => ({ repository: { pullRequest: { id: "PR_nodeid" } } })),
	} as unknown as MockOctokit;
}

describe("PullRequestDelegate", () => {
	describe("getPullRequest", () => {
		it("maps mergeable, mergeable_state, and draft from the Octokit response", async () => {
			const o = mockOctokit({
				pulls: {
					get: vi.fn(async () => ({
						data: {
							head: { ref: "yolomatic/issue-1", sha: "abc" },
							state: "open", merged: false, mergeable: true,
							mergeable_state: "clean", draft: true, base: { ref: "main" },
						},
					})),
				},
			});
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.getPullRequest("o", "r", 7)).toEqual({
				head: { ref: "yolomatic/issue-1", sha: "abc" },
				base: { ref: "main" }, state: "open", merged: false,
				mergeable: true, mergeableState: "clean", draft: true,
			});
			expect(o.pulls.get).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 7 });
		});

		it("defaults base ref to empty string and mergeableState to unknown", async () => {
			const o = mockOctokit();
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.getPullRequest("o", "r", 1)).toEqual({
				head: { ref: "main" }, base: { ref: "" }, state: "open", merged: false,
				mergeable: null, mergeableState: "unknown", draft: false,
			});
		});

		it("returns null on error", async () => {
			const o = mockOctokit({ pulls: { get: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.getPullRequest("o", "r", 9)).toBeNull();
		});
	});

	describe("createPullRequest", () => {
		it("returns created PR and forwards draft option", async () => {
			const o = mockOctokit();
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.createPullRequest("o", "r", "T", "B", "head", "main", true)).toEqual({
				number: 1, html_url: "https://github.com/o/r/pulls/1",
			});
			expect(o.pulls.create).toHaveBeenCalledWith({ owner: "o", repo: "r", title: "T", body: "B", head: "head", base: "main", draft: true });
		});

		it("omits draft when not specified", async () => {
			const o = mockOctokit();
			const delegate = new PullRequestDelegate(o as never);
			await delegate.createPullRequest("o", "r", "T", "B", "head", "main");
			expect(o.pulls.create).toHaveBeenCalledWith({ owner: "o", repo: "r", title: "T", body: "B", head: "head", base: "main" });
		});

		it("returns null when no commits between branches", async () => {
			const o = mockOctokit({ pulls: { create: vi.fn(async () => { throw new Error("No commits between main and feature"); }) } });
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.createPullRequest("o", "r", "T", "B", "head", "main")).toBeNull();
		});

		it("rethrows other errors", async () => {
			const o = mockOctokit({ pulls: { create: vi.fn(async () => { throw new Error("Auth failed"); }) } });
			const delegate = new PullRequestDelegate(o as never);
			await expect(delegate.createPullRequest("o", "r", "T", "B", "head", "main")).rejects.toThrow("Auth failed");
		});
	});

	describe("updatePullRequestBranch", () => {
		it("calls pulls.updateBranch without expected_head_sha by default", async () => {
			const o = mockOctokit();
			const delegate = new PullRequestDelegate(o as never);
			await delegate.updatePullRequestBranch("o", "r", 42);
			expect(o.pulls.updateBranch).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 42 });
		});

		it("passes expected_head_sha when provided", async () => {
			const o = mockOctokit();
			const delegate = new PullRequestDelegate(o as never);
			await delegate.updatePullRequestBranch("o", "r", 42, "abcdef");
			expect(o.pulls.updateBranch).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 42, expected_head_sha: "abcdef" });
		});

		it("wraps merge-conflict errors with guidance", async () => {
			const o = mockOctokit({ pulls: { updateBranch: vi.fn(async () => { throw new Error("422 merge conflict"); }) } });
			const delegate = new PullRequestDelegate(o as never);
			await expect(delegate.updatePullRequestBranch("o", "r", 42)).rejects.toThrow(/update-branch failed/);
		});

		it("rethrows non-conflict errors unchanged", async () => {
			const o = mockOctokit({ pulls: { updateBranch: vi.fn(async () => { throw new Error("network down"); }) } });
			const delegate = new PullRequestDelegate(o as never);
			await expect(delegate.updatePullRequestBranch("o", "r", 42)).rejects.toThrow("network down");
		});
	});

	describe("markPullRequestReadyForReview", () => {
		it("resolves the node id then runs the GraphQL mutation", async () => {
			const calls: Array<{ vars: unknown }> = [];
			const graphql = vi.fn(async (query: string, variables: unknown) => {
				calls.push({ vars: variables });
				if (query.includes("markPullRequestReadyForReview")) {
					return { markPullRequestReadyForReview: { pullRequest: { id: "PR_nodeid", isDraft: false } } };
				}
				return { repository: { pullRequest: { id: "PR_nodeid" } } };
			});
			const o = mockOctokit({ graphql });
			const delegate = new PullRequestDelegate(o as never);
			await delegate.markPullRequestReadyForReview("o", "r", 42);
			expect(calls[0].vars).toEqual({ owner: "o", repo: "r", number: 42 });
			expect(calls[1].vars).toEqual({ input: { pullRequestId: "PR_nodeid" } });
			expect(graphql).toHaveBeenCalledTimes(2);
		});

		it("throws when the GraphQL node id cannot be resolved", async () => {
			const o = mockOctokit({ graphql: vi.fn(async () => ({ repository: { pullRequest: null } })) });
			const delegate = new PullRequestDelegate(o as never);
			await expect(delegate.markPullRequestReadyForReview("o", "r", 42)).rejects.toThrow("Could not resolve GitHub node id");
		});
	});

	describe("listPullRequests", () => {
		it("returns mapped PRs with number and html_url", async () => {
			const o = mockOctokit({
				pulls: {
					list: vi.fn(async () => ({
						data: [
							{ number: 1, html_url: "u1" },
							{ number: 2, html_url: "u2" },
						],
					})),
				},
			});
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.listPullRequests("o", "r", { head: "h", base: "main", state: "open" })).toEqual([
				{ number: 1, html_url: "u1" },
				{ number: 2, html_url: "u2" },
			]);
			expect(o.pulls.list).toHaveBeenCalledWith({ owner: "o", repo: "r", head: "h", base: "main", state: "open" });
		});
	});

	describe("listOpenPullRequests", () => {
		it("returns open PR numbers from a single page", async () => {
			const o = mockOctokit({ pulls: { list: vi.fn(async () => ({ data: [{ number: 11 }, { number: 12 }] })) } });
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.listOpenPullRequests("o", "r")).toEqual([11, 12]);
			expect(o.pulls.list).toHaveBeenCalledWith({ owner: "o", repo: "r", state: "open", per_page: 100, page: 1 });
		});

		it("paginates until a short page is returned", async () => {
			const page1 = Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i }));
			const page2 = [{ number: 5 }, { number: 6 }];
			const list = vi.fn(async (args: unknown) => {
				const page = (args as { page: number }).page;
				return { data: page === 1 ? page1 : page2 };
			});
			const o = mockOctokit({ pulls: { list } });
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.listOpenPullRequests("o", "r")).toHaveLength(102);
			expect(list).toHaveBeenNthCalledWith(2, { owner: "o", repo: "r", state: "open", per_page: 100, page: 2 });
		});

		it("stops at the safety cap of 500 PRs", async () => {
			const page = Array.from({ length: 100 }, (_, i) => ({ number: i }));
			const list = vi.fn(async () => ({ data: page }));
			const o = mockOctokit({ pulls: { list } });
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.listOpenPullRequests("o", "r")).toHaveLength(500);
		});

		it("returns what was collected so far on error", async () => {
			let call = 0;
			const list = vi.fn(async () => {
				call += 1;
				if (call === 1) return { data: [{ number: 7 }] };
				throw new Error("x");
			});
			const o = mockOctokit({ pulls: { list } });
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.listOpenPullRequests("o", "r")).toEqual([7]);
		});

		it("returns an empty array when the first page errors", async () => {
			const o = mockOctokit({ pulls: { list: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.listOpenPullRequests("o", "r")).toEqual([]);
		});
	});

	describe("getPullRequestDetail", () => {
		it("maps PR detail fields", async () => {
			const o = mockOctokit({
				pulls: {
					get: vi.fn(async () => ({
						data: {
							number: 7, title: "PR", body: "b", state: "open", merged: false,
							head: { ref: "h" }, base: { ref: "main" }, html_url: "u", created_at: "a", updated_at: "b",
						},
					})),
				},
			});
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.getPullRequestDetail("o", "r", 7)).toEqual({
				number: 7, title: "PR", body: "b", state: "open", merged: false,
				head_ref: "h", base_ref: "main", html_url: "u", created_at: "a", updated_at: "b",
			});
		});

		it("returns null on error", async () => {
			const o = mockOctokit({ pulls: { get: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.getPullRequestDetail("o", "r", 1)).toBeNull();
		});

		it("maps closed state and null body", async () => {
			const o = mockOctokit({
				pulls: {
					get: vi.fn(async () => ({
						data: { number: 1, title: "t", body: null, state: "closed", merged: true, head: { ref: "h" }, base: { ref: "b" }, html_url: "u", created_at: "a", updated_at: "b" },
					})),
				},
			});
			const delegate = new PullRequestDelegate(o as never);
			const pr = await delegate.getPullRequestDetail("o", "r", 1);
			expect(pr?.state).toBe("closed");
			expect(pr?.body).toBe("");
			expect(pr?.merged).toBe(true);
		});
	});

	describe("listReviewComments (by review id)", () => {
		it("maps review comments scoped to a review id", async () => {
			const o = mockOctokit({
				pulls: {
					listReviewComments: vi.fn(async () => ({
						data: [{ id: 1, body: "nit", user: { login: "rev" }, path: "a.ts", line: 3 }],
					})),
				},
			});
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.listReviewComments("o", "r", 7, 99)).toEqual([
				{ id: 1, body: "nit", user: { login: "rev" }, path: "a.ts", line: 3 },
			]);
			expect(o.pulls.listReviewComments).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 7, review_id: 99 });
		});

		it("returns empty array on error", async () => {
			const o = mockOctokit({ pulls: { listReviewComments: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.listReviewComments("o", "r", 7, 99)).toEqual([]);
		});
	});

	describe("listPullRequestReviewComments", () => {
		it("maps review comments with per_page 100", async () => {
			const o = mockOctokit({
				pulls: {
					listReviewComments: vi.fn(async () => ({
						data: [
							{ id: 1, body: "nit", user: { login: "rev" }, path: "a.ts", line: 3 },
							{ id: 2, body: null, user: null, path: "b.ts", line: null },
						],
					})),
				},
			});
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.listPullRequestReviewComments("o", "r", 7)).toEqual([
				{ id: 1, body: "nit", user: { login: "rev" }, path: "a.ts", line: 3 },
				{ id: 2, body: "", user: undefined, path: "b.ts", line: null },
			]);
			expect(o.pulls.listReviewComments).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 7, per_page: 100 });
		});

		it("returns empty on error", async () => {
			const o = mockOctokit({ pulls: { listReviewComments: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.listPullRequestReviewComments("o", "r", 7)).toEqual([]);
		});
	});

	describe("listPullRequestsForHead", () => {
		it("maps PR summaries for a head branch", async () => {
			const o = mockOctokit({
				pulls: {
					list: vi.fn(async () => ({
						data: [
							{ number: 88, title: "PR", html_url: "u", head: { ref: "h" }, base: { ref: "main" }, state: "open" },
						],
					})),
				},
			});
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.listPullRequestsForHead("o", "r", "h", "open")).toEqual([
				{ number: 88, title: "PR", html_url: "u", head_ref: "h", base_ref: "main", state: "open", merged: false },
			]);
			expect(o.pulls.list).toHaveBeenCalledWith({ owner: "o", repo: "r", head: "h", state: "open", per_page: 100 });
		});

		it("returns empty on error", async () => {
			const o = mockOctokit({ pulls: { list: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new PullRequestDelegate(o as never);
			expect(await delegate.listPullRequestsForHead("o", "r", "h", "open")).toEqual([]);
		});
	});

	describe("updatePullRequestMetadata", () => {
		it("updates title/body/state via pulls.update", async () => {
			const o = mockOctokit();
			const delegate = new PullRequestDelegate(o as never);
			await delegate.updatePullRequestMetadata("o", "r", 7, { title: "T", body: "B", state: "open" });
			expect(o.pulls.update).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 7, title: "T", body: "B", state: "open" });
		});

		it("updates only provided fields", async () => {
			const o = mockOctokit();
			const delegate = new PullRequestDelegate(o as never);
			await delegate.updatePullRequestMetadata("o", "r", 7, { title: "T" });
			expect(o.pulls.update).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 7, title: "T" });
		});

		it("is a no-op when no fields are provided", async () => {
			const o = mockOctokit();
			const delegate = new PullRequestDelegate(o as never);
			await delegate.updatePullRequestMetadata("o", "r", 7, {});
			expect(o.pulls.update).not.toHaveBeenCalled();
		});
	});

	describe("postPRComment", () => {
		it("posts an issue-style comment on the PR number and returns the id", async () => {
			const o = mockOctokit();
			const delegate = new PullRequestDelegate(o as never);
			const id = await delegate.postPRComment("o", "r", 7, "review");
			expect(id).toBe(202);
			expect(o.issues.createComment).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 7, body: "review" });
		});
	});
});