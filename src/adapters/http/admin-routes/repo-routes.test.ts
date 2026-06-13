import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleRepoRoutes } from "./repo-routes.js";
import type { AdminRouterDeps } from "../admin-router-shared.js";
import { ok } from "../../../app/result.js";

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
			authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
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
	};

	const settingsStore = {
		get: vi.fn((key: string) => (key === "github_username" ? "tars-bot" : undefined)),
		set: vi.fn(),
	};

	const startIssueSession = {
		execute: vi.fn(async () => ok({ started: true, status: "working", message: "ok" })),
	};

	function makeDeps(overrides?: Partial<AdminRouterDeps>): AdminRouterDeps {
		return {
			adminUsername: "admin",
			adminPassword: "secret",
			githubService: githubService as unknown as AdminRouterDeps["githubService"],
			settingsStore: settingsStore as unknown as AdminRouterDeps["settingsStore"],
			startIssueSession: startIssueSession as unknown as AdminRouterDeps["startIssueSession"],
			...overrides,
		} as AdminRouterDeps;
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
			{ method: "GET", url: "/api/repos/mbrooks/tars/issues", headers: {} } as never,
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/repos/mbrooks/tars/issues",
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
				request("/api/repos/mbrooks/tars/context", "GET"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/tars/context",
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
				request("/api/repos/mbrooks/tars/context", "GET"),
				res,
				makeDeps({ githubService: undefined }),
				"/api/repos/mbrooks/tars/context",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
		});

		it("handles service errors", async () => {
			const res = response();
			githubService.listLabels.mockRejectedValue(new Error("API error"));

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/context", "GET"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/tars/context",
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
				{ number: 1, title: "Bug", body: "desc", state: "open", labels: ["bug"], assignees: ["mbrooks"], html_url: "https://github.com/mbrooks/tars/issues/1" },
			]);

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues", "GET"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/tars/issues",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.issues).toHaveLength(1);
		});

		it("returns 500 when githubService is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues", "GET"),
				res,
				makeDeps({ githubService: undefined }),
				"/api/repos/mbrooks/tars/issues",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
		});

		it("handles service errors", async () => {
			const res = response();
			githubService.listOpenIssues.mockRejectedValue(new Error("API error"));

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues", "GET"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/tars/issues",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("API error");
		});
	});

	describe("POST /api/repos/:owner/:repo/issues/:number/assign", () => {
		it("returns 500 when githubService is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] })),
				res,
				makeDeps({ githubService: undefined }),
				"/api/repos/mbrooks/tars/issues/42/assign",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("GitHub service not configured");
		});

		it("returns 500 when settingsStore is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] })),
				res,
				makeDeps({ settingsStore: undefined }),
				"/api/repos/mbrooks/tars/issues/42/assign",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Settings store not configured");
		});

		it("returns 500 when startIssueSession is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] })),
				res,
				makeDeps({ startIssueSession: undefined }),
				"/api/repos/mbrooks/tars/issues/42/assign",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Session executor not configured");
		});

		it("returns false for invalid issue number (route does not match)", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues/abc/assign", "POST"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/tars/issues/abc/assign",
			);

			expect(handled).toBe(false);
		});

		it("returns 500 when github_username is not set", async () => {
			const res = response();
			const noUserStore = {
				get: vi.fn(() => undefined),
			};
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] })),
				res,
				makeDeps({ settingsStore: noUserStore as unknown as AdminRouterDeps["settingsStore"] }),
				"/api/repos/mbrooks/tars/issues/42/assign",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("TARS GitHub username not configured");
		});

		it("returns 400 when title is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues/42/assign", "POST", JSON.stringify({ body: "desc", labels: [] })),
				res,
				makeDeps(),
				"/api/repos/mbrooks/tars/issues/42/assign",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Missing required field: title");
		});

		it("assigns issue, starts session in background, and returns 202", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] })),
				res,
				makeDeps(),
				"/api/repos/mbrooks/tars/issues/42/assign",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(202);
			const body = JSON.parse(String(res.body));
			expect(body.started).toBe(true);
			expect(body.status).toBe("queued");
			expect(githubService.updateIssueAssignees).toHaveBeenCalledWith("mbrooks", "tars", 42, ["tars-bot"]);
			expect(startIssueSession.execute).toHaveBeenCalledWith("mbrooks", "tars", 42, "Bug", "desc", ["bug"]);
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
				request("/api/repos/mbrooks/tars/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: [] })),
				res,
				makeDeps({ startIssueSession: conflictSession as unknown as AdminRouterDeps["startIssueSession"] }),
				"/api/repos/mbrooks/tars/issues/42/assign",
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
				request("/api/repos/mbrooks/tars/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: [] })),
				res,
				makeDeps(),
				"/api/repos/mbrooks/tars/issues/42/assign",
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
				request("/api/repos/mbrooks/tars/issues/42/assign", "POST", JSON.stringify({ title: "Bug", body: "desc", labels: [] })),
				res,
				makeDeps({ startIssueSession: failingSession as unknown as AdminRouterDeps["startIssueSession"] }),
				"/api/repos/mbrooks/tars/issues/42/assign",
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
				request("/api/repos/mbrooks/tars/issues/42/start-session", "POST"),
				res,
				{
					adminUsername: "admin",
					adminPassword: "secret",
				} as never,
				"/api/repos/mbrooks/tars/issues/42/start-session",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("GitHub service not configured");
		});

		it("returns 500 when settingsStore is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues/42/start-session", "POST"),
				res,
				{
					adminUsername: "admin",
					adminPassword: "secret",
					githubService: {
						updateIssueAssignees: vi.fn(),
						getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
						listAccessibleRepositories: vi.fn(async () => []),
					},
				} as never,
				"/api/repos/mbrooks/tars/issues/42/start-session",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Settings store not configured");
		});

		it("returns 500 when startIssueSession is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues/42/start-session", "POST"),
				res,
				{
					adminUsername: "admin",
					adminPassword: "secret",
					githubService: {
						updateIssueAssignees: vi.fn(),
						getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
						listAccessibleRepositories: vi.fn(async () => []),
					},
					settingsStore: {
						get: vi.fn(() => undefined),
					},
				} as never,
				"/api/repos/mbrooks/tars/issues/42/start-session",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Session executor not configured");
		});

		it("returns 500 when github_username is not set", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues/42/start-session", "POST"),
				res,
				{
					adminUsername: "admin",
					adminPassword: "secret",
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
				"/api/repos/mbrooks/tars/issues/42/start-session",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("TARS GitHub username not configured");
		});

		it("returns 400 when title is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request(
					"/api/repos/mbrooks/tars/issues/42/start-session",
					"POST",
					JSON.stringify({ body: "test", labels: [] }),
				),
				res,
				{
					adminUsername: "admin",
					adminPassword: "secret",
					githubService: {
						updateIssueAssignees: vi.fn(),
						getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
						listAccessibleRepositories: vi.fn(async () => []),
					},
					settingsStore: {
						get: vi.fn((key: string) => (key === "github_username" ? "tars-bot" : undefined)),
					},
					startIssueSession: {
						execute: vi.fn(async () => ok({ started: true, status: "working", message: "ok" })),
					},
				} as never,
				"/api/repos/mbrooks/tars/issues/42/start-session",
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
					"/api/repos/mbrooks/tars/issues/42/start-session",
					"POST",
					JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] }),
				),
				res,
				{
					adminUsername: "admin",
					adminPassword: "secret",
					githubService: {
						updateIssueAssignees: vi.fn(),
						getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
						listAccessibleRepositories: vi.fn(async () => []),
					},
					settingsStore: {
						get: vi.fn((key: string) => (key === "github_username" ? "tars-bot" : undefined)),
					},
					startIssueSession,
				} as never,
				"/api/repos/mbrooks/tars/issues/42/start-session",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.started).toBe(true);
			expect(startIssueSession.execute).toHaveBeenCalledWith(
				"mbrooks",
				"tars",
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
					"/api/repos/mbrooks/tars/issues/42/start-session",
					"POST",
					JSON.stringify({ title: "Bug", body: "desc", labels: [] }),
				),
				res,
				{
					adminUsername: "admin",
					adminPassword: "secret",
					githubService: {
						updateIssueAssignees: vi.fn(),
						getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
						listAccessibleRepositories: vi.fn(async () => []),
					},
					settingsStore: {
						get: vi.fn((key: string) => (key === "github_username" ? "tars-bot" : undefined)),
					},
					startIssueSession: {
						execute: vi.fn(async () => ({
							success: false,
							code: "conflict",
							message: "Session is already being executed",
						})),
					},
				} as never,
				"/api/repos/mbrooks/tars/issues/42/start-session",
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
					"/api/repos/mbrooks/tars/issues/42/start-session",
					"POST",
					JSON.stringify({ title: "Bug", body: "desc", labels: [] }),
				),
				res,
				{
					adminUsername: "admin",
					adminPassword: "secret",
					githubService: {
						updateIssueAssignees: vi.fn(),
						getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
						listAccessibleRepositories: vi.fn(async () => []),
					},
					settingsStore: {
						get: vi.fn((key: string) => (key === "github_username" ? "tars-bot" : undefined)),
					},
					startIssueSession: {
						execute: vi.fn(async () => {
							throw new Error("Execution failed");
						}),
					},
				} as never,
				"/api/repos/mbrooks/tars/issues/42/start-session",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Execution failed");
		});
	});

	describe("POST /api/repos/scan", () => {
		it("returns discovered repos and merges into configured_repositories", async () => {
			const res = response();
			const store = {
				get: vi.fn((key: string) => {
					if (key === "configured_repositories") {
						return JSON.stringify([{ owner: "mbrooks", repo: "tars" }]);
					}
					return undefined;
				}),
				set: vi.fn(),
			};
			githubService.getAuthenticatedUser.mockResolvedValue({ login: "testuser" });
			githubService.listAccessibleRepositories.mockResolvedValue([
				{ owner: "mbrooks", repo: "tars", fullName: "mbrooks/tars" },
				{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
			]);

			const handled = await handleRepoRoutes(
				request("/api/repos/scan", "POST"),
				res,
				makeDeps({ settingsStore: store as unknown as AdminRouterDeps["settingsStore"] }),
				"/api/repos/scan",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.repos).toHaveLength(2);
			expect(body.added).toBe(1);
			expect(store.set).toHaveBeenCalledWith(
				"configured_repositories",
				JSON.stringify([
					{ owner: "mbrooks", repo: "tars" },
					{ owner: "octocat", repo: "hello-world" },
				]),
			);
		});

		it("returns 500 when githubService is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/scan", "POST"),
				res,
				makeDeps({ githubService: undefined }),
				"/api/repos/scan",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("GitHub service not configured");
		});

		it("returns 500 when settingsStore is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/scan", "POST"),
				res,
				makeDeps({ settingsStore: undefined }),
				"/api/repos/scan",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Settings store not configured");
		});

		it("returns 500 when token is invalid", async () => {
			const res = response();
			githubService.getAuthenticatedUser.mockResolvedValue(null);

			const handled = await handleRepoRoutes(
				request("/api/repos/scan", "POST"),
				res,
				makeDeps(),
				"/api/repos/scan",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("GitHub token is invalid or not configured");
		});

		it("handles service errors from listAccessibleRepositories", async () => {
			const res = response();
			githubService.getAuthenticatedUser.mockResolvedValue({ login: "testuser" });
			githubService.listAccessibleRepositories.mockRejectedValue(new Error("API rate limit exceeded"));

			const handled = await handleRepoRoutes(
				request("/api/repos/scan", "POST"),
				res,
				makeDeps(),
				"/api/repos/scan",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("API rate limit exceeded");
		});

		it("handles empty configured_repositories", async () => {
			const res = response();
			const store = {
				get: vi.fn(() => undefined),
				set: vi.fn(),
			};
			githubService.getAuthenticatedUser.mockResolvedValue({ login: "testuser" });
			githubService.listAccessibleRepositories.mockResolvedValue([
				{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
			]);

			const handled = await handleRepoRoutes(
				request("/api/repos/scan", "POST"),
				res,
				makeDeps({ settingsStore: store as unknown as AdminRouterDeps["settingsStore"] }),
				"/api/repos/scan",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.added).toBe(1);
		});

		it("handles invalid JSON in configured_repositories", async () => {
			const res = response();
			const store = {
				get: vi.fn(() => "not-json"),
				set: vi.fn(),
			};
			githubService.getAuthenticatedUser.mockResolvedValue({ login: "testuser" });
			githubService.listAccessibleRepositories.mockResolvedValue([]);

			const handled = await handleRepoRoutes(
				request("/api/repos/scan", "POST"),
				res,
				makeDeps({ settingsStore: store as unknown as AdminRouterDeps["settingsStore"] }),
				"/api/repos/scan",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.added).toBe(0);
		});

		it("filters malformed entries from configured_repositories", async () => {
			const res = response();
			const store = {
				get: vi.fn(() =>
					JSON.stringify([
						{ owner: "", repo: "x" },
						{ owner: "y", repo: "" },
						"bad",
						{ owner: "valid", repo: "repo" },
						{ owner: "valid", repo: "repo" },
					])),
				set: vi.fn(),
			};
			githubService.getAuthenticatedUser.mockResolvedValue({ login: "testuser" });
			githubService.listAccessibleRepositories.mockResolvedValue([]);

			const handled = await handleRepoRoutes(
				request("/api/repos/scan", "POST"),
				res,
				makeDeps({ settingsStore: store as unknown as AdminRouterDeps["settingsStore"] }),
				"/api/repos/scan",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.added).toBe(0);
			expect(store.set).toHaveBeenCalledWith(
				"configured_repositories",
				JSON.stringify([{ owner: "valid", repo: "repo" }]),
			);
		});
	});

	describe("POST /api/repos/:owner/:repo/issues/:number/close", () => {
		it("closes the issue", async () => {
			const res = response();
			githubService.closeIssue.mockResolvedValue(undefined);

			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues/42/close", "POST"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/tars/issues/42/close",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.closed).toBe(true);
			expect(githubService.closeIssue).toHaveBeenCalledWith("mbrooks", "tars", 42);
		});

		it("returns 500 when githubService is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues/42/close", "POST"),
				res,
				makeDeps({ githubService: undefined }),
				"/api/repos/mbrooks/tars/issues/42/close",
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
				request("/api/repos/mbrooks/tars/issues/42/close", "POST"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/tars/issues/42/close",
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
				request("/api/repos/mbrooks/tars/issues/42/mark-do-not-work", "POST"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/tars/issues/42/mark-do-not-work",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.closed).toBe(true);
			expect(body.labeled).toBe(true);
			expect(githubService.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 42, ["wontfix"]);
			expect(githubService.closeIssue).toHaveBeenCalledWith("mbrooks", "tars", 42);
		});

		it("returns 500 when githubService is missing", async () => {
			const res = response();
			const handled = await handleRepoRoutes(
				request("/api/repos/mbrooks/tars/issues/42/mark-do-not-work", "POST"),
				res,
				makeDeps({ githubService: undefined }),
				"/api/repos/mbrooks/tars/issues/42/mark-do-not-work",
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
				request("/api/repos/mbrooks/tars/issues/42/mark-do-not-work", "POST"),
				res,
				makeDeps(),
				"/api/repos/mbrooks/tars/issues/42/mark-do-not-work",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBe("Label API error");
		});
	});
});
