import { describe, expect, it, vi } from "vitest";
import http from "node:http";
import { handleOnboardingRoutes } from "./onboarding-routes.js";
import { SettingsStore } from "../../../settings/store.js";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function tmpStore(): Promise<SettingsStore> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "tars-onboarding-"));
	return new SettingsStore(path.join(dir, "settings.sqlite"));
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

function makeDeps(store?: SettingsStore) {
	return {
		adminAssetsDir: "/tmp/admin-assets",
		settingsStore: store,
		getAdminStatus: { execute: vi.fn() },
		getSession: {} as never,
		getSessionLog: { execute: vi.fn() },
		runSessionCommand: { execute: vi.fn() },
		taskController: {
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
			cancel: vi.fn(),
			isActive: vi.fn(() => false),
			register: vi.fn(),
			unregister: vi.fn(),
		},
	} as never;
}

describe("handleOnboardingRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const handled = await handleOnboardingRoutes(
			{ method: "GET", url: "/api/other", headers: {} } as never,
			{} as never,
			{ adminAssetsDir: "/tmp" } as never,
			"/api/other",
		);

		expect(handled).toBe(false);
	});

	describe("GET /api/onboarding/status", () => {
		it("returns complete false when settings are missing", async () => {
			const store = await tmpStore();
			const req = mockRequest({ url: "/api/onboarding/status", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/status");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.complete).toBe(false);
			expect(body.missing.length).toBeGreaterThan(0);
		});

		it("returns complete true when all required settings are present", async () => {
			const store = await tmpStore();
			store.set("github_token", "tok");
			store.set("github_username", "user");
			store.set("webhook_secret", "shh");
			store.set("admin_username", "admin");
			store.set("admin_password", "pass");
			const req = mockRequest({ url: "/api/onboarding/status", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/status");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.complete).toBe(true);
			expect(body.missing).toEqual([]);
		});
	});

	describe("POST /api/onboarding/verify-token", () => {
		it("returns username for a valid token", async () => {
			const req = mockRequest({
				url: "/api/onboarding/verify-token",
				method: "POST",
				body: JSON.stringify({ token: "ghp_test" }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(), "/api/onboarding/verify-token");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBeDefined();
		});

		it("rejects missing token", async () => {
			const req = mockRequest({
				url: "/api/onboarding/verify-token",
				method: "POST",
				body: JSON.stringify({}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(), "/api/onboarding/verify-token");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("Token is required");
		});
	});

	describe("POST /api/onboarding/generate-secret", () => {
		it("returns a secret of at least 128 characters", async () => {
			const req = mockRequest({ url: "/api/onboarding/generate-secret", method: "POST" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(), "/api/onboarding/generate-secret");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(typeof body.secret).toBe("string");
			expect(body.secret.length).toBeGreaterThanOrEqual(128);
		});
	});

	describe("POST /api/onboarding/repos", () => {
		it("rejects missing token", async () => {
			const req = mockRequest({
				url: "/api/onboarding/repos",
				method: "POST",
				body: JSON.stringify({}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(), "/api/onboarding/repos");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("Token is required");
		});

		it("returns repositories for a valid-looking token", async () => {
			const req = mockRequest({
				url: "/api/onboarding/repos",
				method: "POST",
				body: JSON.stringify({ token: "ghp_test" }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(), "/api/onboarding/repos");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.repositories).toEqual([]);
		});
	});

	describe("POST /api/onboarding/init-workspaces", () => {
		it("rejects when token or username is missing", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding/init-workspaces",
				method: "POST",
				body: JSON.stringify({ token: "tok" }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/init-workspaces");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("Token and username are required");
		});

		it("returns empty initialized list when no repos provided", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding/init-workspaces",
				method: "POST",
				body: JSON.stringify({ token: "tok", username: "user", repos: [] }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/init-workspaces");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.initialized).toEqual([]);
		});

		it("attempts to initialize provided repos", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding/init-workspaces",
				method: "POST",
				body: JSON.stringify({
					token: "ghp_fake",
					username: "user",
					repos: [{ owner: "mbrooks", repo: "tars" }],
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/init-workspaces");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(Array.isArray(body.initialized)).toBe(true);
		});

		it("returns 500 when settingsStore is missing", async () => {
			const req = mockRequest({
				url: "/api/onboarding/init-workspaces",
				method: "POST",
				body: JSON.stringify({ token: "tok", username: "user", repos: [] }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(), "/api/onboarding/init-workspaces");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("Settings store not configured");
		});
	});

	describe("POST /api/onboarding", () => {
		it("returns success when all fields provided", async () => {
			const store = await tmpStore();
			const onOnboardingComplete = vi.fn();
			const deps = {
				...(makeDeps(store) as object),
				onOnboardingComplete,
			} as never;
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({
					github_token: "tok",
					github_username: "user",
					webhook_secret: "shh",
					admin_username: "admin",
					admin_password: "pass",
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, deps, "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body).toEqual({ success: true, activated: true, requiresRestart: [] });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(onOnboardingComplete).toHaveBeenCalledTimes(1);
		});

		it("returns error when fields are missing", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({ github_token: "tok" }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("Missing required fields");
		});

		it("returns 500 when settingsStore is missing", async () => {
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({
					github_token: "tok",
					github_username: "user",
					webhook_secret: "shh",
					admin_username: "admin",
					admin_password: "pass",
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(), "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("Settings store not configured");
		});

		it("handles invalid JSON", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: "not json",
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toBeDefined();
		});
	});

	describe("GET /tarsadmin", () => {
		it("returns HTML", async () => {
			const req = mockRequest({ url: "/tarsadmin", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(), "/tarsadmin");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
		});
		});
});
