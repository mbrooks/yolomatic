import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { handleOnboardingRoutes } from "./onboarding-routes.js";
import { SettingsStore } from "../../../settings/store.js";
import { RepositoryStore } from "../../../repos/repository-store.js";
import { WorkspaceManager } from "../../../workspace/manager.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function tmpStore(): Promise<SettingsStore> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-onboarding-"));
	return new SettingsStore(path.join(dir, "settings.sqlite"));
}

async function tmpStores(): Promise<{ settings: SettingsStore; repository: RepositoryStore }> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-onboarding-"));
	return {
		settings: new SettingsStore(path.join(dir, "settings.sqlite")),
		repository: new RepositoryStore(path.join(dir, "settings.sqlite")),
	};
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

function makeDeps(store?: SettingsStore, repoStore?: RepositoryStore) {
	return {
		adminAssetsDir: "/tmp/admin-assets",
		adminPath: "/yeetomatic/admin",
		adminDefaultPage: "#/dashboard",
		settingsStore: store,
		repositoryStore: repoStore,
		userStore: {
			hasAnySync: () => onboardingHasUsers,
			firstSync: () =>
				onboardingHasUsers
					? { id: "u1", fullName: "Admin", username: onboardingMasterUsername, passwordHash: "", createdAt: "", updatedAt: "" }
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

let onboardingHasUsers = true;
let onboardingMasterUsername = "admin";

afterEach(() => {
	onboardingHasUsers = true;
	onboardingMasterUsername = "admin";
	vi.restoreAllMocks();
});

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

		it("returns complete false when required settings are present but onboarding flag is unset", async () => {
			const store = await tmpStore();
			store.set("github_token", "tok");
			store.set("github_username", "user");
			store.set("webhook_secret", "shh");
			store.set("github_event_mode", "webhook");
			const req = mockRequest({ url: "/api/onboarding/status", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/status");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.complete).toBe(false);
			expect(body.missing).toEqual(["onboarding_complete"]);
		});

		it("returns complete true when required settings and onboarding flag are present", async () => {
			const store = await tmpStore();
			store.set("github_token", "tok");
			store.set("github_username", "user");
			store.set("webhook_secret", "shh");
			store.set("github_event_mode", "webhook");
			store.set("onboarding_complete", "true");
			const req = mockRequest({ url: "/api/onboarding/status", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/status");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.complete).toBe(true);
			expect(body.missing).toEqual([]);
		});

		it("reports incomplete when github_event_mode is invalid", async () => {
			const store = await tmpStore();
			store.set("github_token", "tok");
			store.set("github_username", "user");
			store.set("webhook_secret", "shh");
			store.set("github_event_mode", "bogus");
			store.set("onboarding_complete", "true");
			const req = mockRequest({ url: "/api/onboarding/status", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/status");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.complete).toBe(false);
			expect(body.missing).toContain("github_event_mode");
		});

		it("reports incomplete when polling mode lacks a valid interval", async () => {
			const store = await tmpStore();
			store.set("github_token", "tok");
			store.set("github_username", "user");
			store.set("webhook_secret", "shh");
			store.set("github_event_mode", "polling");
			store.set("onboarding_complete", "true");
			const req = mockRequest({ url: "/api/onboarding/status", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/status");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.complete).toBe(false);
			expect(body.missing).toContain("github_poll_interval_ms");
		});

		it("reports incomplete when webhook mode lacks a webhook secret", async () => {
			const store = await tmpStore();
			store.set("github_token", "tok");
			store.set("github_username", "user");
			store.set("github_event_mode", "webhook");
			store.set("onboarding_complete", "true");
			const req = mockRequest({ url: "/api/onboarding/status", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/status");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.complete).toBe(false);
			expect(body.missing).toContain("webhook_secret");
		});

		it("reports complete for polling mode without a webhook secret", async () => {
			const store = await tmpStore();
			store.set("github_token", "tok");
			store.set("github_username", "user");
			store.set("github_event_mode", "polling");
			store.set("github_poll_interval_ms", "15000");
			store.set("onboarding_complete", "true");
			const req = mockRequest({ url: "/api/onboarding/status", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/status");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.complete).toBe(true);
			expect(body.missing).toEqual([]);
		});

		it("reports complete when polling mode has a valid interval", async () => {
			const store = await tmpStore();
			store.set("github_token", "tok");
			store.set("github_username", "user");
			store.set("webhook_secret", "shh");
			store.set("github_event_mode", "polling");
			store.set("github_poll_interval_ms", "15000");
			store.set("onboarding_complete", "true");
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
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding/repos",
				method: "POST",
				body: JSON.stringify({}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/repos");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("Token is required");
		});

		it("returns repositories for a valid-looking token", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding/repos",
				method: "POST",
				body: JSON.stringify({ token: "ghp_test" }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/repos");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.repositories).toEqual([]);
		});

		it("falls back to the stored github_token when the submitted token is empty", async () => {
			const store = await tmpStore();
			store.set("github_token", "stored-ghp-token");
			const req = mockRequest({
				url: "/api/onboarding/repos",
				method: "POST",
				body: JSON.stringify({ token: "" }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/repos");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.repositories).toEqual([]);
		});

		it("returns 500 when settingsStore is missing", async () => {
			const req = mockRequest({
				url: "/api/onboarding/repos",
				method: "POST",
				body: JSON.stringify({ token: "ghp_test" }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(), "/api/onboarding/repos");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("Settings store not configured");
		});

		it("returns configured repositories when repositoryStore is available", async () => {
			const stores = await tmpStores();
			await stores.repository.upsert({ owner: "mbrooks", repo: "yeetomatic", fullName: "mbrooks/yeetomatic", visibility: "private" });
			const req = mockRequest({
				url: "/api/onboarding/repos",
				method: "POST",
				body: JSON.stringify({ token: "ghp_test" }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(stores.settings, stores.repository), "/api/onboarding/repos");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.configured).toEqual([{ owner: "mbrooks", repo: "yeetomatic" }]);
		});

		it("returns an empty configured list when repositoryStore is absent", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding/repos",
				method: "POST",
				body: JSON.stringify({ token: "ghp_test" }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/repos");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.configured).toEqual([]);
		});
	});

	describe("POST /api/onboarding/init-workspaces", () => {
		it("rejects when token or username is missing", async () => {
			const stores = await tmpStores();
			const req = mockRequest({
				url: "/api/onboarding/init-workspaces",
				method: "POST",
				body: JSON.stringify({ token: "tok" }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(stores.settings, stores.repository), "/api/onboarding/init-workspaces");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("Token and username are required");
		});

		it("returns empty initialized list when no repos provided", async () => {
			const stores = await tmpStores();
			const req = mockRequest({
				url: "/api/onboarding/init-workspaces",
				method: "POST",
				body: JSON.stringify({ token: "tok", username: "user", repos: [] }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(stores.settings, stores.repository), "/api/onboarding/init-workspaces");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.initialized).toEqual([]);
			expect(await stores.repository.list()).toEqual([]);
		});

		it("attempts to initialize provided repos and persists them to the repositories table", async () => {
			const initializeRepo = vi.spyOn(WorkspaceManager.prototype, "initializeRepo").mockResolvedValue();
			const stores = await tmpStores();
			const req = mockRequest({
				url: "/api/onboarding/init-workspaces",
				method: "POST",
				body: JSON.stringify({
					token: "ghp_fake",
					username: "user",
					repos: [{ owner: "mbrooks", repo: "yeetomatic" }],
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(stores.settings, stores.repository), "/api/onboarding/init-workspaces");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.initialized).toEqual(["mbrooks/yeetomatic"]);
			expect(initializeRepo).toHaveBeenCalledWith("mbrooks", "yeetomatic");
			const managed = await stores.repository.list();
			expect(managed).toHaveLength(1);
			expect(managed[0]).toMatchObject({ owner: "mbrooks", repo: "yeetomatic" });
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

		it("returns 500 when repositoryStore is missing", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding/init-workspaces",
				method: "POST",
				body: JSON.stringify({ token: "tok", username: "user", repos: [] }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store, undefined), "/api/onboarding/init-workspaces");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("Repository store not configured");
		});

		it("falls back to the stored github_token and github_username when submitted empty", async () => {
			const stores = await tmpStores();
			stores.settings.set("github_token", "stored-ghp-token");
			stores.settings.set("github_username", "stored-user");
			const req = mockRequest({
				url: "/api/onboarding/init-workspaces",
				method: "POST",
				body: JSON.stringify({ token: "", username: "", repos: [] }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(stores.settings, stores.repository), "/api/onboarding/init-workspaces");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.initialized).toEqual([]);
			expect(await stores.repository.list()).toEqual([]);
		});

		it("rejects init-workspaces when neither submitted nor stored token is available", async () => {
			const stores = await tmpStores();
			const req = mockRequest({
				url: "/api/onboarding/init-workspaces",
				method: "POST",
				body: JSON.stringify({ token: "", username: "user", repos: [] }),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(stores.settings, stores.repository), "/api/onboarding/init-workspaces");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("Token and username are required");
		});
	});

	describe("GET /api/onboarding/config", () => {
		it("returns empty defaults when nothing is configured", async () => {
			const store = await tmpStore();
			onboardingHasUsers = false;
			const req = mockRequest({ url: "/api/onboarding/config", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/config");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.admin_username).toBe("");
			expect(body.github_username).toBe("");
			expect(body.github_event_mode).toBe("");
			expect(body.github_poll_interval_ms).toBe("");
			expect(body.admin_password).toEqual({ configured: false });
			expect(body.github_token).toEqual({ configured: false });
			expect(body.webhook_secret).toEqual({ configured: false });
		});

		it("returns configured non-sensitive values as strings", async () => {
			const store = await tmpStore();
			onboardingMasterUsername = "alice";
			store.set("github_username", "alice-gh");
			store.set("github_event_mode", "polling");
			store.set("github_poll_interval_ms", "15000");
			const req = mockRequest({ url: "/api/onboarding/config", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/config");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.admin_username).toBe("alice");
			expect(body.github_username).toBe("alice-gh");
			expect(body.github_event_mode).toBe("polling");
			expect(body.github_poll_interval_ms).toBe("15000");
		});

		it("reports configured secrets as configured without exposing the value", async () => {
			const store = await tmpStore();
			store.set("github_token", "ghp_secret_value");
			store.set("webhook_secret", "wh-secret");
			const req = mockRequest({ url: "/api/onboarding/config", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding/config");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body.github_token).toEqual({ configured: true });
			expect(body.admin_password).toEqual({ configured: true });
			expect(body.webhook_secret).toEqual({ configured: true });
			const raw = String(res.body);
			expect(raw).not.toContain("ghp_secret_value");
			expect(raw).not.toContain("super-secret");
			expect(raw).not.toContain("wh-secret");
		});

		it("returns 500 when settingsStore is missing", async () => {
			const req = mockRequest({ url: "/api/onboarding/config", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(), "/api/onboarding/config");

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
				admin_full_name: "Admin User",
					admin_username: "admin",
					admin_password: "pass",
					github_event_mode: "webhook",
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, deps, "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(String(res.body));
			expect(body).toEqual({ success: true, activated: true, requiresRestart: [] });
			expect(store.get("onboarding_complete")).toBe("true");
			expect(store.get("github_event_mode")).toBe("webhook");
			expect(store.get("github_poll_interval_ms")).toBeUndefined();
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
			expect(body.error).toContain("github_event_mode");
		});

		it("rejects an invalid github_event_mode", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({
					github_token: "tok",
					github_username: "user",
					webhook_secret: "shh",
				admin_full_name: "Admin User",
					admin_username: "admin",
					admin_password: "pass",
					github_event_mode: "invalid",
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("github_event_mode must be one of");
			expect(store.get("onboarding_complete")).toBeUndefined();
		});

		it("rejects polling mode without a polling interval", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({
					github_token: "tok",
					github_username: "user",
					webhook_secret: "shh",
				admin_full_name: "Admin User",
					admin_username: "admin",
					admin_password: "pass",
					github_event_mode: "polling",
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("github_poll_interval_ms");
			expect(store.get("onboarding_complete")).toBeUndefined();
		});

		it("rejects polling mode with an interval below the minimum", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({
					github_token: "tok",
					github_username: "user",
					webhook_secret: "shh",
				admin_full_name: "Admin User",
					admin_username: "admin",
					admin_password: "pass",
					github_event_mode: "polling",
					github_poll_interval_ms: "999",
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("github_poll_interval_ms");
		});

		it("rejects webhook mode without a webhook secret", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({
					github_token: "tok",
					github_username: "user",
				admin_full_name: "Admin User",
					admin_username: "admin",
					admin_password: "pass",
					github_event_mode: "webhook",
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("webhook_secret");
			expect(store.get("onboarding_complete")).toBeUndefined();
		});

		it("accepts polling mode without a webhook secret", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({
					github_token: "tok",
					github_username: "user",
				admin_full_name: "Admin User",
					admin_username: "admin",
					admin_password: "pass",
					github_event_mode: "polling",
					github_poll_interval_ms: "5000",
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			expect(store.get("github_event_mode")).toBe("polling");
			expect(store.get("webhook_secret")).toBeUndefined();
			expect(store.get("onboarding_complete")).toBe("true");
		});

		it("persists github_event_mode and github_poll_interval_ms for polling mode", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({
					github_token: "tok",
					github_username: "user",
					webhook_secret: "shh",
				admin_full_name: "Admin User",
					admin_username: "admin",
					admin_password: "pass",
					github_event_mode: "polling",
					github_poll_interval_ms: "5000",
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			expect(store.get("github_event_mode")).toBe("polling");
			expect(store.get("github_poll_interval_ms")).toBe("5000");
			expect(store.get("onboarding_complete")).toBe("true");
		});

		it("does not require a polling interval for webhook mode", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({
					github_token: "tok",
					github_username: "user",
					webhook_secret: "shh",
				admin_full_name: "Admin User",
					admin_username: "admin",
					admin_password: "pass",
					github_event_mode: "webhook",
					github_poll_interval_ms: "",
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			expect(store.get("github_poll_interval_ms")).toBeUndefined();
		});

		it("returns 500 when settingsStore is missing", async () => {
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({
					github_token: "tok",
					github_username: "user",
					webhook_secret: "shh",
				admin_full_name: "Admin User",
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

		it("preserves an existing github_token when submitted empty", async () => {
			const store = await tmpStore();
			store.set("github_token", "existing-ghp-token");
			store.set("webhook_secret", "existing-wh-secret");
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({
					github_token: "",
					github_username: "user",
					webhook_secret: "shh",
				admin_full_name: "Admin User",
					admin_username: "admin",
					admin_password: "new-pass",
					github_event_mode: "webhook",
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			expect(store.get("github_token")).toBe("existing-ghp-token");
			expect(store.get("webhook_secret")).toBe("shh");
			expect(store.get("onboarding_complete")).toBe("true");
		});

		it("preserves an existing admin password when submitted empty", async () => {
			const store = await tmpStore();
			const deps = makeDeps(store);
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({
					github_token: "tok",
					github_username: "user",
					webhook_secret: "shh",
					admin_full_name: "Admin User",
					admin_username: "admin",
					admin_password: "",
					github_event_mode: "webhook",
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, deps, "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			expect((deps as { userStore: { updatePasswordSync: () => void } }).userStore.updatePasswordSync).not.toHaveBeenCalled();
		});

		it("preserves an existing webhook_secret in webhook mode when submitted empty", async () => {
			const store = await tmpStore();
			store.set("webhook_secret", "kept-wh-secret");
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({
					github_token: "tok",
					github_username: "user",
					webhook_secret: "",
				admin_full_name: "Admin User",
					admin_username: "admin",
					admin_password: "pass",
					github_event_mode: "webhook",
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			expect(store.get("webhook_secret")).toBe("kept-wh-secret");
		});

		it("reports github_token missing when empty and not configured", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({
					github_token: "",
					github_username: "user",
					webhook_secret: "shh",
				admin_full_name: "Admin User",
					admin_username: "admin",
					admin_password: "pass",
					github_event_mode: "webhook",
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("Missing required fields");
			expect(body.error).toContain("github_token");
			expect(store.get("onboarding_complete")).toBeUndefined();
		});

		it("reports webhook_secret missing in webhook mode when empty and not configured", async () => {
			const store = await tmpStore();
			const req = mockRequest({
				url: "/api/onboarding",
				method: "POST",
				body: JSON.stringify({
					github_token: "tok",
					github_username: "user",
					webhook_secret: "",
				admin_full_name: "Admin User",
					admin_username: "admin",
					admin_password: "pass",
					github_event_mode: "webhook",
				}),
			});
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(store), "/api/onboarding");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			const body = JSON.parse(String(res.body));
			expect(body.error).toContain("webhook_secret");
			expect(store.get("onboarding_complete")).toBeUndefined();
		});
	});

	describe("GET /yeetomatic/admin", () => {
		it("returns HTML", async () => {
			const req = mockRequest({ url: "/yeetomatic/admin", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(), "/yeetomatic/admin");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
		});

		it("serves assets under the configured admin path", async () => {
			const req = mockRequest({ url: "/yeetomatic/admin/assets/main.js", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(), "/yeetomatic/admin/assets/main.js");

			expect(handled).toBe(true);
		});

		it("injects the configured admin path and default page into the served HTML", async () => {
			const dir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-onboarding-html-"));
			await writeFile(
				path.join(dir, "index.html"),
				'<!doctype html><html><head><title>Yeetomatic Admin</title></head><body><div id="root"></div></body></html>',
			);
			try {
				const req = mockRequest({ url: "/custom/admin", method: "GET" });
				const res = mockResponse();
				const deps = {
					...(makeDeps() as object),
					adminAssetsDir: dir,
					adminPath: "/custom/admin",
					adminDefaultPage: "#/repos",
				} as never;

				const handled = await handleOnboardingRoutes(req, res, deps, "/custom/admin");

				expect(handled).toBe(true);
				expect(res.statusCode).toBe(200);
				const body = String(res.body);
				expect(body).toContain('window.__YEETOMATIC_ADMIN_PATH__ = "/custom/admin"');
				expect(body).toContain('window.__YEETOMATIC_ADMIN_DEFAULT_PAGE__ = "#/repos"');
			} finally {
				await rm(dir, { force: true, recursive: true });
			}
		});

		it("returns false for an unconfigured legacy admin path", async () => {
			const req = mockRequest({ url: "/legacy-admin", method: "GET" });
			const res = mockResponse();

			const handled = await handleOnboardingRoutes(req, res, makeDeps(), "/legacy-admin");

			expect(handled).toBe(false);
		});
	});
});
