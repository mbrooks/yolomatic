import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleRepoRoutes } from "./repo-routes.js";
import type { AdminRouterDeps } from "../admin-router-shared.js";
import { ok } from "../../../app/result.js";
import { repoKey, type Repository, type RepositoryInput } from "../../../repos/repository.js";
import type { RepositoryStore } from "../../../repos/repository-store.js";

function response() {
	const res = {
		statusCode: 0,
		body: "",
		setHeader: vi.fn(),
		end: vi.fn((data?: string) => {
			res.body = data ?? "";
		}),
	} as unknown as http.ServerResponse & { body: string; statusCode: number };
	return res;
}

function request(url: string, method: string, body?: string): http.IncomingMessage {
	const chunks = body ? [Buffer.from(body)] : [];
	return {
		url,
		method,
		headers: {
			cookie: "yeetomatic_admin_session=valid",
		},
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	} as http.IncomingMessage;
}

describe("handleRepoRoutes", () => {
	const githubService = {
		listLabels: vi.fn() as ReturnType<typeof vi.fn>,
		getIssueTemplates: vi.fn() as ReturnType<typeof vi.fn>,
		listRecentCommits: vi.fn() as ReturnType<typeof vi.fn>,
		listRelatedIssues: vi.fn() as ReturnType<typeof vi.fn>,
		listOpenIssues: vi.fn() as ReturnType<typeof vi.fn>,
		updateIssueAssignees: vi.fn() as ReturnType<typeof vi.fn>,
		closeIssue: vi.fn() as ReturnType<typeof vi.fn>,
		addLabels: vi.fn() as ReturnType<typeof vi.fn>,
		getAuthenticatedUser: vi.fn() as ReturnType<typeof vi.fn>,
		listAccessibleRepositories: vi.fn() as ReturnType<typeof vi.fn>,
		getRepository: vi.fn() as ReturnType<typeof vi.fn>,
		getCollaboratorPermissionLevel: vi.fn() as ReturnType<typeof vi.fn>,
	};

	const settingsStore = {
		get: vi.fn((key: string) => {
			if (key === "github_username") return "yeetomatic-bot";
			return undefined;
		}),
		getString: vi.fn((key: string, fallback?: string) => {
			if (key === "github_event_mode") return "webhook";
			if (key === "default_branch") return "main";
			return fallback ?? "";
		}),
		set: vi.fn(),
	};

	const startIssueSession = {
		execute: vi.fn(async () => ok({ started: true, status: "working", message: "ok" })),
	};

	function makeDeps(overrides?: Partial<AdminRouterDeps>): AdminRouterDeps {
		return {
			sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never,
			githubService: githubService as unknown as AdminRouterDeps["githubService"],
			settingsStore: settingsStore as unknown as AdminRouterDeps["settingsStore"],
			startIssueSession: startIssueSession as unknown as AdminRouterDeps["startIssueSession"],
			repositoryStore: makeRepoStore() as unknown as RepositoryStore,
			...overrides,
		} as AdminRouterDeps;
	}

	function makeRepoStore(initial: Repository[] = []): RepositoryStore {
		const map = new Map<string, Repository>();
		for (const r of initial) map.set(repoKey(r.owner, r.repo), r);
		const upsert = vi.fn(async (input: RepositoryInput) => {
			const id = repoKey(input.owner, input.repo);
			const existing = map.get(id);
			const repo: Repository = {
				id,
				owner: input.owner,
				repo: input.repo,
				fullName: input.fullName !== undefined ? input.fullName : existing?.fullName ?? null,
				visibility: input.visibility !== undefined ? input.visibility : existing?.visibility ?? null,
				githubEventMode: input.githubEventMode !== undefined ? input.githubEventMode : existing?.githubEventMode ?? null,
				defaultBranch: input.defaultBranch !== undefined ? input.defaultBranch : existing?.defaultBranch ?? null,
				createdAt: existing?.createdAt ?? "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			};
			map.set(id, repo);
			return repo;
		});
		const remove = vi.fn(async (owner: string, repo: string) => {
			const id = repoKey(owner, repo);
			if (!map.has(id)) return false;
			map.delete(id);
			return true;
		});
		return {
			list: vi.fn(async () => Array.from(map.values())),
			listSync: vi.fn(() => Array.from(map.values())),
			get: vi.fn(async (owner: string, repo: string) => map.get(repoKey(owner, repo)) ?? null),
			getSync: vi.fn((owner: string, repo: string) => map.get(repoKey(owner, repo)) ?? null),
			upsert,
			upsertSync: vi.fn(() => ({} as Repository)),
			remove,
			removeSync: vi.fn(() => false),
			listForPolling: vi.fn(async () => Array.from(map.values())),
			close: vi.fn(),
		} as unknown as RepositoryStore;
	}

	function managedRepo(owner: string, repo: string, overrides: Partial<Repository> = {}): Repository {
		return {
			id: repoKey(owner, repo),
			owner,
			repo,
			fullName: `${owner}/${repo}`,
			visibility: null,
			githubEventMode: null,
			defaultBranch: null,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			...overrides,
		};
	}

	it("returns false for unrelated paths", async () => {
		const handled = await handleRepoRoutes(
			{ method: "GET", url: "/api/other", headers: {} } as never,
			response(),
			{} as never,
			"/api/other",
		);

		expect(handled).toBe(false);
	});

	it("rejects unauthorized repo issue requests", async () => {
		const res = response();
		const handled = await handleRepoRoutes(
			{ method: "GET", url: "/api/repos/mbrooks/yeetomatic/issues", headers: {} } as never,
			res,
			{
				sessionAuth: { requireAdminJson: (_req: any, r: any) => { r.statusCode = 401; r.end('{"error":"Unauthorized"}'); return false; }, requireAdminText: () => false, isAdminAuthorized: () => false, hasUsers: () => true } as never,
			} as never,
			"/api/repos/mbrooks/yeetomatic/issues",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	describe("GET /api/repos/:owner/:repo/context", () => {
		it("returns repo context", async () => {
			const res = response();
			githubService.listLabels.mockResolvedValue(["bug"]);
			githubService.getIssueTemplates.mockResolvedValue([{ name: "Bug", body: "template" }]);
			githubService.listRecentCommits.mockResolvedValue(["abc"]);
			githubService.listRelatedIssues.mockResolvedValue([{ number: 1, title: "Old", state: "open" }]);

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/context", "GET"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/yeetomatic/context",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.labels).toEqual(["bug"]);
			expect(body.templates).toEqual([{ name: "Bug", body: "template" }]);
		});

		it("returns 500 when githubService is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/context", "GET"),
				res,
				makeDeps({ githubService: undefined }),
				"/api/repos/mbrooks/yeetomatic/context",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
		});

		it("handles service errors", async () => {
			const res = response();
			githubService.listLabels.mockRejectedValue(new Error("API error"));

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/context", "GET"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/yeetomatic/context",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("API error");
		});
	});

	describe("GET /api/repos/:owner/:repo/issues", () => {
		it("returns open issues", async () => {
			const res = response();
			githubService.listOpenIssues.mockResolvedValue([
				{ number: 1, title: "Bug", body: "desc", state: "open", labels: ["bug"], assignees: ["mbrooks"], html_url: "https://github.com/mbrooks/yeetomatic/issues/1" },
			]);

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues", "GET"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/yeetomatic/issues",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.issues).toHaveLength(1);
		});

		it("returns 500 when githubService is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues", "GET"),
				res,
				makeDeps({ githubService: undefined }),
				"/api/repos/mbrooks/yeetomatic/issues",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
		});

		it("handles service errors", async () => {
			const res = response();
			githubService.listOpenIssues.mockRejectedValue(new Error("API error"));

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues", "GET"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/yeetomatic/issues",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("API error");
		});
	});

	describe("repo settings routes", () => {
		it("returns effective repo settings", async () => {
			const res = response();
			const repoStore = makeRepoStore([
				managedRepo("mbrooks", "yeetomatic", { githubEventMode: "polling", defaultBranch: "master" }),
			]);

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/settings", "GET"),
				res,
				makeDeps({ repositoryStore: repoStore }),
				"/api/repos/mbrooks/yeetomatic/settings",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.settings).toEqual([
				expect.objectContaining({ key: "github_event_mode", value: "polling", override: "polling" }),
				expect.objectContaining({ key: "default_branch", value: "master", override: "master" }),
			]);
		});

		it("returns inherited settings when no overrides are set", async () => {
			const res = response();
			const repoStore = makeRepoStore([managedRepo("mbrooks", "yeetomatic")]);

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/settings", "GET"),
				res,
				makeDeps({ repositoryStore: repoStore }),
				"/api/repos/mbrooks/yeetomatic/settings",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.settings).toEqual([
				expect.objectContaining({ key: "github_event_mode", value: "webhook", override: null, inherited: true }),
				expect.objectContaining({ key: "default_branch", value: "main", override: null, inherited: true }),
			]);
		});

		it("updates repo settings overrides", async () => {
			const res = response();
			const repoStore = makeRepoStore([managedRepo("mbrooks", "yeetomatic")]);

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/settings", "PATCH", JSON.stringify({ github_event_mode: "polling", default_branch: "master" })),
				res,
				makeDeps({ repositoryStore: repoStore }),
				"/api/repos/mbrooks/yeetomatic/settings",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			expect(repoStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
				owner: "mbrooks",
				repo: "yeetomatic",
				githubEventMode: "polling",
				defaultBranch: "master",
			}));
		});

		it("rejects invalid github_event_mode overrides", async () => {
			const res = response();
			const repoStore = makeRepoStore();

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/settings", "PATCH", JSON.stringify({ github_event_mode: "bad-mode" })),
				res,
				makeDeps({ repositoryStore: repoStore }),
				"/api/repos/mbrooks/yeetomatic/settings",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("github_event_mode must be webhook, polling, or both");
			expect(repoStore.upsert).not.toHaveBeenCalled();
		});

		it("clears repo-specific overrides when blank values are submitted", async () => {
			const res = response();
			const repoStore = makeRepoStore([
				managedRepo("mbrooks", "yeetomatic", { githubEventMode: "polling", defaultBranch: "master" }),
			]);

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/settings", "PATCH", JSON.stringify({ github_event_mode: "", default_branch: "" })),
				res,
				makeDeps({ repositoryStore: repoStore }),
				"/api/repos/mbrooks/yeetomatic/settings",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			expect(repoStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
				owner: "mbrooks",
				repo: "yeetomatic",
				githubEventMode: null,
				defaultBranch: null,
			}));
		});

		it("creates the repository row when patching settings for an unmanaged repo", async () => {
			const res = response();
			const repoStore = makeRepoStore();

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/settings", "PATCH", JSON.stringify({ github_event_mode: "both" })),
				res,
				makeDeps({ repositoryStore: repoStore }),
				"/api/repos/mbrooks/yeetomatic/settings",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			expect(repoStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
				owner: "mbrooks",
				repo: "yeetomatic",
				githubEventMode: "both",
			}));
		});

		it("returns 500 when repositoryStore is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/settings", "GET"),
				res,
				makeDeps({ repositoryStore: undefined }),
				"/api/repos/mbrooks/yeetomatic/settings",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Repository store not configured");
		});
	});

	describe("DELETE /api/repos/:owner/:repo", () => {
		it("removes the configured repository from the table", async () => {
			const res = response();
			const repoStore = makeRepoStore([
				managedRepo("mbrooks", "yeetomatic"),
				managedRepo("octocat", "hello-world"),
			]);

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic", "DELETE"),
				res,
				makeDeps({ repositoryStore: repoStore }),
				"/api/repos/mbrooks/yeetomatic",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.removed).toBe(true);
			expect(repoStore.remove).toHaveBeenCalledWith("mbrooks", "yeetomatic");
			expect(await repoStore.list()).toEqual([expect.objectContaining({ owner: "octocat", repo: "hello-world" })]);
		});

		it("matches owner and repo case-insensitively", async () => {
			const res = response();
			const repoStore = makeRepoStore([managedRepo("Mbrooks", "Yeetomatic")]);

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic", "DELETE"),
				res,
				makeDeps({ repositoryStore: repoStore }),
				"/api/repos/mbrooks/yeetomatic",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.removed).toBe(true);
			expect(repoStore.remove).toHaveBeenCalledWith("mbrooks", "yeetomatic");
		});

		it("returns removed:false when the repository is not configured", async () => {
			const res = response();
			const repoStore = makeRepoStore([managedRepo("octocat", "hello-world")]);

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic", "DELETE"),
				res,
				makeDeps({ repositoryStore: repoStore }),
				"/api/repos/mbrooks/yeetomatic",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.removed).toBe(false);
		});

		it("returns 500 when repositoryStore is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic", "DELETE"),
				res,
				makeDeps({ repositoryStore: undefined }),
				"/api/repos/mbrooks/yeetomatic",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Repository store not configured");
		});
	});

	describe("POST /api/repos/:owner/:repo/issues/:number/assign", () => {
		it("returns 500 when githubService is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] })),
				res,
				makeDeps({ githubService: undefined }),
				"/api/repos/mbrooks/yeetomatic/issues/42/assign",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("GitHub service not configured");
		});

		it("returns 500 when settingsStore is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] })),
				res,
				makeDeps({ settingsStore: undefined }),
				"/api/repos/mbrooks/yeetomatic/issues/42/assign",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Settings store not configured");
		});

		it("returns 500 when startIssueSession is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] })),
				res,
				makeDeps({ startIssueSession: undefined }),
				"/api/repos/mbrooks/yeetomatic/issues/42/assign",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Session executor not configured");
		});

		it("returns false for invalid issue number (route does not match)", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/abc/assign", "POST"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/yeetomatic/issues/abc/assign",
			);

			expect(handled).toBe(false);
		});

		it("returns 500 when github_username is not set", async () => {
			const res = response();
			const noUserStore = {
				get: vi.fn(() => undefined),
			};
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] })),
				res,
				makeDeps({ settingsStore: noUserStore as unknown as AdminRouterDeps["settingsStore"] }),
				"/api/repos/mbrooks/yeetomatic/issues/42/assign",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Yeetomatic GitHub username not configured");
		});

		it("returns 400 when title is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/assign", "POST", JSON.stringify({ body: "desc", labels: [] })),
				res,
				makeDeps(),
				"/api/repos/mbrooks/yeetomatic/issues/42/assign",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Missing required field: title");
		});

		it("assigns issue, starts session in background, and returns 202", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] })),
				res,
				makeDeps(),
				"/api/repos/mbrooks/yeetomatic/issues/42/assign",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(202);
			const body = JSON.parse(String(res.body));
			expect(body.started).toBe(true);
			expect(body.status).toBe("queued");
			expect(githubService.updateIssueAssignees).toHaveBeenCalledWith("mbrooks", "yeetomatic", 42, ["yeetomatic-bot"]);
			expect(startIssueSession.execute).toHaveBeenCalledWith("mbrooks", "yeetomatic", 42, "Bug", "desc", ["bug"]);
		});

		it("returns 202 even when background session reports a conflict", async () => {
			const res = response();
			const conflictSession = {
				execute: vi.fn(async () => ({
					success: false,
					code: "conflict",
					message: "Session is already being executed",
				})),
			};
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: [] })),
				res,
				makeDeps({ startIssueSession: conflictSession as unknown as AdminRouterDeps["startIssueSession"] }),
				"/api/repos/mbrooks/yeetomatic/issues/42/assign",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(202);
			const body = JSON.parse(String(res.body));
			expect(body.status).toBe("queued");
		});

		it("handles service errors from assignment", async () => {
			const res = response();
			githubService.updateIssueAssignees.mockRejectedValue(new Error("API error"));

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: [] })),
				res,
				makeDeps(),
				"/api/repos/mbrooks/yeetomatic/issues/42/assign",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("API error");
		});

		it("returns 202 even when background session throws", async () => {
			const res = response();
			githubService.updateIssueAssignees.mockResolvedValue(undefined);
			const failingSession = {
				execute: vi.fn(async () => {
					throw new Error("Execution failed");
				}),
			};
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: [] })),
				res,
				makeDeps({ startIssueSession: failingSession as unknown as AdminRouterDeps["startIssueSession"] }),
				"/api/repos/mbrooks/yeetomatic/issues/42/assign",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(202);
			const body = JSON.parse(String(res.body));
			expect(body.status).toBe("queued");
		});
	});

	describe("POST /api/repos/:owner/:repo/issues/:number/start-session", () => {
		it("returns 500 when githubService is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/start-session", "POST"),
				res,
				{
					sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never,
				} as never,
				"/api/repos/mbrooks/yeetomatic/issues/42/start-session",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("GitHub service not configured");
		});

		it("returns 500 when settingsStore is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/start-session", "POST"),
				res,
				{
					sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never,
					githubService: {
						updateIssueAssignees: vi.fn(),
						getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
						listAccessibleRepositories: vi.fn(async () => []),
					},
				} as never,
				"/api/repos/mbrooks/yeetomatic/issues/42/start-session",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Settings store not configured");
		});

		it("returns 500 when startIssueSession is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/start-session", "POST"),
				res,
				{
					sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never,
					githubService: {
						updateIssueAssignees: vi.fn(),
						getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
						listAccessibleRepositories: vi.fn(async () => []),
					},
					settingsStore: {
						get: vi.fn(() => undefined),
					},
				} as never,
				"/api/repos/mbrooks/yeetomatic/issues/42/start-session",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Session executor not configured");
		});

		it("returns 500 when github_username is not set", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/start-session", "POST"),
				res,
				{
					sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never,
					githubService: {
						updateIssueAssignees: vi.fn(),
						getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
						listAccessibleRepositories: vi.fn(async () => []),
					},
					settingsStore: {
						get: vi.fn(() => undefined),
					},
					startIssueSession: {
						execute: vi.fn(),
					},
				} as never,
				"/api/repos/mbrooks/yeetomatic/issues/42/start-session",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Yeetomatic GitHub username not configured");
		});

		it("returns 400 when title is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request(
					"/api/repos/mbrooks/yeetomatic/issues/42/start-session",
					"POST",
					JSON.stringify({ body: "test", labels: [] }),
				),
				res,
				{
					sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never,
					githubService: {
						updateIssueAssignees: vi.fn(),
						getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
						listAccessibleRepositories: vi.fn(async () => []),
					},
					settingsStore: {
						get: vi.fn((key: string) => (key === "github_username" ? "yeetomatic-bot" : undefined)),
					},
					startIssueSession: {
						execute: vi.fn(async () => ok({ started: true, status: "working", message: "ok" })),
					},
				} as never,
				"/api/repos/mbrooks/yeetomatic/issues/42/start-session",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Missing required field: title");
		});

		it("starts session and returns result", async () => {
			const res = response();
			const startIssueSession = {
				execute: vi.fn(async () => ok({ started: true, status: "working", message: "ok" })),
			};
			const handled = await handleRepoRoutes(
				request(
					"/api/repos/mbrooks/yeetomatic/issues/42/start-session",
					"POST",
					JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] }),
				),
				res,
				{
					sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never,
					githubService: {
						updateIssueAssignees: vi.fn(),
						getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
						listAccessibleRepositories: vi.fn(async () => []),
					},
					settingsStore: {
						get: vi.fn((key: string) => (key === "github_username" ? "yeetomatic-bot" : undefined)),
					},
					startIssueSession,
				} as never,
				"/api/repos/mbrooks/yeetomatic/issues/42/start-session",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.started).toBe(true);
			expect(startIssueSession.execute).toHaveBeenCalledWith(
				"mbrooks",
				"yeetomatic",
				42,
				"Bug",
				"desc",
				["bug"],
			);
		});

		it("returns 409 when session is already executing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request(
					"/api/repos/mbrooks/yeetomatic/issues/42/start-session",
					"POST",
					JSON.stringify({ title: "Bug", body: "desc", labels: [] }),
				),
				res,
				{
					sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never,
					githubService: {
						updateIssueAssignees: vi.fn(),
						getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
						listAccessibleRepositories: vi.fn(async () => []),
					},
					settingsStore: {
						get: vi.fn((key: string) => (key === "github_username" ? "yeetomatic-bot" : undefined)),
					},
					startIssueSession: {
						execute: vi.fn(async () => ({
							success: false,
							code: "conflict",
							message: "Session is already being executed",
						})),
					},
				} as never,
				"/api/repos/mbrooks/yeetomatic/issues/42/start-session",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(409);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Session is already being executed");
		});

		it("handles service errors", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request(
					"/api/repos/mbrooks/yeetomatic/issues/42/start-session",
					"POST",
					JSON.stringify({ title: "Bug", body: "desc", labels: [] }),
				),
				res,
				{
					sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never,
					githubService: {
						updateIssueAssignees: vi.fn(),
						getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
						listAccessibleRepositories: vi.fn(async () => []),
					},
					settingsStore: {
						get: vi.fn((key: string) => (key === "github_username" ? "yeetomatic-bot" : undefined)),
					},
					startIssueSession: {
						execute: vi.fn(async () => {
							throw new Error("Execution failed");
						}),
					},
				} as never,
				"/api/repos/mbrooks/yeetomatic/issues/42/start-session",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Execution failed");
		});
	});

	describe("POST /api/repos", () => {
		it("adds a new repository manually", async () => {
			const res = response();
			const repoStore = makeRepoStore();
			githubService.getRepository.mockResolvedValue({
				owner: "octocat",
				repo: "hello-world",
				fullName: "octocat/hello-world",
				visibility: "public",
			});

			const handled = await handleRepoRoutes(
				request("/api/repos", "POST", JSON.stringify({ owner: "octocat", repo: "hello-world" })),
				res,
				makeDeps({ repositoryStore: repoStore }),
				"/api/repos",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.added).toBe(true);
			expect(body.fullName).toBe("octocat/hello-world");
			expect(repoStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
				owner: "octocat",
				repo: "hello-world",
				fullName: "octocat/hello-world",
				visibility: "public",
			}));
		});

		it("allows adding a public repository manually", async () => {
			const res = response();
			const repoStore = makeRepoStore();
			githubService.getRepository.mockResolvedValue({
				owner: "octocat",
				repo: "hello-world",
				fullName: "octocat/hello-world",
				visibility: "public",
			});

			const handled = await handleRepoRoutes(
				request("/api/repos", "POST", JSON.stringify({ owner: "octocat", repo: "hello-world" })),
				res,
				makeDeps({ repositoryStore: repoStore }),
				"/api/repos",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.added).toBe(true);
		});

		it("returns added:false when repository is already configured", async () => {
			const res = response();
			const repoStore = makeRepoStore([managedRepo("octocat", "hello-world")]);
			githubService.getRepository.mockResolvedValue({
				owner: "octocat",
				repo: "hello-world",
				fullName: "octocat/hello-world",
				visibility: "public",
			});

			const handled = await handleRepoRoutes(
				request("/api/repos", "POST", JSON.stringify({ owner: "octocat", repo: "hello-world" })),
				res,
				makeDeps({ repositoryStore: repoStore }),
				"/api/repos",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.added).toBe(false);
			expect(body.message).toBe("Repository already configured");
			expect(repoStore.upsert).not.toHaveBeenCalled();
		});

		it("returns 404 when repository is not found or not accessible", async () => {
			const res = response();
			githubService.getRepository.mockResolvedValue(null);

			const handled = await handleRepoRoutes(
				request("/api/repos", "POST", JSON.stringify({ owner: "unknown", repo: "missing" })),
				res,
				makeDeps(),
				"/api/repos",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(404);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Repository not found or not accessible");
		});

		it("returns 400 when owner or repo is missing", async () => {
			const res = response();

			const handled = await handleRepoRoutes(
				request("/api/repos", "POST", JSON.stringify({ owner: "octocat" })),
				res,
				makeDeps(),
				"/api/repos",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Missing required field: repo");
		});

		it("returns 400 when owner or repo is empty after trimming", async () => {
			const res = response();

			const handled = await handleRepoRoutes(
				request("/api/repos", "POST", JSON.stringify({ owner: "  ", repo: "hello-world" })),
				res,
				makeDeps(),
				"/api/repos",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("owner and repo are required");
		});

		it("returns 500 when githubService is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos", "POST", JSON.stringify({ owner: "octocat", repo: "hello-world" })),
				res,
				makeDeps({ githubService: undefined }),
				"/api/repos",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("GitHub service not configured");
		});

		it("returns 500 when repositoryStore is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos", "POST", JSON.stringify({ owner: "octocat", repo: "hello-world" })),
				res,
				makeDeps({ repositoryStore: undefined }),
				"/api/repos",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Repository store not configured");
		});
	});

	describe("GET /api/repos/accessible", () => {
		it("returns accessible repositories and currently configured repos without mutating state", async () => {
			const res = response();
			const repoStore = makeRepoStore([managedRepo("mbrooks", "yeetomatic")]);
			githubService.getAuthenticatedUser.mockResolvedValue({ login: "testuser" });
			githubService.listAccessibleRepositories.mockResolvedValue([
				{ owner: "mbrooks", repo: "yeetomatic", fullName: "mbrooks/yeetomatic", visibility: "private" },
				{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", visibility: "public" },
			]);

			const handled = await handleRepoRoutes(
				request("/api/repos/accessible", "GET"),
				res,
				makeDeps({ repositoryStore: repoStore }),
				"/api/repos/accessible",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.repositories).toHaveLength(2);
			expect(body.repositories[0].fullName).toBe("mbrooks/yeetomatic");
			expect(body.configured).toEqual([{ owner: "mbrooks", repo: "yeetomatic" }]);
			expect(repoStore.upsert).not.toHaveBeenCalled();
		});

		it("returns 500 when githubService is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/accessible", "GET"),
				res,
				makeDeps({ githubService: undefined }),
				"/api/repos/accessible",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("GitHub service not configured");
		});

		it("returns 500 when repositoryStore is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/accessible", "GET"),
				res,
				makeDeps({ repositoryStore: undefined }),
				"/api/repos/accessible",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Repository store not configured");
		});

		it("returns 500 when token is invalid", async () => {
			const res = response();
			githubService.getAuthenticatedUser.mockResolvedValue(null);

			const handled = await handleRepoRoutes(
				request("/api/repos/accessible", "GET"),
				res,
				makeDeps(),
				"/api/repos/accessible",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("GitHub token is invalid or not configured");
		});

		it("returns empty configured list when no repos are managed", async () => {
			const res = response();
			const repoStore = makeRepoStore();
			githubService.getAuthenticatedUser.mockResolvedValue({ login: "testuser" });
			githubService.listAccessibleRepositories.mockResolvedValue([]);

			const handled = await handleRepoRoutes(
				request("/api/repos/accessible", "GET"),
				res,
				makeDeps({ repositoryStore: repoStore }),
				"/api/repos/accessible",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.repositories).toEqual([]);
			expect(body.configured).toEqual([]);
		});
	});

	describe("POST /api/repos/:owner/:repo/issues/:number/close", () => {
		it("closes the issue", async () => {
			const res = response();
			githubService.closeIssue.mockResolvedValue(undefined);

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/close", "POST"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/yeetomatic/issues/42/close",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.closed).toBe(true);
			expect(githubService.closeIssue).toHaveBeenCalledWith("mbrooks", "yeetomatic", 42);
		});

		it("returns 500 when githubService is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/close", "POST"),
				res,
				makeDeps({ githubService: undefined }),
				"/api/repos/mbrooks/yeetomatic/issues/42/close",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("GitHub service not configured");
		});

		it("handles service errors", async () => {
			const res = response();
			githubService.closeIssue.mockRejectedValue(new Error("API error"));

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/close", "POST"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/yeetomatic/issues/42/close",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("API error");
		});
	});

	describe("POST /api/repos/:owner/:repo/issues/:number/mark-do-not-work", () => {
		it("adds wontfix label and closes the issue", async () => {
			const res = response();
			githubService.addLabels.mockResolvedValue(undefined);
			githubService.closeIssue.mockResolvedValue(undefined);

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/mark-do-not-work", "POST"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/yeetomatic/issues/42/mark-do-not-work",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.closed).toBe(true);
			expect(body.labeled).toBe(true);
			expect(githubService.addLabels).toHaveBeenCalledWith("mbrooks", "yeetomatic", 42, ["wontfix"]);
			expect(githubService.closeIssue).toHaveBeenCalledWith("mbrooks", "yeetomatic", 42);
		});

		it("returns 500 when githubService is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/mark-do-not-work", "POST"),
				res,
				makeDeps({ githubService: undefined }),
				"/api/repos/mbrooks/yeetomatic/issues/42/mark-do-not-work",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("GitHub service not configured");
		});

		it("handles service errors", async () => {
			const res = response();
			githubService.addLabels.mockRejectedValue(new Error("Label API error"));

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/yeetomatic/issues/42/mark-do-not-work", "POST"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/yeetomatic/issues/42/mark-do-not-work",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Label API error");
		});
	});
});
