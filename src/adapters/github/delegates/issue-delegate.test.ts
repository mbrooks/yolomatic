import { describe, expect, it, vi } from "vitest";
import { IssueDelegate } from "./issue-delegate.js";

type MockOctokit = Record<string, Record<string, ReturnType<typeof vi.fn>>>;

interface OctokitOverrides {
	issues?: Record<string, ReturnType<typeof vi.fn>>;
	repos?: Record<string, ReturnType<typeof vi.fn>>;
	request?: ReturnType<typeof vi.fn>;
}

function mockOctokit(overrides: OctokitOverrides = {}): MockOctokit {
	return {
		issues: {
			createComment: vi.fn(async () => ({ data: { id: 101 } })),
			addLabels: vi.fn(async () => ({ data: [] })),
			removeLabel: vi.fn(async () => ({ data: [] })),
			get: vi.fn(async () => ({ data: { number: 1, state: "open", title: "t", body: "b" } })),
			create: vi.fn(async () => ({ data: { number: 5, html_url: "https://github.com/o/r/issues/5" } })),
			listLabelsForRepo: vi.fn(async () => ({ data: [{ name: "bug" }, { name: "ui" }] })),
			listForRepo: vi.fn(async () => ({ data: [] })),
			listComments: vi.fn(async () => ({ data: [] })),
			update: vi.fn(async () => ({ data: {} })),
			setLabels: vi.fn(async () => ({ data: [] })),
			...(overrides.issues ?? {}),
		},
		repos: {
			getContent: vi.fn(async () => ({ data: [] })),
			...(overrides.repos ?? {}),
		},
		request: overrides.request ?? vi.fn(async () => ({ data: { items: [] } })),
	} as unknown as MockOctokit;
}

