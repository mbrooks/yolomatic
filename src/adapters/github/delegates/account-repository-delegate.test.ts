import { describe, expect, it, vi } from "vitest";
import { AccountRepositoryDelegate } from "./account-repository-delegate.js";

type MockOctokit = Record<string, Record<string, ReturnType<typeof vi.fn>>>;

interface OctokitOverrides {
	users?: Record<string, ReturnType<typeof vi.fn>>;
	repos?: Record<string, ReturnType<typeof vi.fn>>;
}

function mockOctokit(overrides: OctokitOverrides = {}): MockOctokit {
	return {
		users: {
			getAuthenticated: vi.fn(async () => ({ data: { login: "testuser" } })),
			...(overrides.users ?? {}),
		},
		repos: {
			get: vi.fn(async () => ({ data: { default_branch: "main", full_name: "o/r", visibility: "private", owner: { login: "o" }, name: "r" } })),
			listForAuthenticatedUser: vi.fn(async () => ({ data: [] })),
			listInvitationsForAuthenticatedUser: vi.fn(async () => ({ data: [] })),
			acceptInvitationForAuthenticatedUser: vi.fn(async () => ({ data: {} })),
			createOrUpdateFileContents: vi.fn(async () => ({ data: {} })),
			getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: "read" } })),
			checkCollaborator: vi.fn(async () => ({ status: 204 })),
			listCommits: vi.fn(async () => ({ data: [] })),
			...(overrides.repos ?? {}),
		},
		} as unknown as MockOctokit;
}

