import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { unlinkSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { handleAdminRoute } from "./admin-router.js";
import { SettingsStore } from "../../settings/store.js";
import { AdminSessionAuth } from "./admin-auth.js";
import { UserStore } from "../../users/store.js";

const TEST_DB = "/tmp/yolomatic-admin-router-test.sqlite";

vi.mock("./asset-server.js", () => ({
	adminHtml: vi.fn(async () => "<html></html>"),
	serveAdminAsset: vi.fn(async (_res: http.ServerResponse, _dir: string, _path: string) => {
		// no-op: caller already handles response
	}),
}));

const VALID_COOKIE = "yolomatic_admin_session=valid";
function hasValidCookie(req: http.IncomingMessage): boolean {
	return typeof req.headers.cookie === "string" && req.headers.cookie.includes("yolomatic_admin_session=");
}
const sessionAuth = {
	requireAdminJson: (req: http.IncomingMessage, res: http.ServerResponse) => {
		if (hasValidCookie(req)) return true;
		res.statusCode = 401;
		res.setHeader("content-type", "application/json");
		res.end('{"error":"Unauthorized"}');
		return false;
	},
	requireAdminJsonAllowBasic: (req: http.IncomingMessage, res: http.ServerResponse) => {
		if (hasValidCookie(req)) return true;
		res.statusCode = 401;
		res.setHeader("content-type", "application/json");
		res.end('{"error":"Unauthorized"}');
		return false;
	},
	requireAdminText: (req: http.IncomingMessage, res: http.ServerResponse) => {
		if (hasValidCookie(req)) return true;
		res.statusCode = 401;
		res.end("Unauthorized");
		return false;
	},
	isAdminAuthorized: (req: http.IncomingMessage) => hasValidCookie(req),
	hasUsers: () => true,
} as never;

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

describe.sequential("handleAdminRoute", () => {
	let store: SettingsStore;
	let deps: Parameters<typeof handleAdminRoute>[2];
	let githubService: {
		listOpenIssues: ReturnType<typeof vi.fn>;
		listPendingInvitations: ReturnType<typeof vi.fn>;
		acceptInvitation: ReturnType<typeof vi.fn>;
		updateIssueAssignees: ReturnType<typeof vi.fn>;
		getAuthenticatedUser: ReturnType<typeof vi.fn>;
		listAccessibleRepositories: ReturnType<typeof vi.fn>;
	};

	let onboardingHasUsers = false;

	beforeEach(() => {
		onboardingHasUsers = false;
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
		store = new SettingsStore(TEST_DB);
		githubService = {
			listOpenIssues: vi.fn(async () => []),
			listPendingInvitations: vi.fn(async () => []),
			acceptInvitation: vi.fn(async () => undefined),
			updateIssueAssignees: vi.fn(async () => undefined),
			getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
			listAccessibleRepositories: vi.fn(async () => []),
		};
		deps = {
			sessionAuth,
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
			githubService: githubService as never,
			startIssueSession: {
				execute: vi.fn(async () => ({
					success: true as const,
					data: { started: true, status: "working", message: "ok" },
				})),
			} as never,
			userStore: {
				hasAnySync: () => onboardingHasUsers,
				firstSync: () =>
					onboardingHasUsers
						? { id: "u1", fullName: "Admin", username: "admin", passwordHash: "", createdAt: "", updatedAt: "" }
						: null,
				createSync: vi.fn(() => {
					onboardingHasUsers = true;
					return { id: "u1", fullName: "Admin", username: "admin", passwordHash: "", createdAt: "", updatedAt: "" };
				}),
				updateFullNameSync: vi.fn(() => null),
				updatePasswordSync: vi.fn(() => null),
				listSync: vi.fn(() => []),
				getByIdSync: vi.fn(() => null),
				getByUsernameSync: vi.fn(() => null),
				deleteSync: vi.fn(() => true),
			} as never,
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
			headers: { cookie: "yolomatic_admin_session=valid" },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(false);
	});

	it("GET /api/onboarding/status returns missing fields", async () => {
		const req = mockRequest({
			url: "/api/onboarding/status",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
			method: "PATCH",
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: JSON.stringify({ description: "Updated description" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(getRepoSkill).toHaveBeenCalledWith("mbrooks", "yolomatic", "triage");
		expect(saveRepoSkill).toHaveBeenCalledWith("mbrooks", "yolomatic", {
			name: "triage",
			description: "Updated description",
			content: "Existing body",
		});
	});

	it("POST /api/onboarding creates settings", async () => {
		const req = mockRequest({
			url: "/api/onboarding",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: JSON.stringify({
				github_token: "tok",
				github_username: "user",
				webhook_secret: "shh",
				admin_full_name: "Admin User",
				admin_username: "admin",
				admin_password: "pass",
				github_event_mode: "webhook",
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

	it("GET /yolomatic/admin returns HTML when credentials configured", async () => {
		const req = mockRequest({
			url: "/yolomatic/admin",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(String(res.body)).toContain("<html>");
	});

	it("GET /yolomatic/admin/assets/main.js serves asset", async () => {
		const req = mockRequest({
			url: "/yolomatic/admin/assets/main.js",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
							repo: "yolomatic",
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/sessions/mbrooks/yolomatic/1/implementation/log",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/sessions/mbrooks/yolomatic/1/implementation/commands",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: JSON.stringify({ command: "stop" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.acknowledged).toBe(true);
	});











	it("GET /api/settings blanks sensitive values", async () => {
		store.set("github_token", "supersecret");
		store.set("github_username", "yolomatic");

		const req = mockRequest({
			url: "/api/settings",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
		expect(userView.value).toBe("yolomatic");
		expect(userView.sensitive).toBe(false);
	});

	it("PATCH /api/settings updates non-sensitive fields", async () => {
		store.set("github_username", "old");

		const req = mockRequest({
			url: "/api/settings",
			method: "PATCH",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: JSON.stringify({ github_token: "tok" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("Missing required field");
	});

	it("POST /api/maintenance rejects invalid body", async () => {
		const req = mockRequest({
			url: "/api/maintenance",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/sessions/mbrooks/yolomatic/1/implementation/log",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("POST /api/sessions/:owner/:repo/:issue/commands rejects missing command", async () => {
		const req = mockRequest({
			url: "/api/sessions/mbrooks/yolomatic/1/implementation/commands",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/sessions/mbrooks/yolomatic/1/implementation/commands",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: JSON.stringify({ command: "stop" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});










	it("POST /api/onboarding rejects invalid JSON", async () => {
		const req = mockRequest({
			url: "/api/onboarding",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: JSON.stringify({ port: 8080 }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, noStoreDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Settings store not configured");
	});






	it("GET /api/onboarding/status returns 500 when settingsStore missing", async () => {
		const noStoreDeps = { ...deps, settingsStore: undefined };
		const req = mockRequest({
			url: "/api/onboarding/status",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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

	it("GET /yolomatic/admin allows access without a session during onboarding", async () => {
		const req = mockRequest({
			url: "/yolomatic/admin",
			method: "GET",
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
	});









	it("GET /api/settings returns 500 when settingsStore missing", async () => {
		const noStoreDeps = { ...deps, settingsStore: undefined };
		const req = mockRequest({
			url: "/api/settings",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
		store.set("github_event_mode", "webhook");
		store.set("onboarding_complete", "true");
		onboardingHasUsers = true;

		const req = mockRequest({
			url: "/api/onboarding/status",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("disk error");
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
							repo: "yolomatic",
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/sessions/mbrooks/yolomatic/1/unknown",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("POST /api/sessions/:owner/:repo/:issue/unknown returns 404", async () => {
		const req = mockRequest({
			url: "/api/sessions/mbrooks/yolomatic/1/unknown",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: JSON.stringify({ command: "stop" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("GET /yolomatic/admin serves HTML without a session", async () => {
		const req = mockRequest({
			url: "/yolomatic/admin",
			method: "GET",
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
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: "not json",
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills",
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
			url: "/api/repos/mbrooks/yolomatic/skills",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills",
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
			url: "/api/repos/mbrooks/yolomatic/skills",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: "not-json",
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	it("POST /api/repos/:owner/:repo/skills returns 500 when repoSkillService is missing", async () => {
		const req = mockRequest({
			url: "/api/repos/mbrooks/yolomatic/skills",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: JSON.stringify({ name: "triage", content: "# Triage" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, { ...deps, repoSkillService: undefined });
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("POST /api/repos/:owner/:repo/skills requires name and content", async () => {
		const req = mockRequest({
			url: "/api/repos/mbrooks/yolomatic/skills",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: JSON.stringify({ name: "triage" }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("Missing required field");
	});

	it("DELETE returns 401 when not admin", async () => {
		deps.repoSkillService = {
			listRepoSkills: vi.fn(async () => []),
			getRepoSkill: vi.fn(async () => null),
			saveRepoSkill: vi.fn(async () => ({ success: true })),
			deleteRepoSkill: vi.fn(async () => ({ success: true })),
		} as never;
		const req = mockRequest({
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
			method: "DELETE",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
			method: "DELETE",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
			method: "DELETE",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
			method: "DELETE",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
			method: "PATCH",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
			method: "PATCH",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
			method: "PATCH",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills/extra/path",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
			method: "PATCH",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
			method: "PATCH",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/skills/triage",
			method: "PATCH",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			{ number: 1, title: "Bug", body: "desc", state: "open", labels: ["bug"], assignees: ["mbrooks"], html_url: "https://github.com/mbrooks/yolomatic/issues/1" },
		]);
		const req = mockRequest({
			url: "/api/repos/mbrooks/yolomatic/issues",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.issues).toHaveLength(1);
		expect(body.issues[0].number).toBe(1);
		expect(githubService.listOpenIssues).toHaveBeenCalledWith("mbrooks", "yolomatic");
	});

	it("GET /api/repos/:owner/:repo/issues returns 500 when githubService missing", async () => {
		const noGhDeps = { ...deps, githubService: undefined };
		const req = mockRequest({
			url: "/api/repos/mbrooks/yolomatic/issues",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			url: "/api/repos/mbrooks/yolomatic/issues",
			method: "GET",
			headers: { cookie: "yolomatic_admin_session=valid" },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toContain("Network error");
	});

	it("POST /api/repos/:owner/:repo/issues/:number/assign assigns to Yolomatic username", async () => {
		store.set("github_username", "yolomatic-bot");
		const req = mockRequest({
			url: "/api/repos/mbrooks/yolomatic/issues/42/assign",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(202);
		const body = JSON.parse(String(res.body));
		expect(body.started).toBe(true);
		expect(body.status).toBe("queued");
		expect(githubService.updateIssueAssignees).toHaveBeenCalledWith("mbrooks", "yolomatic", 42, ["yolomatic-bot"]);
		expect(deps.startIssueSession!.execute).toHaveBeenCalledWith("mbrooks", "yolomatic", 42, "Bug", "desc", ["bug"]);
	});

	it("POST /api/repos/:owner/:repo/issues/:number/assign returns 500 when githubService missing", async () => {
		const noGhDeps = { ...deps, githubService: undefined };
		const req = mockRequest({
			url: "/api/repos/mbrooks/yolomatic/issues/42/assign",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] }),
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
			url: "/api/repos/mbrooks/yolomatic/issues/42/assign",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] }),
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
			url: "/api/repos/mbrooks/yolomatic/issues/42/assign",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] }),
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Yolomatic GitHub username not configured");
	});

	it("POST /api/repos/:owner/:repo/issues/:number/assign handles service error", async () => {
		store.set("github_username", "yolomatic-bot");
		githubService.updateIssueAssignees.mockRejectedValue(new Error("API error"));
		const req = mockRequest({
			url: "/api/repos/mbrooks/yolomatic/issues/42/assign",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
			body: JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] }),
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
			url: "/api/repos/mbrooks/yolomatic/issues/abc/assign",
			method: "POST",
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
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
			headers: { cookie: "yolomatic_admin_session=valid" },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, deps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		const body = JSON.parse(String(res.body));
		expect(body.error).toBe("Invalid invitation ID");
	});
});

describe.sequential("handleAdminRoute — Basic Auth route scoping", () => {
	let userStore: UserStore;
	let realDeps: Parameters<typeof handleAdminRoute>[2];

	beforeEach(async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-admin-router-basic-"));
		userStore = new UserStore(path.join(dir, "users.sqlite"));
		userStore.createSync({ fullName: "Admin", username: "admin", password: "secret" });
		realDeps = {
			sessionAuth: new AdminSessionAuth(userStore),
			adminAssetsDir: "/tmp/admin-assets",
			userStore,
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
				execute: vi.fn(async () => ({ success: true as const, data: { entries: [] } })),
			} as never,
			runSessionCommand: {
				execute: vi.fn(async () => ({ success: true as const, data: { acknowledged: true } })),
			} as never,
			taskController: {
				isDraining: vi.fn(() => false),
				setDraining: vi.fn(),
				cancel: vi.fn(),
				isActive: vi.fn(() => false),
				register: vi.fn(),
				unregister: vi.fn(),
			} as never,
		} as never;
	});

	it("GET /api/users with valid Basic credentials but no cookie returns 401 (Basic not enabled)", async () => {
		const req = mockRequest({
			url: "/api/users",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, realDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("GET /api/users with a valid session cookie still succeeds", async () => {
		const loginReq = mockRequest({
			url: "/api/users",
			method: "GET",
			headers: { socket: { encrypted: false } } as never,
		});
		const loginRes = mockResponse();
		const auth = realDeps.sessionAuth as unknown as AdminSessionAuth;
		auth.login(loginReq as never, loginRes as never, "admin", "secret");
		const setCookie = String((loginRes.setHeader as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "Set-Cookie")?.[1]);
		const cookie = setCookie.split(";")[0];
		const req = mockRequest({
			url: "/api/users",
			method: "GET",
			headers: { cookie },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, realDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(Array.isArray(body.users)).toBe(true);
	});

	it("GET /api/status/working with valid Basic credentials returns 200 (Basic enabled)", async () => {
		const req = mockRequest({
			url: "/api/status/working",
			method: "GET",
			headers: { authorization: makeBasicAuth("admin", "secret") },
		});
		const res = mockResponse();

		const handled = await handleAdminRoute(req, res, realDeps);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(String(res.body));
		expect(body.working).toBe(false);
	});
});