describe("IssueDelegate", () => {
	describe("postComment", () => {
		it("returns the created comment id and calls issues.createComment", async () => {
			const o = mockOctokit();
			const delegate = new IssueDelegate(o as never);
			const id = await delegate.postComment("o", "r", 3, "hi");
			expect(id).toBe(101);
			expect(o.issues.createComment).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 3, body: "hi" });
		});
	});

	describe("addLabels / removeLabel", () => {
		it("forwards labels to issues.addLabels", async () => {
			const o = mockOctokit();
			const delegate = new IssueDelegate(o as never);
			await delegate.addLabels("o", "r", 1, ["bug"]);
			expect(o.issues.addLabels).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 1, labels: ["bug"] });
		});

		it("swallows 404 from removeLabel and rethrows other statuses", async () => {
			const o = mockOctokit({
				issues: {
					removeLabel: vi.fn(async () => {
						throw Object.assign(new Error("Not Found"), { status: 404 });
					}),
				},
			});
			const delegate = new IssueDelegate(o as never);
			await expect(delegate.removeLabel("o", "r", 1, "bug")).resolves.toBeUndefined();
		});

		it("rethrows non-404 removeLabel errors", async () => {
			const o = mockOctokit({
				issues: {
					removeLabel: vi.fn(async () => {
						throw Object.assign(new Error("Boom"), { status: 500 });
					}),
				},
			});
			const delegate = new IssueDelegate(o as never);
			await expect(delegate.removeLabel("o", "r", 1, "bug")).rejects.toThrow("Boom");
		});
	});

	describe("getIssue", () => {
		it("returns normalized state/title/body and returns null on error", async () => {
			const o = mockOctokit({
				issues: {
					get: vi.fn(async () => ({ data: { state: "open", title: "T", body: "B" } })),
				},
			});
			const delegate = new IssueDelegate(o as never);
			expect(await delegate.getIssue("o", "r", 7)).toEqual({ state: "open", title: "T", body: "B" });
			expect(o.issues.get).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 7 });
		});

		it("returns null when issues.get throws", async () => {
			const o = mockOctokit({ issues: { get: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new IssueDelegate(o as never);
			expect(await delegate.getIssue("o", "r", 7)).toBeNull();
		});
	});

	describe("getIssueDetail", () => {
		it("maps issue fields including labels and assignees", async () => {
			const o = mockOctokit({
				issues: {
					get: vi.fn(async () => ({
						data: {
							number: 1, title: "T", body: "B", state: "open",
							labels: [{ name: "bug" }, { name: "" }, "ui"],
							assignees: [{ login: "a" }, { login: "" }],
							html_url: "u", created_at: "c", updated_at: "u2",
						},
					})),
				},
			});
			const delegate = new IssueDelegate(o as never);
			const detail = await delegate.getIssueDetail("o", "r", 1);
			expect(detail).toEqual({
				number: 1, title: "T", body: "B", state: "open",
				labels: ["bug", "ui"], assignees: ["a"], html_url: "u", created_at: "c", updated_at: "u2",
			});
		});

		it("treats closed state and null body", async () => {
			const o = mockOctokit({
				issues: {
					get: vi.fn(async () => ({
						data: { number: 2, title: "T", body: null, state: "closed", labels: [], assignees: [], html_url: "u", created_at: "c", updated_at: "u" },
					})),
				},
			});
			const delegate = new IssueDelegate(o as never);
			const detail = await delegate.getIssueDetail("o", "r", 2);
			expect(detail?.state).toBe("closed");
			expect(detail?.body).toBe("");
		});

		it("returns null on error", async () => {
			const o = mockOctokit({ issues: { get: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new IssueDelegate(o as never);
			expect(await delegate.getIssueDetail("o", "r", 1)).toBeNull();
		});
	});

	describe("createIssue", () => {
		it("returns number and html_url and forwards labels/assignees", async () => {
			const o = mockOctokit();
			const delegate = new IssueDelegate(o as never);
			const issue = await delegate.createIssue("o", "r", "T", "B", ["bug"], ["a"]);
			expect(issue).toEqual({ number: 5, html_url: "https://github.com/o/r/issues/5" });
			expect(o.issues.create).toHaveBeenCalledWith({ owner: "o", repo: "r", title: "T", body: "B", labels: ["bug"], assignees: ["a"] });
		});
	});

	describe("listIssueComments", () => {
		it("maps comments with author and timestamps, requesting per_page 100", async () => {
			const o = mockOctokit({
				issues: {
					listComments: vi.fn(async () => ({
						data: [{ id: 9, body: "c", user: { login: "r" }, created_at: "a", updated_at: "b", html_url: "u" }],
					})),
				},
			});
			const delegate = new IssueDelegate(o as never);
			const comments = await delegate.listIssueComments("o", "r", 3);
			expect(o.issues.listComments).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 3, per_page: 100 });
			expect(comments).toEqual([{ id: 9, body: "c", author: "r", created_at: "a", updated_at: "b", html_url: "u" }]);
		});

		it("returns empty array on error", async () => {
			const o = mockOctokit({ issues: { listComments: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new IssueDelegate(o as never);
			expect(await delegate.listIssueComments("o", "r", 3)).toEqual([]);
		});
	});

	describe("listOpenIssues", () => {
		it("maps open issues and filters empty label/assignee names", async () => {
			const o = mockOctokit({
				issues: {
					listForRepo: vi.fn(async () => ({
						data: [
							{
								number: 1, title: "T", body: "B", state: "open", html_url: "u",
								labels: [{ name: "bug" }, { name: "" }, "ui"],
								assignees: [{ login: "a" }, { login: "" }],
							},
						],
					})),
				},
			});
			const delegate = new IssueDelegate(o as never);
			const issues = await delegate.listOpenIssues("o", "r");
			expect(o.issues.listForRepo).toHaveBeenCalledWith({ owner: "o", repo: "r", state: "open" });
			expect(issues).toEqual([
				{ number: 1, title: "T", body: "B", state: "open", labels: ["bug", "ui"], assignees: ["a"], html_url: "u" },
			]);
		});

		it("returns empty array on error", async () => {
			const o = mockOctokit({ issues: { listForRepo: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new IssueDelegate(o as never);
			expect(await delegate.listOpenIssues("o", "r")).toEqual([]);
		});
	});

	describe("listLabels", () => {
		it("returns label names", async () => {
			const o = mockOctokit();
			const delegate = new IssueDelegate(o as never);
			expect(await delegate.listLabels("o", "r")).toEqual(["bug", "ui"]);
		});

		it("returns empty array on error", async () => {
			const o = mockOctokit({ issues: { listLabelsForRepo: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new IssueDelegate(o as never);
			expect(await delegate.listLabels("o", "r")).toEqual([]);
		});
	});

	describe("listRelatedIssues", () => {
		it("returns mapped search results", async () => {
			const o = mockOctokit({
				request: vi.fn(async () => ({ data: { items: [{ number: 9, title: "T", state: "open" }] } })),
			});
			const delegate = new IssueDelegate(o as never);
			const issues = await delegate.listRelatedIssues("o", "r", "query", 5);
			expect(o.request).toHaveBeenCalledWith("GET /search/issues", { q: "repo:o/r is:issue query in:title", per_page: 5 });
			expect(issues).toEqual([{ number: 9, title: "T", state: "open" }]);
		});

		it("returns empty array on error", async () => {
			const o = mockOctokit({ request: vi.fn(async () => { throw new Error("x"); }) });
			const delegate = new IssueDelegate(o as never);
			expect(await delegate.listRelatedIssues("o", "r", "q")).toEqual([]);
		});
	});

	describe("getIssueTemplates", () => {
		it("returns templates parsed from the directory and file contents", async () => {
			const calls: Array<{ path: string }> = [];
			const o = mockOctokit({
				repos: {
					getContent: vi.fn(async ({ path }: { path: string }) => {
						calls.push({ path });
						if (path === ".github/ISSUE_TEMPLATE") {
							return {
								data: [
									{ type: "file", name: "bug.md", path: ".github/ISSUE_TEMPLATE/bug.md" },
									{ type: "dir", name: "ignored", path: ".github/ISSUE_TEMPLATE/ignored" },
								],
							};
						}
						return { data: { content: Buffer.from("body").toString("base64") } };
					}),
				},
			});
			const delegate = new IssueDelegate(o as never);
			expect(await delegate.getIssueTemplates("o", "r")).toEqual([{ name: "bug", body: "body" }]);
			expect(calls.map((c) => c.path)).toEqual([".github/ISSUE_TEMPLATE", ".github/ISSUE_TEMPLATE/bug.md"]);
		});

		it("returns empty array when directory listing is not an array", async () => {
			const o = mockOctokit({
				repos: { getContent: vi.fn(async () => ({ data: { content: "x" } })) },
			});
			const delegate = new IssueDelegate(o as never);
			expect(await delegate.getIssueTemplates("o", "r")).toEqual([]);
		});

		it("returns empty array when the directory read errors", async () => {
			const o = mockOctokit({ repos: { getContent: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new IssueDelegate(o as never);
			expect(await delegate.getIssueTemplates("o", "r")).toEqual([]);
		});

		it("skips unreadable template files without failing", async () => {
			let count = 0;
			const o = mockOctokit({
				repos: {
					getContent: vi.fn(async ({ path }: { path: string }) => {
						count += 1;
						if (path === ".github/ISSUE_TEMPLATE") {
							return { data: [{ type: "file", name: "a.md", path: ".github/ISSUE_TEMPLATE/a.md" }] };
						}
						throw new Error("unreadable");
					}),
				},
			});
			const delegate = new IssueDelegate(o as never);
			expect(await delegate.getIssueTemplates("o", "r")).toEqual([]);
			expect(count).toBe(2);
		});
	});

	describe("issue update operations", () => {
		it("updateIssueAssignees calls issues.update with assignees", async () => {
			const o = mockOctokit();
			const delegate = new IssueDelegate(o as never);
			await delegate.updateIssueAssignees("o", "r", 1, ["a"]);
			expect(o.issues.update).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 1, assignees: ["a"] });
		});

		it("closeIssue calls issues.update with state closed", async () => {
			const o = mockOctokit();
			const delegate = new IssueDelegate(o as never);
			await delegate.closeIssue("o", "r", 1);
			expect(o.issues.update).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 1, state: "closed" });
		});

		it("updateIssueBody calls issues.update with body", async () => {
			const o = mockOctokit();
			const delegate = new IssueDelegate(o as never);
			await delegate.updateIssueBody("o", "r", 1, "B");
			expect(o.issues.update).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 1, body: "B" });
		});

		it("updateIssueTitle calls issues.update with title", async () => {
			const o = mockOctokit();
			const delegate = new IssueDelegate(o as never);
			await delegate.updateIssueTitle("o", "r", 1, "T");
			expect(o.issues.update).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 1, title: "T" });
		});
	});

	describe("updateIssue", () => {
		it("sends only provided fields to issues.update", async () => {
			const o = mockOctokit();
			const delegate = new IssueDelegate(o as never);
			await delegate.updateIssue("o", "r", 1, { title: "T", state: "closed", assignees: ["a"], labels: ["bug"] });
			expect(o.issues.update).toHaveBeenCalledWith({
				owner: "o", repo: "r", issue_number: 1, title: "T", state: "closed", assignees: ["a"], labels: ["bug"],
			});
		});

		it("is a no-op when no fields are provided", async () => {
			const o = mockOctokit();
			const delegate = new IssueDelegate(o as never);
			await delegate.updateIssue("o", "r", 1, {});
			expect(o.issues.update).not.toHaveBeenCalled();
		});

		it("sends body when provided as empty string", async () => {
			const o = mockOctokit();
			const delegate = new IssueDelegate(o as never);
			await delegate.updateIssue("o", "r", 1, { body: "" });
			expect(o.issues.update).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 1, body: "" });
		});
	});

	describe("setLabels", () => {
		it("calls issues.setLabels with the given labels", async () => {
			const o = mockOctokit();
			const delegate = new IssueDelegate(o as never);
			await delegate.setLabels("o", "r", 1, ["bug"]);
			expect(o.issues.setLabels).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 1, labels: ["bug"] });
		});

		it("swallows 404 when clearing labels on an unlabeled issue", async () => {
			const o = mockOctokit({
				issues: {
					setLabels: vi.fn(async () => {
						throw Object.assign(new Error("Not Found"), { status: 404 });
					}),
				},
			});
			const delegate = new IssueDelegate(o as never);
			await expect(delegate.setLabels("o", "r", 1, [])).resolves.toBeUndefined();
		});

		it("rethrows non-404 errors from setLabels", async () => {
			const o = mockOctokit({
				issues: {
					setLabels: vi.fn(async () => {
						throw Object.assign(new Error("Boom"), { status: 500 });
					}),
				},
			});
			const delegate = new IssueDelegate(o as never);
			await expect(delegate.setLabels("o", "r", 1, ["bug"])).rejects.toThrow("Boom");
		});

		it("rethrows 404 when labels are non-empty", async () => {
			const o = mockOctokit({
				issues: {
					setLabels: vi.fn(async () => {
						throw Object.assign(new Error("Not Found"), { status: 404 });
					}),
				},
			});
			const delegate = new IssueDelegate(o as never);
			await expect(delegate.setLabels("o", "r", 1, ["bug"])).rejects.toThrow("Not Found");
		});
	});

	describe("fileSelfReport", () => {
		it("creates an issue in the self-monitor target repo and returns the url", async () => {
			const o = mockOctokit({
				issues: {
					create: vi.fn(async () => ({ data: { html_url: "https://github.com/mbrooks/yolomatic/issues/9" } })),
				},
			});
			const delegate = new IssueDelegate(o as never);
			const url = await delegate.fileSelfReport("Self report", "body", ["bug"]);
			expect(url).toBe("https://github.com/mbrooks/yolomatic/issues/9");
			expect(o.issues.create).toHaveBeenCalledWith({
				owner: "mbrooks", repo: "yolomatic", title: "Self report", body: "body", labels: ["bug"],
			});
		});
	});
});