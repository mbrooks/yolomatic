import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { unlinkSync } from "node:fs";
import http from "node:http";
import { executeIssueChatRequest, handleAdminRoute } from "./admin-router.js";
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
		createIssue: ReturnType<typeof vi.fn>;
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
			createIssue: vi.fn(async () => ({ number: 99, html_url: "https://github.com/mbrooks/tars/issues/99" })),
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

	it("executeIssueChatRequest rejects missing messages", async () => {
		await expect(executeIssueChatRequest(deps, {})).rejects.toThrow("Missing required field: messages");
	});

	it("executeIssueChatRequest rejects create requests when GitHub service is missing", async () => {
		const { chatIssueViaLLM } = await import("../../app/commands/issue-chat.js");
		vi.mocked(chatIssueViaLLM).mockResolvedValueOnce({
			shouldCreate: true,
			owner: "mbrooks",
			repo: "tars",
			draft: { title: "Chat Title", body: "Chat Body", labels: [], assignees: [] },
			message: "Create it",
			readyToCreate: true,
		});

		await expect(
			executeIssueChatRequest(
				{ ...deps, githubService: undefined },
				{ messages: [{ role: "user", text: "create it" }] },
			),
		).rejects.toThrow("GitHub service not configured");
	});

	it("executeIssueChatRequest emits progress updates when creation is incomplete", async () => {
		const { chatIssueViaLLM } = await import("../../app/commands/issue-chat.js");
		vi.mocked(chatIssueViaLLM).mockResolvedValueOnce({
			shouldCreate: true,
			owner: "mbrooks",
			repo: "",
			draft: { title: "", body: "Body", labels: [], assignees: [] },
			message: "Need more info",
			readyToCreate: false,
		});
		const onProgress = vi.fn();

		const response = await executeIssueChatRequest(
			deps,
			{ messages: [{ role: "user", text: "create it" }] },
			onProgress,
		);

		expect(response.shouldCreate).toBe(false);
		expect(response.readyToCreate).toBe(false);
		expect(onProgress).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ type: "started" }),
		);
		expect(onProgress).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				type: "completed",
				response: expect.objectContaining({ readyToCreate: false, shouldCreate: false }),
			}),
		);
	});

	it("executeIssueChatRequest emits creating and completed progress when issue creation succeeds", async () => {
		const { chatIssueViaLLM } = await import("../../app/commands/issue-chat.js");
		vi.mocked(chatIssueViaLLM).mockResolvedValueOnce({
			shouldCreate: true,
			owner: "mbrooks",
			repo: "tars",
			draft: { title: "Chat Title", body: "Chat Body", labels: ["bug"], assignees: ["mbrooks"] },
			message: "Created",
			readyToCreate: true,
		});
		const onProgress = vi.fn();

		const response = await executeIssueChatRequest(
			deps,
			{ messages: [{ role: "user", text: "create it" }] },
			onProgress,
		);

		expect(response.createdIssue).toEqual({
			number: 99,
			html_url: "https://github.com/mbrooks/tars/issues/99",
		});
		expect(onProgress).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				type: "creating",
				message: "Creating issue in mbrooks/tars...",
			}),
		);
		expect(onProgress).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				type: "completed",
				response: expect.objectContaining({
					createdIssue: {
						number: 99,
						html_url: "https://github.com/mbrooks/tars/issues/99",
					},
				}),
			}),
		);
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
});