describe("AccountRepositoryDelegate", () => {
	describe("getAuthenticatedUser", () => {
		it("returns the authenticated user's login", async () => {
			const o = mockOctokit();
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.getAuthenticatedUser()).toEqual({ login: "testuser" });
		});

		it("returns null when the user has no login", async () => {
			const o = mockOctokit({ users: { getAuthenticated: vi.fn(async () => ({ data: { login: "" } })) } });
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.getAuthenticatedUser()).toBeNull();
		});

		it("returns null on error", async () => {
			const o = mockOctokit({ users: { getAuthenticated: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.getAuthenticatedUser()).toBeNull();
		});
	});

	describe("listAccessibleRepositories", () => {
		it("returns mapped repositories with normalized visibility", async () => {
			const o = mockOctokit({
				repos: {
					listForAuthenticatedUser: vi.fn(async () => ({
						data: [
							{ owner: { login: "o" }, name: "r", full_name: "o/r", visibility: "public" },
							{ owner: { login: "o" }, name: "r2", full_name: "o/r2", visibility: "internal" },
						],
					})),
				},
			});
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.listAccessibleRepositories()).toEqual([
				{ owner: "o", repo: "r", fullName: "o/r", visibility: "public" },
				{ owner: "o", repo: "r2", fullName: "o/r2", visibility: "internal" },
			]);
			expect(o.repos.listForAuthenticatedUser).toHaveBeenCalledWith({ per_page: 100, sort: "updated" });
		});

		it("falls back to private flag when visibility is missing", async () => {
			const o = mockOctokit({
				repos: {
					listForAuthenticatedUser: vi.fn(async () => ({
						data: [
							{ owner: { login: "o" }, name: "r", full_name: "o/r", visibility: null, private: true },
							{ owner: { login: "o" }, name: "r2", full_name: "o/r2", visibility: null, private: false },
						],
					})),
				},
			});
			const delegate = new AccountRepositoryDelegate(o as never);
			const repos = await delegate.listAccessibleRepositories();
			expect(repos[0].visibility).toBe("private");
			expect(repos[1].visibility).toBe("public");
		});

		it("returns empty array on error", async () => {
			const o = mockOctokit({ repos: { listForAuthenticatedUser: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.listAccessibleRepositories()).toEqual([]);
		});
	});

	describe("getRepository", () => {
		it("returns repository info with normalized visibility", async () => {
			const o = mockOctokit();
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.getRepository("o", "r")).toEqual({
				owner: "o", repo: "r", fullName: "o/r", visibility: "private",
			});
		});

		it("falls back to private flag when visibility is missing", async () => {
			const o = mockOctokit({
				repos: { get: vi.fn(async () => ({ data: { owner: { login: "o" }, name: "r", full_name: "o/r", visibility: null, private: false } })) },
			});
			const delegate = new AccountRepositoryDelegate(o as never);
			expect((await delegate.getRepository("o", "r"))?.visibility).toBe("public");
		});

		it("returns null when repo is not accessible", async () => {
			const o = mockOctokit({ repos: { get: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.getRepository("o", "r")).toBeNull();
		});
	});

	describe("getCollaboratorPermissionLevel", () => {
		it("returns the permission level when it is a known value", async () => {
			const o = mockOctokit({ repos: { getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: "admin" } })) } });
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.getCollaboratorPermissionLevel("o", "r", "u")).toBe("admin");
			expect(o.repos.getCollaboratorPermissionLevel).toHaveBeenCalledWith({ owner: "o", repo: "r", username: "u" });
		});

		it("returns null when the permission value is unrecognized", async () => {
			const o = mockOctokit({ repos: { getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: "weird" } })) } });
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.getCollaboratorPermissionLevel("o", "r", "u")).toBeNull();
		});

		it("returns null when permission is missing", async () => {
			const o = mockOctokit({ repos: { getCollaboratorPermissionLevel: vi.fn(async () => ({ data: {} })) } });
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.getCollaboratorPermissionLevel("o", "r", "u")).toBeNull();
		});

		it("returns null on error", async () => {
			const o = mockOctokit({ repos: { getCollaboratorPermissionLevel: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.getCollaboratorPermissionLevel("o", "r", "u")).toBeNull();
		});
	});

	describe("isCollaborator", () => {
		it("returns true when checkCollaborator responds with 204", async () => {
			const o = mockOctokit();
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.isCollaborator("o", "r", "u")).toBe(true);
			expect(o.repos.checkCollaborator).toHaveBeenCalledWith({ owner: "o", repo: "r", username: "u" });
		});

		it("returns false when checkCollaborator responds with a non-204 status", async () => {
			const o = mockOctokit({ repos: { checkCollaborator: vi.fn(async () => ({ status: 404 })) } });
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.isCollaborator("o", "r", "u")).toBe(false);
		});

		it("returns false when checkCollaborator throws", async () => {
			const o = mockOctokit({ repos: { checkCollaborator: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.isCollaborator("o", "r", "u")).toBe(false);
		});
	});

	describe("initializeEmptyRepo", () => {
		it("fetches repo default branch and creates README via contents API", async () => {
			const o = mockOctokit();
			const delegate = new AccountRepositoryDelegate(o as never);
			await delegate.initializeEmptyRepo("o", "r", "fallback");
			expect(o.repos.get).toHaveBeenCalledWith({ owner: "o", repo: "r" });
			expect(o.repos.createOrUpdateFileContents).toHaveBeenCalledWith(expect.objectContaining({
				owner: "o", repo: "r", path: "README.md", message: "Initial commit", branch: "main",
			}));
			const call = (o.repos.createOrUpdateFileContents as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string };
			expect(Buffer.from(call.content, "base64").toString("utf8")).toBe("# r\n\nAuto-initialized by Yolomatic.\n");
		});

		it("falls back to provided default branch when repo has no default_branch", async () => {
			const o = mockOctokit({ repos: { get: vi.fn(async () => ({ data: { full_name: "o/r", visibility: "private" } })) } });
			const delegate = new AccountRepositoryDelegate(o as never);
			await delegate.initializeEmptyRepo("o", "r", "fallback");
			expect(o.repos.createOrUpdateFileContents).toHaveBeenCalledWith(expect.objectContaining({ branch: "fallback" }));
		});
	});

	describe("listRecentCommits", () => {
		it("returns formatted commits", async () => {
			const o = mockOctokit({
				repos: {
					listCommits: vi.fn(async () => ({
						data: [
							{ sha: "abcdef12345", commit: { message: "feat: thing\n\nbody" } },
							{ sha: "1111122222", commit: { message: "fix: other" } },
						],
					})),
				},
			});
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.listRecentCommits("o", "r")).toEqual(["abcdef1: feat: thing", "1111122: fix: other"]);
			expect(o.repos.listCommits).toHaveBeenCalledWith({ owner: "o", repo: "r", per_page: 10 });
		});

		it("honors a custom limit", async () => {
			const o = mockOctokit();
			const delegate = new AccountRepositoryDelegate(o as never);
			await delegate.listRecentCommits("o", "r", 25);
			expect(o.repos.listCommits).toHaveBeenCalledWith({ owner: "o", repo: "r", per_page: 25 });
		});

		it("returns empty array on error", async () => {
			const o = mockOctokit({ repos: { listCommits: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.listRecentCommits("o", "r")).toEqual([]);
		});
	});

	describe("listPendingInvitations", () => {
		it("returns mapped invitations", async () => {
			const o = mockOctokit({
				repos: {
					listInvitationsForAuthenticatedUser: vi.fn(async () => ({
						data: [
							{
								id: 1,
								repository: { full_name: "o/r", name: "r", owner: { login: "o" } },
								inviter: { login: "inv" },
								permissions: "write",
								created_at: "c",
								html_url: "u",
							},
						],
					})),
				},
			});
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.listPendingInvitations()).toEqual([
				{
					id: 1,
					repository: { full_name: "o/r", name: "r", owner: { login: "o" } },
					inviter: { login: "inv" },
					permissions: "write",
					created_at: "c",
					html_url: "u",
				},
			]);
		});

		it("handles sparse invitation data with fallbacks", async () => {
			const o = mockOctokit({
				repos: {
					listInvitationsForAuthenticatedUser: vi.fn(async () => ({
						data: [{ id: 2, repository: {} }],
					})),
				},
			});
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.listPendingInvitations()).toEqual([
				{
					id: 2,
					repository: { full_name: "", name: "", owner: { login: "" } },
					inviter: null,
					permissions: "read",
					created_at: undefined,
					html_url: "",
				},
			]);
		});

		it("returns empty array on error", async () => {
			const o = mockOctokit({ repos: { listInvitationsForAuthenticatedUser: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new AccountRepositoryDelegate(o as never);
			expect(await delegate.listPendingInvitations()).toEqual([]);
		});
	});

	describe("acceptInvitation", () => {
		it("calls acceptInvitationForAuthenticatedUser", async () => {
			const o = mockOctokit();
			const delegate = new AccountRepositoryDelegate(o as never);
			await delegate.acceptInvitation(123);
			expect(o.repos.acceptInvitationForAuthenticatedUser).toHaveBeenCalledWith({ invitation_id: 123 });
		});

		it("rethrows errors", async () => {
			const o = mockOctokit({ repos: { acceptInvitationForAuthenticatedUser: vi.fn(async () => { throw new Error("x"); }) } });
			const delegate = new AccountRepositoryDelegate(o as never);
			await expect(delegate.acceptInvitation(123)).rejects.toThrow("x");
		});
	});
});