import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { unlinkSync } from "node:fs";
import http from "node:http";
import { handleAdminRoute } from "./admin-router.js";
import { SettingsStore } from "../../settings/store.js";
import type { CronJob } from "../../cron/store.js";

const TEST_DB = "/tmp/tars-admin-router-test.sqlite";

vi.mock("./asset-server.js", () => ({
	adminHtml: vi.fn(async () => "<html></html>"),
	serveAdminAsset: vi.fn(async (_res: http.ServerResponse, _dir: string, _path: string) => {
		// no-op: caller already handles response
	}),
}));

vi.mock("../../app/commands/generate-issue.js", () => ({
	generateIssueViaLLM: vi.fn(async () => ({ title: "Generated", body: "Body", labels: [], assignees: [] })),
}));

vi.mock("../../app/commands/issue-chat.js", () => ({
	chatIssueViaLLM: vi.fn(async () => ({
		shouldCreate: false,
		draft: { title: "", body: "", labels: [], assignees: [] },
		message: "",
		owner: "",
		repo: "",
		readyToCreate: false,
	})),
}));

function makeBasicAuth(username: string, password: string): string {
	return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

function mockRequest(options: {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: string;
}): http.IncomingMessage {
	const chunks = options.body ? [Buffer.from(options.body)] : [];
	return {
		url: options.url,
		method: options.method,
		headers: options.headers ?? {},
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	} as http.IncomingMessage;
}

function mockResponse(): http.ServerResponse & { body: unknown; statusCode: number } {
	const res = {
		statusCode: 0,
		body: undefined as unknown,
		setHeader: vi.fn(),
		end: vi.fn((data: unknown) => {
			res.body = data;
		}),
	} as unknown as http.ServerResponse & { body: unknown; statusCode: number };
	return res;
}

describe("handleAdminRoute", () => {
	let store: SettingsStore;
	let deps: Parameters<typeof handleAdminRoute>[2];
	let cronStore: {
		listForRepo: ReturnType<typeof vi.fn>;
		createJob: ReturnType<typeof vi.fn>;
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
		delete: ReturnType<typeof vi.fn>;
		getRuns: ReturnType<typeof vi.fn>;
	};
	let githubService: {
		listLabels: ReturnType<typeof vi.fn>;
		getIssueTemplates: ReturnType<typeof vi.fn>;
		listRecentCommits: ReturnType<typeof vi.fn>;
		listRelatedIssues: ReturnType<typeof vi.fn>;
		listOpenIssues: ReturnType<typeof vi.fn>;
		createIssue: ReturnType<typeof vi.fn>;
		listPendingInvitations: ReturnType<typeof vi.fn>;
		acceptInvitation: ReturnType<typeof vi.fn>;
		updateIssueAssignees: ReturnType<typeof vi.fn>;
		getAuthenticatedUser: ReturnType<typeof vi.fn>;
		listAccessibleRepositories: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
		store = new SettingsStore(TEST_DB);
		cronStore = {
			listForRepo: vi.fn(async () => []),
			createJob: vi.fn(async (_o: string, _r: string, name: string) => ({
				id: "cron-1",
				owner: "mbrooks",
				repo: "tars",
				name,
				description: "",
				prompt: "test",
				scheduleType: "daily" as const,
				scheduleValue: "09:00",
				branch: "main",
				notificationChannel: null,
				enabled: true,
				nextRunAt: "2025-01-01T09:00:00Z",
				lastRunAt: null,
				lastRunStatus: null,
				lastError: null,
				createdAt: "2025-01-01T00:00:00Z",
				prUrl: null,
				prNumber: null,
			})),
			get: vi.fn(async () => null),
			set: vi.fn(async (job: CronJob) => job),
			delete: vi.fn(async () => undefined),
			getRuns: vi.fn(async () => []),
		};
		githubService = {
			listLabels: vi.fn(async () => []),
			getIssueTemplates: vi.fn(async () => []),
			listRecentCommits: vi.fn(async () => []),
			listRelatedIssues: vi.fn(async () => []),
			listOpenIssues: vi.fn(async () => []),
			createIssue: vi.fn(async () => ({ number: 99, html_url: "https://github.com/mbrooks/tars/issues/99" })),
			listPendingInvitations: vi.fn(async () => []),
			acceptInvitation: vi.fn(async () => undefined),
			updateIssueAssignees: vi.fn(async () => undefined),
			getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
			listAccessibleRepositories: vi.fn(async () => []),
		};
		deps = {
			adminUsername: "admin",
			adminPassword: "secret",
			adminAssetsDir: "/tmp/admin-assets",
			getAdminStatus: {
				execute: vi.fn(async () => ({
					success: true as const,
					data: {
						agent: "online" as const,
						uptime: "1m",
						draining: false,
						repos: [],
						sessions: [],
					},
				})),
			} as never,
			getSession: {} as never,
			getSessionLog: {
				execute: vi.fn(async () => ({
					success: true as const,
					data: { entries: [] },
				})),
			} as never,
			runSessionCommand: {
				execute: vi.fn(async () => ({
					success: true as const,
					data: { acknowledged: true },
				})),
			} as never,
			taskController: {
				isDraining: vi.fn(() => false),
				setDraining: vi.fn(),
				cancel: vi.fn(),
				isActive: vi.fn(() => false),
				register: vi.fn(),
				unregister: vi.fn(),
			} as never,
			settingsStore: store,
			skillStore: {
				listAll: vi.fn(async () => []),
				get: vi.fn(async () => null),
				create: vi.fn(async () => ({ id: "skill-1", name: "test", description: "", content: "", enabled: true, updatedAt: "", createdAt: "" })),
				update: vi.fn(async () => null),
				delete: vi.fn(async () => true),
			} as never,
			repoSkillService: {
				listRepoSkills: vi.fn(async () => []),
				getRepoSkill: vi.fn(async () => null),
				saveRepoSkill: vi.fn(async () => ({ success: true })),
				deleteRepoSkill: vi.fn(async () => ({ success: true })),
			} as never,
			cronStore: cronStore as never,
			githubService: githubService as never,
		};
	});

	afterEach(() => {
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
	});

	it("returns false for unknown routes", async () => {
		const req = mockRequest({
			url: "/api/does-not-exist",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(false);
	});

	it("GET /api/onboarding/status returns missing fields", async () => {
		const req = mockRequest({
			url: "/api/onboarding/status",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.complete).toBe(false);
		expect(body.missing.length).toBeGreaterThan(0);
	});

	it("PATCH /api/repos/:owner/:repo/skills/:name preserves omitted fields", async () => {
		const getRepoSkill = vi.fn(async () => ({
			name: "triage",
			description: "Existing description",
			content: "Existing body",
			enabled: false,
			updatedAt: "",
			source: "repo" as const,
		}));
		const saveRepoSkill = vi.fn(async () => ({ success: true }));
		deps.repoSkillService = {
			...deps.repoSkillService,
			getRepoSkill,
			saveRepoSkill,
		} as never;
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ description: "Updated description" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(getRepoSkill).toHaveBeenCalledWith("mbrooks", "tars", "triage");
		expect(saveRepoSkill).toHaveBeenCalledWith("mbrooks", "tars", {
			name: "triage",
			description: "Updated description",
			content: "Existing body",
			enabled: false,
		});
	});

	it("POST /api/onboarding creates settings", async () => {
		const req = mockRequest({
			url: "/api/onboarding",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({
				github_token: "tok",
				github_username: "user",
				webhook_secret: "shh",
				admin_username: "admin",
				admin_password: "pass",
			}),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.success).toBe(true);
		expect(store.getString("github_token")).toBe("tok");
	});

	it("GET /tarsadmin returns HTML when credentials configured", async () => {
		const req = mockRequest({
			url: "/tarsadmin",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(String(res.body)).toContain("<html>");
	});

	it("GET /tarsadmin/assets/main.js serves asset", async () => {
		const req = mockRequest({
			url: "/tarsadmin/assets/main.js",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(0); // serveAdminAsset mock does not set status
	});

	it("GET /api/status/working returns working sessions", async () => {
		deps.getAdminStatus = {
			execute: vi.fn(async () => ({
				success: true as const,
				data: {
					agent: "online" as const,
					uptime: "1m",
					draining: false,
					repos: [],
					sessions: [
						{
							owner: "mbrooks",
							repo: "tars",
							issueNumber: 1,
							status: "working",
							lastActivity: "2025-01-01T00:00:00Z",
							workspacePath: "/tmp/ws",
							branch: "main",
							createdAt: "2025-01-01T00:00:00Z",
							prUrl: null,
							prNumber: null,
							risk: null,
							staleDetectedAt: null,
							staleReason: null,
							stale: null,
							sessionType: "github_issue" as const,
						},
					],
				},
			})),
		} as never;

		const req = mockRequest({
			url: "/api/status/working",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.working).toBe(true);
		expect(body.count).toBe(1);
	});

	it("GET /api/maintenance returns draining state", async () => {
		const req = mockRequest({
			url: "/api/maintenance",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.draining).toBe(false);
	});

	it("POST /api/maintenance toggles draining", async () => {
		const req = mockRequest({
			url: "/api/maintenance",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ enabled: true }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.draining).toBe(true);
		expect(deps.taskController.setDraining).toHaveBeenCalledWith(true);
	});

	it("GET /api/status returns admin status", async () => {
		const req = mockRequest({
			url: "/api/status",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.agent).toBe("online");
	});

	it("GET /api/sessions/:owner/:repo/:issue/log returns log", async () => {
		const req = mockRequest({
			url: "/api/sessions/mbrooks/tars/1/log",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.entries).toEqual([]);
	});

	it("POST /api/sessions/:owner/:repo/:issue/commands runs command", async () => {
		const req = mockRequest({
			url: "/api/sessions/mbrooks/tars/1/commands",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ command: "stop" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.acknowledged).toBe(true);
	});

	it("GET /api/crons/:owner/:repo lists jobs", async () => {
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.crons).toEqual([]);
	});

	it("POST /api/crons/:owner/:repo creates a job", async () => {
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({
				name: "Daily cleanup",
				prompt: "Clean up old sessions",
				scheduleType: "daily",
				scheduleValue: "09:00",
			}),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(201);
		const body = JSON.parse(String(res.body));
		expect(body.name).toBe("Daily cleanup");
	});

	it("GET /api/crons/:owner/:repo/:id returns a job", async () => {
		cronStore.get.mockResolvedValue({
			id: "cron-1",
			owner: "mbrooks",
			repo: "tars",
			name: "Test",
			description: "",
			prompt: "test",
			scheduleType: "daily" as const,
			scheduleValue: "09:00",
			branch: "main",
			notificationChannel: null,
			enabled: true,
			nextRunAt: "2025-01-01T09:00:00Z",
			lastRunAt: null,
			lastRunStatus: null,
			lastError: null,
			createdAt: "2025-01-01T00:00:00Z",
			prUrl: null,
			prNumber: null,
		});

		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/cron-1",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.id).toBe("cron-1");
	});

	it("PATCH /api/crons/:owner/:repo/:id updates a job", async () => {
		cronStore.get.mockResolvedValue({
			id: "cron-1",
			owner: "mbrooks",
			repo: "tars",
			name: "Old",
			description: "",
			prompt: "test",
			scheduleType: "daily" as const,
			scheduleValue: "09:00",
			branch: "main",
			notificationChannel: null,
			enabled: true,
			nextRunAt: "2025-01-01T09:00:00Z",
			lastRunAt: null,
			lastRunStatus: null,
			lastError: null,
			createdAt: "2025-01-01T00:00:00Z",
			prUrl: null,
			prNumber: null,
		});

		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/cron-1",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "New" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.name).toBe("New");
	});

	it("DELETE /api/crons/:owner/:repo/:id removes a job", async () => {
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/cron-1",
			method: "DELETE",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.deleted).toBe(true);
	});

	it("GET /api/crons/:owner/:repo/:id/runs returns runs", async () => {
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/cron-1/runs",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.runs).toEqual([]);
	});

	it("POST /api/crons/:owner/:repo/:id/run queues a job", async () => {
		cronStore.get.mockResolvedValue({
			id: "cron-1",
			owner: "mbrooks",
			repo: "tars",
			name: "Test",
			description: "",
			prompt: "test",
			scheduleType: "daily" as const,
			scheduleValue: "09:00",
			branch: "main",
			notificationChannel: null,
			enabled: true,
			nextRunAt: "2025-01-01T09:00:00Z",
			lastRunAt: null,
			lastRunStatus: null,
			lastError: null,
			createdAt: "2025-01-01T00:00:00Z",
			prUrl: null,
			prNumber: null,
		});

		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/cron-1/run",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.queued).toBe(true);
	});

	it("GET /api/repos/:owner/:repo/context returns context", async () => {
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/context",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.labels).toEqual([]);
	});

	it("POST /api/issues/generate returns generated issue", async () => {
		const { generateIssueViaLLM } = await import("../../app/commands/generate-issue.js");
		vi.mocked(generateIssueViaLLM).mockResolvedValue({
			title: "Generated Title",
			body: "Generated Body",
			labels: [],
			assignees: [],
		});

		const req = mockRequest({
			url: "/api/issues/generate",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ owner: "mbrooks", repo: "tars", prompt: "Write an issue" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.title).toBe("Generated Title");
	});

	it("POST /api/issues creates an issue", async () => {
		const req = mockRequest({
			url: "/api/issues",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ owner: "mbrooks", repo: "tars", title: "New Issue" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(201);
		const body = JSON.parse(String(res.body));
		expect(body.number).toBe(99);
	});

	it("GET /api/settings blanks sensitive values", async () => {
		store.set("github_token", "supersecret");
		store.set("github_username", "tars");

		const req = mockRequest({
			url: "/api/settings",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		const tokenView = body.settings.find((s: { key: string }) => s.key === "github_token");
		const userView = body.settings.find((s: { key: string }) => s.key === "github_username");
		expect(tokenView.value).toBe("");
		expect(tokenView.sensitive).toBe(true);
		expect(userView.value).toBe("tars");
		expect(userView.sensitive).toBe(false);
	});

	it("PATCH /api/settings updates non-sensitive fields", async () => {
		store.set("github_username", "old");

		const req = mockRequest({
			url: "/api/settings",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ github_username: "new" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.updated).toContain("github_username");
		expect(store.getString("github_username")).toBe("new");
	});

	it("PATCH /api/settings skips empty string for sensitive fields", async () => {
		store.set("github_token", "existing");

		const req = mockRequest({
			url: "/api/settings",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ github_token: "" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.updated).not.toContain("github_token");
		expect(store.getString("github_token")).toBe("existing");
	});

	it("POST /api/onboarding rejects missing fields", async () => {
		const req = mockRequest({
			url: "/api/onboarding",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ github_token: "tok" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("Missing required fields");
	});

	it("POST /api/maintenance rejects invalid body", async () => {
		const req = mockRequest({
			url: "/api/maintenance",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: "not json",
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	it("GET /api/status/working handles getAdminStatus failure", async () => {
		deps.getAdminStatus = {
			execute: vi.fn(async () => ({
				success: false as const,
				code: "not_found",
				message: "No sessions",
			})),
		} as never;

		const req = mockRequest({
			url: "/api/status/working",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("GET /api/status handles getAdminStatus failure", async () => {
		deps.getAdminStatus = {
			execute: vi.fn(async () => ({
				success: false as const,
				code: "not_found",
				message: "No sessions",
			})),
		} as never;

		const req = mockRequest({
			url: "/api/status",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("GET /api/sessions/:owner/:repo/:issue/log handles service error", async () => {
		deps.getSessionLog = {
			execute: vi.fn(async () => ({
				success: false as const,
				code: "not_found",
				message: "Not found",
			})),
		} as never;

		const req = mockRequest({
			url: "/api/sessions/mbrooks/tars/1/log",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("POST /api/sessions/:owner/:repo/:issue/commands rejects missing command", async () => {
		const req = mockRequest({
			url: "/api/sessions/mbrooks/tars/1/commands",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({}),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Missing command");
	});

	it("POST /api/sessions/:owner/:repo/:issue/commands handles service error", async () => {
		deps.runSessionCommand = {
			execute: vi.fn(async () => ({
				success: false as const,
				code: "not_found",
				message: "Not found",
			})),
		} as never;

		const req = mockRequest({
			url: "/api/sessions/mbrooks/tars/1/commands",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ command: "stop" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("GET /api/crons/:owner/:repo/:id returns 404 when not found", async () => {
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/missing",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("PATCH /api/crons/:owner/:repo/:id returns 404 when not found", async () => {
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/missing",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "New" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("POST /api/crons/:owner/:repo/:id/run returns 404 when not found", async () => {
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/missing/run",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("POST /api/crons/:owner/:repo rejects missing fields", async () => {
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "Daily" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("Missing required fields");
	});

	it("POST /api/issues/generate rejects missing fields", async () => {
		const req = mockRequest({
			url: "/api/issues/generate",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ owner: "mbrooks" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("Missing required fields");
	});

	it("POST /api/issues rejects missing fields", async () => {
		const req = mockRequest({
			url: "/api/issues",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ owner: "mbrooks" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("Missing required fields");
	});

	it("POST /api/issues/chat returns chat result when shouldCreate is false", async () => {
		const req = mockRequest({
			url: "/api/issues/chat",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ messages: [{ role: "user", text: "Hello" }] }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.shouldCreate).toBe(false);
	});

	it("POST /api/issues/chat returns ready message when shouldCreate true but missing repo/title", async () => {
		const { chatIssueViaLLM } = await import("../../app/commands/issue-chat.js");
		vi.mocked(chatIssueViaLLM).mockResolvedValue({
			shouldCreate: true,
			owner: "mbrooks",
			repo: "",
			draft: { title: "", body: "", labels: [], assignees: [] },
			message: "Need more info",
			readyToCreate: false,
		});

		const req = mockRequest({
			url: "/api/issues/chat",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ messages: [{ role: "user", text: "Hello" }] }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.readyToCreate).toBe(false);
	});

	it("GET /api/repos/:owner/:repo/context returns 500 when githubService missing", async () => {
		const noGhDeps = { ...deps, githubService: undefined };
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/context",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noGhDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("GitHub service not configured");
	});

	it("POST /api/onboarding rejects invalid JSON", async () => {
		const req = mockRequest({
			url: "/api/onboarding",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: "not json",
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	it("GET /api/settings returns 500 when settingsStore missing", async () => {
		const noStoreDeps = { ...deps, settingsStore: undefined };
		const req = mockRequest({
			url: "/api/settings",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noStoreDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Settings store not configured");
	});

	it("PATCH /api/settings returns 500 when settingsStore missing", async () => {
		const noStoreDeps = { ...deps, settingsStore: undefined };
		const req = mockRequest({
			url: "/api/settings",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ port: 8080 }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noStoreDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Settings store not configured");
	});

	it("POST /api/crons/:owner/:repo rejects invalid JSON", async () => {
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: "not json",
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	it("GET /api/crons/:owner/:repo handles list error", async () => {
		cronStore.listForRepo.mockRejectedValue(new Error("DB error"));
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("POST /api/issues/chat rejects invalid JSON", async () => {
		const req = mockRequest({
			url: "/api/issues/chat",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: "not json",
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("GET /api/repos/:owner/:repo/context handles service error", async () => {
		githubService.listLabels.mockRejectedValue(new Error("Network error"));
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/context",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("POST /api/issues/chat creates issue when ready", async () => {
		const { chatIssueViaLLM } = await import("../../app/commands/issue-chat.js");
		vi.mocked(chatIssueViaLLM).mockResolvedValue({
			shouldCreate: true,
			owner: "mbrooks",
			repo: "tars",
			draft: { title: "Chat Title", body: "Chat Body", labels: [], assignees: [] },
			message: "Created",
			readyToCreate: true,
		});

		const req = mockRequest({
			url: "/api/issues/chat",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ messages: [{ role: "user", text: "Hello" }] }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.createdIssue.number).toBe(99);
	});

	it("GET /api/onboarding/status returns 500 when settingsStore missing", async () => {
		const noStoreDeps = { ...deps, settingsStore: undefined };
		const req = mockRequest({
			url: "/api/onboarding/status",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noStoreDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Settings store not configured");
	});

	it("POST /api/onboarding returns 500 when settingsStore missing", async () => {
		const noStoreDeps = { ...deps, settingsStore: undefined };
		const req = mockRequest({
			url: "/api/onboarding",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({
				github_token: "tok",
				github_username: "user",
				webhook_secret: "shh",
				admin_username: "admin",
				admin_password: "pass",
			}),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noStoreDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Settings store not configured");
	});

	it("GET /tarsadmin allows access without auth during onboarding", async () => {
		const onboardingDeps = { ...deps, adminUsername: undefined, adminPassword: undefined };
		const req = mockRequest({
			url: "/tarsadmin",
			method: "GET",
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, onboardingDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
	});

	it("GET /api/crons/:owner/:repo returns 500 when cronStore missing", async () => {
		const noCronDeps = { ...deps, cronStore: undefined };
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noCronDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Cron store not configured");
	});

	it("POST /api/crons/:owner/:repo returns 500 when cronStore missing", async () => {
		const noCronDeps = { ...deps, cronStore: undefined };
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "Daily", prompt: "test", scheduleType: "daily", scheduleValue: "09:00" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noCronDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Cron store not configured");
	});

	it("GET /api/crons/:owner/:repo/:id returns 500 when cronStore missing", async () => {
		const noCronDeps = { ...deps, cronStore: undefined };
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/cron-1",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noCronDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Cron store not configured");
	});

	it("PATCH /api/crons/:owner/:repo/:id returns 500 when cronStore missing", async () => {
		const noCronDeps = { ...deps, cronStore: undefined };
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/cron-1",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "New" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noCronDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Cron store not configured");
	});

	it("DELETE /api/crons/:owner/:repo/:id returns 500 when cronStore missing", async () => {
		const noCronDeps = { ...deps, cronStore: undefined };
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/cron-1",
			method: "DELETE",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noCronDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Cron store not configured");
	});

	it("GET /api/crons/:owner/:repo/:id/runs returns 500 when cronStore missing", async () => {
		const noCronDeps = { ...deps, cronStore: undefined };
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/cron-1/runs",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noCronDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Cron store not configured");
	});

	it("POST /api/crons/:owner/:repo/:id/run returns 500 when cronStore missing", async () => {
		const noCronDeps = { ...deps, cronStore: undefined };
		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/cron-1/run",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noCronDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Cron store not configured");
	});

	it("POST /api/issues returns 500 when githubService missing", async () => {
		const noGhDeps = { ...deps, githubService: undefined };
		const req = mockRequest({
			url: "/api/issues",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ owner: "mbrooks", repo: "tars", title: "New Issue" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noGhDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("GitHub service not configured");
	});

	it("GET /api/settings returns 500 when settingsStore missing", async () => {
		const noStoreDeps = { ...deps, settingsStore: undefined };
		const req = mockRequest({
			url: "/api/settings",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noStoreDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Settings store not configured");
	});

	it("PATCH /api/settings returns 500 when settingsStore missing", async () => {
		const noStoreDeps = { ...deps, settingsStore: undefined };
		const req = mockRequest({
			url: "/api/settings",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ port: 8080 }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noStoreDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Settings store not configured");
	});

	it("GET /api/onboarding/status returns complete when all fields set", async () => {
		store.set("github_token", "tok");
		store.set("github_username", "user");
		store.set("webhook_secret", "shh");
		store.set("admin_username", "admin");
		store.set("admin_password", "pass");

		const req = mockRequest({
			url: "/api/onboarding/status",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.complete).toBe(true);
		expect(body.missing).toEqual([]);
	});

	it("GET /api/maintenance returns true when draining", async () => {
		deps.taskController.isDraining = vi.fn(() => true);
		const req = mockRequest({
			url: "/api/maintenance",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.draining).toBe(true);
	});

	it("POST /api/maintenance disables draining", async () => {
		const req = mockRequest({
			url: "/api/maintenance",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ enabled: false }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.draining).toBe(false);
		expect(deps.taskController.setDraining).toHaveBeenCalledWith(false);
	});

	it("GET /api/status/working handles getAdminStatus throwing", async () => {
		deps.getAdminStatus = {
			execute: vi.fn(async () => {
				throw new Error("disk error");
			}),
		} as never;

		const req = mockRequest({
			url: "/api/status/working",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("disk error");
	});

	it("GET /api/status handles getAdminStatus throwing", async () => {
		deps.getAdminStatus = {
			execute: vi.fn(async () => {
				throw new Error("disk error");
			}),
		} as never;

		const req = mockRequest({
			url: "/api/status",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("disk error");
	});

	it("PATCH /api/crons/:owner/:repo/:id recomputes schedule when scheduleType changes", async () => {
		cronStore.get.mockResolvedValue({
			id: "cron-1",
			owner: "mbrooks",
			repo: "tars",
			name: "Test",
			description: "",
			prompt: "test",
			scheduleType: "daily" as const,
			scheduleValue: "09:00",
			branch: "main",
			notificationChannel: null,
			enabled: true,
			nextRunAt: "2025-01-01T09:00:00Z",
			lastRunAt: null,
			lastRunStatus: null,
			lastError: null,
			createdAt: "2025-01-01T00:00:00Z",
			prUrl: null,
			prNumber: null,
		});

		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/cron-1",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ scheduleType: "weekly", scheduleValue: "Mon 09:00" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.scheduleType).toBe("weekly");
		expect(cronStore.set).toHaveBeenCalled();
	});

	it("PATCH /api/crons/:owner/:repo/:id recomputes schedule when enabled from false to true", async () => {
		cronStore.get.mockResolvedValue({
			id: "cron-1",
			owner: "mbrooks",
			repo: "tars",
			name: "Test",
			description: "",
			prompt: "test",
			scheduleType: "daily" as const,
			scheduleValue: "09:00",
			branch: "main",
			notificationChannel: null,
			enabled: false,
			nextRunAt: "2025-01-01T09:00:00Z",
			lastRunAt: null,
			lastRunStatus: null,
			lastError: null,
			createdAt: "2025-01-01T00:00:00Z",
			prUrl: null,
			prNumber: null,
		});

		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/cron-1",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ enabled: true }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.enabled).toBe(true);
		expect(cronStore.set).toHaveBeenCalled();
	});

	it("POST /api/crons/:owner/:repo/:id/run handles set error", async () => {
		cronStore.get.mockResolvedValue({
			id: "cron-1",
			owner: "mbrooks",
			repo: "tars",
			name: "Test",
			description: "",
			prompt: "test",
			scheduleType: "daily" as const,
			scheduleValue: "09:00",
			branch: "main",
			notificationChannel: null,
			enabled: true,
			nextRunAt: "2025-01-01T09:00:00Z",
			lastRunAt: null,
			lastRunStatus: null,
			lastError: null,
			createdAt: "2025-01-01T00:00:00Z",
			prUrl: null,
			prNumber: null,
		});
		cronStore.set.mockRejectedValue(new Error("DB error"));

		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/cron-1/run",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("GET /api/status/working returns false when no working sessions", async () => {
		deps.getAdminStatus = {
			execute: vi.fn(async () => ({
				success: true as const,
				data: {
					agent: "online" as const,
					uptime: "1m",
					draining: false,
					repos: [],
					sessions: [
						{
							owner: "mbrooks",
							repo: "tars",
							issueNumber: 1,
							status: "complete",
							lastActivity: "2025-01-01T00:00:00Z",
							workspacePath: "/tmp/ws",
							branch: "main",
							createdAt: "2025-01-01T00:00:00Z",
							prUrl: null,
							prNumber: null,
							risk: null,
							staleDetectedAt: null,
							staleReason: null,
							stale: null,
							sessionType: "github_issue" as const,
						},
					],
				},
			})),
		} as never;

		const req = mockRequest({
			url: "/api/status/working",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.working).toBe(false);
		expect(body.count).toBe(0);
	});

	it("GET /api/sessions/:owner/:repo/:issue/unknown returns 404", async () => {
		const req = mockRequest({
			url: "/api/sessions/mbrooks/tars/1/unknown",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("POST /api/sessions/:owner/:repo/:issue/unknown returns 404", async () => {
		const req = mockRequest({
			url: "/api/sessions/mbrooks/tars/1/unknown",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ command: "stop" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("GET /tarsadmin uses credentials from settingsStore when deps credentials missing", async () => {
		store.set("admin_username", "store-admin");
		store.set("admin_password", "store-secret");
		const credsDeps = { ...deps, adminUsername: undefined, adminPassword: undefined };
		const req = mockRequest({
			url: "/tarsadmin",
			method: "GET",
			headers: { authorization: makeBasicAuth("store-admin", "store-secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, credsDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
	});

	it("POST /api/issues/chat filters out invalid messages", async () => {
		const req = mockRequest({
			url: "/api/issues/chat",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({
				messages: [
					{ role: "user", text: "Hello" },
					{ role: "assistant" },
					{ role: "bot", text: "Hi" },
				],
			}),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
	});

	it("PATCH /api/settings rejects invalid JSON", async () => {
		const req = mockRequest({
			url: "/api/settings",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: "not json",
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	it("PATCH /api/crons/:owner/:repo/:id disables enabled job", async () => {
		cronStore.get.mockResolvedValue({
			id: "cron-1",
			owner: "mbrooks",
			repo: "tars",
			name: "Test",
			description: "",
			prompt: "test",
			scheduleType: "daily" as const,
			scheduleValue: "09:00",
			branch: "main",
			notificationChannel: null,
			enabled: true,
			nextRunAt: "2025-01-01T09:00:00Z",
			lastRunAt: null,
			lastRunStatus: null,
			lastError: null,
			createdAt: "2025-01-01T00:00:00Z",
			prUrl: null,
			prNumber: null,
		});

		const req = mockRequest({
			url: "/api/crons/mbrooks/tars/cron-1",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ enabled: false }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.enabled).toBe(false);
	});

	it("GET /api/settings handles getAllViews throwing", async () => {
		const brokenStore = new SettingsStore(TEST_DB);
		brokenStore.getAllViews = () => {
			throw new Error("DB error");
		};
		const brokenDeps = { ...deps, settingsStore: brokenStore };
		const req = mockRequest({
			url: "/api/settings",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, brokenDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("returns false for unmatched routes", async () => {
		const req = mockRequest({
			url: "/api/unknown",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(false);
	});

	// Server Skills routes
	it("GET /api/skills returns 500 when skillStore missing", async () => {
		const noSkillDeps = { ...deps, skillStore: undefined };
		const req = mockRequest({
			url: "/api/skills",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noSkillDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Skill store not configured");
	});

	it("GET /api/skills lists server skills", async () => {
		const req = mockRequest({
			url: "/api/skills",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.skills).toEqual([]);
	});

	it("POST /api/skills creates a server skill", async () => {
		deps.skillStore = {
			get: vi.fn(async () => null),
			listAll: vi.fn(async () => []),
			create: vi.fn(async (data: { name: string }) => ({ id: "skill-1", name: data.name, description: "", content: "", enabled: true, updatedAt: "", createdAt: "" })),
			update: vi.fn(async () => null),
			delete: vi.fn(async () => true),
		} as never;
		const req = mockRequest({
			url: "/api/skills",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "triage", content: "# Triage", enabled: true }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(201);
		const body = JSON.parse(String(res.body));
		expect(body.name).toBe("triage");
	});

	it("GET /api/skills/:id returns a server skill", async () => {
		deps.skillStore = {
			get: vi.fn(async () => ({ id: "skill-1", name: "test", description: "", content: "", enabled: true, updatedAt: "", createdAt: "" })),
			listAll: vi.fn(async () => []),
			create: vi.fn(async () => ({ id: "skill-1", name: "test", description: "", content: "", enabled: true, updatedAt: "", createdAt: "" })),
			update: vi.fn(async () => null),
			delete: vi.fn(async () => true),
		} as never;

		const req = mockRequest({
			url: "/api/skills/skill-1",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.id).toBe("skill-1");
	});

	it("PATCH /api/skills/:id updates a server skill", async () => {
		deps.skillStore = {
			get: vi.fn(async () => ({ id: "skill-1", name: "old", description: "", content: "", enabled: true, updatedAt: "", createdAt: "" })),
			listAll: vi.fn(async () => []),
			create: vi.fn(async () => ({ id: "skill-1", name: "test", description: "", content: "", enabled: true, updatedAt: "", createdAt: "" })),
			update: vi.fn(async () => ({ id: "skill-1", name: "new", description: "", content: "", enabled: true, updatedAt: "", createdAt: "" })),
			delete: vi.fn(async () => true),
		} as never;

		const req = mockRequest({
			url: "/api/skills/skill-1",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "new" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.name).toBe("new");
	});

	it("DELETE /api/skills/:id removes a server skill", async () => {
		const req = mockRequest({
			url: "/api/skills/skill-1",
			method: "DELETE",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.deleted).toBe(true);
	});

	it("DELETE /api/skills/:id returns 401 when not admin", async () => {
		const req = mockRequest({
			url: "/api/skills/skill-1",
			method: "DELETE",
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("DELETE /api/skills/:id returns 500 when skillStore is missing", async () => {
		const req = mockRequest({
			url: "/api/skills/skill-1",
			method: "DELETE",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, { ...deps, skillStore: undefined });
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("DELETE /api/skills/:id returns 500 when delete throws", async () => {
		deps.skillStore = {
			...deps.skillStore,
			delete: vi.fn(async () => { throw new Error("delete failed"); }),
		} as never;
		const req = mockRequest({
			url: "/api/skills/skill-1",
			method: "DELETE",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("delete failed");
	});

	// Repo Skills routes
	it("GET /api/repos/:owner/:repo/skills returns 500 when repoSkillService missing", async () => {
		const noRepoSkillDeps = { ...deps, repoSkillService: undefined };
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noRepoSkillDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Repo skill service not configured");
	});

	it("GET /api/repos/:owner/:repo/skills merges repo and server skills", async () => {
		deps.skillStore = {
			get: vi.fn(async () => null),
			listAll: vi.fn(async () => [{ id: "s1", name: "server-only", description: "", content: "", enabled: true, updatedAt: "", createdAt: "" }]),
			create: vi.fn(async () => ({ id: "s1", name: "test", description: "", content: "", enabled: true, updatedAt: "", createdAt: "" })),
			update: vi.fn(async () => null),
			delete: vi.fn(async () => true),
		} as never;
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => [
				{ name: "repo-only", description: "", content: "", enabled: true, updatedAt: "", source: "repo" as const },
				{ name: "server-only", description: "", content: "", enabled: true, updatedAt: "", source: "repo" as const },
			]),
			getRepoSkill: vi.fn(async () => null),
			saveRepoSkill: vi.fn(async () => ({ success: true })),
			deleteRepoSkill: vi.fn(async () => ({ success: true })),
		} as never;

		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.skills.length).toBe(2);
		const names = body.skills.map((s: { name: string }) => s.name);
		expect(names).toContain("server-only");
		expect(names).toContain("repo-only");
	});

	it("GET /api/repos/:owner/:repo/skills lists repo skills", async () => {
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.skills).toEqual([]);
	});

	it("GET /api/repos/:owner/:repo/skills returns 401 when not admin", async () => {
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills",
			method: "GET",
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("GET /api/repos/:owner/:repo/skills returns 500 when listRepoSkills throws", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => { throw new Error("list failed"); }),
			getRepoSkill: vi.fn(async () => null),
			saveRepoSkill: vi.fn(async () => ({ success: true })),
			deleteRepoSkill: vi.fn(async () => ({ success: true })),
		} as never;

		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("list failed");
	});

	it("POST /api/repos/:owner/:repo/skills creates a repo skill", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => [{ name: "triage", description: "", content: "", enabled: true, updatedAt: "", source: "repo" as const }]),
			getRepoSkill: vi.fn(async () => null),
			saveRepoSkill: vi.fn(async () => ({ success: true })),
			deleteRepoSkill: vi.fn(async () => ({ success: true })),
		} as never;

		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "triage", content: "# Triage", enabled: true }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(201);
		const body = JSON.parse(String(res.body));
		expect(body.name).toBe("triage");
	});

	it("POST /api/repos/:owner/:repo/skills returns 500 when saveRepoSkill fails", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => []),
			getRepoSkill: vi.fn(async () => null),
			saveRepoSkill: vi.fn(async () => ({ success: false, error: "save failed" })),
			deleteRepoSkill: vi.fn(async () => ({ success: true })),
		} as never;

		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "triage", content: "# Triage", enabled: true }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("save failed");
	});

	it("POST /api/repos/:owner/:repo/skills returns 401 when not admin", async () => {
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills",
			method: "POST",
			body: JSON.stringify({ name: "triage", content: "# Triage", enabled: true }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("POST /api/repos/:owner/:repo/skills returns 400 on invalid json", async () => {
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: "not-json",
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	it("POST /api/repos/:owner/:repo/skills returns 500 when repoSkillService is missing", async () => {
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "triage", content: "# Triage" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, { ...deps, repoSkillService: undefined });
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("POST /api/repos/:owner/:repo/skills requires name and content", async () => {
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "triage" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("Missing required fields");
	});

	it("DELETE returns 401 when not admin", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => []),
			getRepoSkill: vi.fn(async () => null),
			saveRepoSkill: vi.fn(async () => ({ success: true })),
			deleteRepoSkill: vi.fn(async () => ({ success: true })),
		} as never;
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "DELETE",
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("DELETE returns 500 when repoSkillService missing", async () => {
		const noRepoSkillDeps = { ...deps, repoSkillService: undefined };
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "DELETE",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, noRepoSkillDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("not configured");
	});

	it("DELETE /api/repos/:owner/:repo/skills/:name removes a repo skill", async () => {
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "DELETE",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.deleted).toBe(true);
	});

	it("DELETE returns 500 when deleteRepoSkill fails", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => []),
			getRepoSkill: vi.fn(async () => null),
			saveRepoSkill: vi.fn(async () => ({ success: true })),
			deleteRepoSkill: vi.fn(async () => ({ success: false, error: "git error" })),
		} as never;
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "DELETE",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("git error");
	});

	it("DELETE returns 500 when deleteRepoSkill throws", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => []),
			getRepoSkill: vi.fn(async () => null),
			saveRepoSkill: vi.fn(async () => ({ success: true })),
			deleteRepoSkill: vi.fn(async () => { throw new Error("boom"); }),
		} as never;
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "DELETE",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("boom");
	});

	it("GET merge includes inherited skills when not in repo", async () => {
		const serverDeps = {
			...deps,
			repoSkillService: {
				listRepoSkills: vi.fn(async () => [
					{ name: "repo-only", description: "", content: "", enabled: true, updatedAt: "", source: "repo" as const },
				]),
				getRepoSkill: vi.fn(async () => null),
				saveRepoSkill: vi.fn(async () => ({ success: true })),
				deleteRepoSkill: vi.fn(async () => ({ success: true })),
			} as never,
			skillStore: {
				get: vi.fn(async () => null),
				listAll: vi.fn(async () => [
					{ id: "s1", name: "server-only", description: "", content: "", enabled: true, updatedAt: "", createdAt: "" },
				]),
				create: vi.fn(async () => ({ id: "s1", name: "test", description: "", content: "", enabled: true, updatedAt: "", createdAt: "" })),
				update: vi.fn(async () => null),
				delete: vi.fn(async () => true),
			} as never,
		};
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, serverDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.skills.length).toBe(2);
		const inherited = body.skills.find((s: { name: string; source: string }) => s.name === "server-only");
		expect(inherited.source).toBe("inherited");
	});

	it("GET returns 500 when repoSkillService missing for detail", async () => {
		const noRepoSkillDeps = { ...deps, repoSkillService: undefined };
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, noRepoSkillDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("not configured");
	});

	it("GET returns 500 when getRepoSkill throws", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => []),
			getRepoSkill: vi.fn(async () => { throw new Error("boom"); }),
			saveRepoSkill: vi.fn(async () => ({ success: true })),
			deleteRepoSkill: vi.fn(async () => ({ success: true })),
		} as never;
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("boom");
	});

	it("PATCH returns 401 when not admin", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => []),
			getRepoSkill: vi.fn(async () => null),
			saveRepoSkill: vi.fn(async () => ({ success: true })),
			deleteRepoSkill: vi.fn(async () => ({ success: true })),
		} as never;
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "PATCH",
			body: JSON.stringify({ name: "triage" }),
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("PATCH returns 500 when repoSkillService missing", async () => {
		const noRepoSkillDeps = { ...deps, repoSkillService: undefined };
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "triage" }),
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, noRepoSkillDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("not configured");
	});

	it("PATCH returns 500 when saveRepoSkill fails", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => []),
			getRepoSkill: vi.fn(async () => ({ name: "triage", description: "d", content: "c", enabled: true, updatedAt: "", source: "repo" as const })),
			saveRepoSkill: vi.fn(async () => ({ success: false, error: "save error" })),
			deleteRepoSkill: vi.fn(async () => ({ success: true })),
		} as never;
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "triage" }),
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("save error");
	});

	it("PATCH returns 400 on invalid json", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => []),
			getRepoSkill: vi.fn(async () => null),
			saveRepoSkill: vi.fn(async () => ({ success: true })),
			deleteRepoSkill: vi.fn(async () => ({ success: true })),
		} as never;
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: "not-json",
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBeTruthy();
	});

	it("returns 404 for unknown routes inside skills", async () => {
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/extra/path",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(false);
	});

	it("GET /api/repos/:owner/:repo/skills/:name returns a repo skill", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => []),
			getRepoSkill: vi.fn(async () => ({ name: "triage", description: "d", content: "c", enabled: true, updatedAt: "", source: "repo" as const })),
			saveRepoSkill: vi.fn(async () => ({ success: true })),
			deleteRepoSkill: vi.fn(async () => ({ success: true })),
		} as never;
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.name).toBe("triage");
	});

	it("GET /api/repos/:owner/:repo/skills/:name returns 404 when missing", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => []),
			getRepoSkill: vi.fn(async () => null),
			saveRepoSkill: vi.fn(async () => ({ success: true })),
			deleteRepoSkill: vi.fn(async () => ({ success: true })),
		} as never;
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("not found");
	});

	it("GET /api/repos/:owner/:repo/skills/:name returns 401 when not admin", async () => {
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "GET",
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("PATCH /api/repos/:owner/:repo/skills/:name updates a repo skill", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => []),
			getRepoSkill: vi.fn(async () => ({ name: "triage", description: "existing", content: "c", enabled: true, updatedAt: "", source: "repo" as const })),
			saveRepoSkill: vi.fn(async () => ({ success: true })),
			deleteRepoSkill: vi.fn(async () => ({ success: true })),
		} as never;
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "triage", description: "updated", content: "c", enabled: true }),
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.name).toBe("triage");
	});

	it("PATCH renames a repo skill when name changes", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => []),
			getRepoSkill: vi.fn(async () => ({ name: "triage", description: "existing", content: "c", enabled: true, updatedAt: "", source: "repo" as const })),
			saveRepoSkill: vi.fn(async () => ({ success: true })),
			deleteRepoSkill: vi.fn(async () => ({ success: true })),
		} as never;
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "renamed" }),
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.name).toBe("renamed");
	});

	it("PATCH returns 500 when saveRepoSkill fails", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => []),
			getRepoSkill: vi.fn(async () => ({ name: "triage", description: "d", content: "c", enabled: true, updatedAt: "", source: "repo" as const })),
			saveRepoSkill: vi.fn(async () => ({ success: false, error: "fail" })),
			deleteRepoSkill: vi.fn(async () => ({ success: true })),
		} as never;
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/skills/triage",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "triage" }),
		});
		const res = mockResponse();
		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("fail");
	});

	it("GET /api/repos/:owner/:repo/issues returns open issues", async () => {
		githubService.listOpenIssues.mockResolvedValue([
			{ number: 1, title: "Bug", body: "desc", state: "open", labels: ["bug"], assignees: ["mbrooks"], html_url: "https://github.com/mbrooks/tars/issues/1" },
		]);
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/issues",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.issues).toHaveLength(1);
		expect(body.issues[0].number).toBe(1);
		expect(githubService.listOpenIssues).toHaveBeenCalledWith("mbrooks", "tars");
	});

	it("GET /api/repos/:owner/:repo/issues returns 500 when githubService missing", async () => {
		const noGhDeps = { ...deps, githubService: undefined };
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/issues",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noGhDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("GitHub service not configured");
	});

	it("GET /api/repos/:owner/:repo/issues handles service error", async () => {
		githubService.listOpenIssues.mockRejectedValue(new Error("Network error"));
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/issues",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("Network error");
	});

	it("POST /api/repos/:owner/:repo/issues/:number/assign assigns to TARS username", async () => {
		store.set("github_username", "tars-bot");
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/issues/42/assign",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.assigned).toBe(true);
		expect(githubService.updateIssueAssignees).toHaveBeenCalledWith("mbrooks", "tars", 42, ["tars-bot"]);
	});

	it("POST /api/repos/:owner/:repo/issues/:number/assign returns 500 when githubService missing", async () => {
		const noGhDeps = { ...deps, githubService: undefined };
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/issues/42/assign",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noGhDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("GitHub service not configured");
	});

	it("POST /api/repos/:owner/:repo/issues/:number/assign returns 500 when settingsStore missing", async () => {
		const noStoreDeps = { ...deps, settingsStore: undefined };
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/issues/42/assign",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noStoreDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Settings store not configured");
	});

	it("POST /api/repos/:owner/:repo/issues/:number/assign returns 500 when github_username not set", async () => {
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/issues/42/assign",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("TARS GitHub username not configured");
	});

	it("POST /api/repos/:owner/:repo/issues/:number/assign handles service error", async () => {
		store.set("github_username", "tars-bot");
		githubService.updateIssueAssignees.mockRejectedValue(new Error("API error"));
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/issues/42/assign",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("API error");
	});

	it("POST /api/repos/:owner/:repo/issues/:number/assign returns false for invalid issue number", async () => {
		const req = mockRequest({
			url: "/api/repos/mbrooks/tars/issues/abc/assign",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(false);
	});

	it("PATCH /api/skills/:id handles update error", async () => {
		deps.skillStore = {
			...deps.skillStore,
			update: vi.fn(async () => {
				throw new Error("DB error");
			}),
		} as never;
		const req = mockRequest({
			url: "/api/skills/skill-1",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "Updated" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("DB error");
	});

	it("PATCH /api/skills/:id returns 404 when update returns null", async () => {
		deps.skillStore = {
			...deps.skillStore,
			update: vi.fn(async () => null),
		} as never;
		const req = mockRequest({
			url: "/api/skills/skill-1",
			method: "PATCH",
			headers: { authorization: makeBasicAuth("admin", "secret") },
			body: JSON.stringify({ name: "Updated" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("Skill not found");
	});

	it("GET /api/github/invitations returns pending invitations", async () => {
		githubService.listPendingInvitations.mockResolvedValue([
			{
				id: 1,
				repository: { full_name: "octocat/Hello-World", name: "Hello-World", owner: { login: "octocat" } },
				inviter: { login: "octocat" },
				permissions: "write",
				created_at: "2024-01-01T00:00:00Z",
				html_url: "https://github.com/octocat/Hello-World/invitations",
			},
		]);
		const req = mockRequest({
			url: "/api/github/invitations",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.invitations).toHaveLength(1);
		expect(body.invitations[0].id).toBe(1);
	});

	it("GET /api/github/invitations returns 500 when githubService missing", async () => {
		const noGhDeps = { ...deps, githubService: undefined };
		const req = mockRequest({
			url: "/api/github/invitations",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noGhDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("GitHub service not configured");
	});

	it("GET /api/github/invitations handles service error", async () => {
		githubService.listPendingInvitations.mockRejectedValue(new Error("Network error"));
		const req = mockRequest({
			url: "/api/github/invitations",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("Network error");
	});

	it("POST /api/github/invitations/:id/accept accepts an invitation", async () => {
		const req = mockRequest({
			url: "/api/github/invitations/1/accept",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.accepted).toBe(true);
		expect(githubService.acceptInvitation).toHaveBeenCalledWith(1);
	});

	it("POST /api/github/invitations/:id/accept returns 500 when githubService missing", async () => {
		const noGhDeps = { ...deps, githubService: undefined };
		const req = mockRequest({
			url: "/api/github/invitations/1/accept",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noGhDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("GitHub service not configured");
	});

	it("POST /api/github/invitations/:id/accept handles service error", async () => {
		githubService.acceptInvitation.mockRejectedValue(new Error("Not found"));
		const req = mockRequest({
			url: "/api/github/invitations/1/accept",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("Not found");
	});

	it("GET /api/github/invitations returns 401 when not admin", async () => {
		const req = mockRequest({
			url: "/api/github/invitations",
			method: "GET",
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("POST /api/github/invitations/:id/accept returns 401 when not admin", async () => {
		const req = mockRequest({
			url: "/api/github/invitations/1/accept",
			method: "POST",
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("POST /api/github/invitations/invalid/accept returns 400 for invalid ID", async () => {
		const req = mockRequest({
			url: "/api/github/invitations/abc/accept",
			method: "POST",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Invalid invitation ID");
	});
});
