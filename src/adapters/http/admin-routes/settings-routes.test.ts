import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleSettingsRoutes } from "./settings-routes.js";

function request(url: string, method = "GET", body?: string): http.IncomingMessage {
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

function makeDeps(overrides: Record<string, unknown> = {}) {
	return {
		sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never,
		settingsStore: {
			getAllViews: vi.fn(() => ({})),
			setTyped: vi.fn(),
			getString: vi.fn((key: string, defaultValue: string) => defaultValue),
			get: vi.fn(),
		},
		githubService: {
			listPendingInvitations: vi.fn(async () => []),
			acceptInvitation: vi.fn(async () => undefined),
		},
		...overrides,
	} as any;
}

describe("handleSettingsRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const handled = await handleSettingsRoutes(
			{ method: "GET", url: "/api/other", headers: {} } as never,
			response(),
			{} as never,
			"/api/other",
		);

		expect(handled).toBe(false);
	});

	it("returns 503 when settings store is missing for GET settings", async () => {
		const res = response();
		const handled = await handleSettingsRoutes(
			request("/api/settings"),
			res,
			{ sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never } as never,
			"/api/settings",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toContain("Settings store not configured");
	});

	it("lists all settings", async () => {
		const res = response();
		const deps = makeDeps({
			settingsStore: {
				getAllViews: vi.fn(() => ({ theme: "dark" })),
			},
		});
		const handled = await handleSettingsRoutes(request("/api/settings"), res, deps, "/api/settings");

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).settings).toEqual({ theme: "dark" });
	});

	it("updates settings and tracks restart requirements", async () => {
		const res = response();
		const deps = makeDeps();
		const handled = await handleSettingsRoutes(
			request("/api/settings", "PATCH", JSON.stringify({ github_username: "x", github_token: "" })),
			res,
			deps,
			"/api/settings",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.updated).toContain("github_username");
		expect(body.updated).not.toContain("github_token");
		expect(body.requiresRestart).toContain("github_username");
	});

	it("lists pending GitHub invitations", async () => {
		const res = response();
		const deps = makeDeps({
			githubService: {
				listPendingInvitations: vi.fn(async () => [{ id: 1 }]),
			},
		});
		const handled = await handleSettingsRoutes(request("/api/github/invitations"), res, deps, "/api/github/invitations");

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).invitations).toHaveLength(1);
	});

	it("returns 500 when github service is missing for invitations", async () => {
		const res = response();
		const handled = await handleSettingsRoutes(
			request("/api/github/invitations"),
			res,
			{ sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never } as never,
			"/api/github/invitations",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("accepts a GitHub invitation", async () => {
		const res = response();
		const deps = makeDeps();
		const handled = await handleSettingsRoutes(
			request("/api/github/invitations/42/accept", "POST"),
			res,
			deps,
			"/api/github/invitations/42/accept",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(deps.githubService.acceptInvitation).toHaveBeenCalledWith(42);
	});

	it("returns 500 when github service is missing for accepting invitations", async () => {
		const res = response();
		const handled = await handleSettingsRoutes(
			request("/api/github/invitations/42/accept", "POST"),
			res,
			{ sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never } as any,
			"/api/github/invitations/42/accept",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("returns 400 for an invalid invitation id", async () => {
		const res = response();
		const deps = makeDeps();
		const handled = await handleSettingsRoutes(
			request("/api/github/invitations/abc/accept", "POST"),
			res,
			deps,
			"/api/github/invitations/abc/accept",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});
});
