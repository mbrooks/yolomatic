import { describe, expect, it, vi } from "vitest";
import {
	AdminRouteRegistry,
	type AdminRouteContext,
	mapResultToStatus,
	checkAdminJson,
	checkAdminTextAllowOnboarding,
	requireDeps,
	getRequiredDeps,
	resolveAdminPath,
	resolveAdminDefaultPage,
} from "./admin-router-shared.js";

describe("admin-router-shared", () => {
	function mockResponse() {
		const res = {
			statusCode: 0,
			body: "",
			setHeader: vi.fn(),
			end: vi.fn((data?: string) => {
				res.body = data ?? "";
			}),
		} as {
			statusCode: number;
			body: string;
			setHeader: ReturnType<typeof vi.fn>;
			end: ReturnType<typeof vi.fn>;
		};
		return res;
	}

	it("maps unknown result codes to 500", () => {
		expect(mapResultToStatus("unexpected")).toBe(500);
	});

	it("maps known result codes", () => {
		expect(mapResultToStatus("not_found")).toBe(404);
		expect(mapResultToStatus("invalid_state")).toBe(400);
		expect(mapResultToStatus("unauthorized")).toBe(401);
		expect(mapResultToStatus("conflict")).toBe(409);
	});

	it("checkAdminJson returns 503 when sessionAuth is missing (onboarding mode)", () => {
		const request = { headers: {} } as never;
		const response = mockResponse();
		const result = checkAdminJson(request, response as never, {} as never);
		expect(result).toBe(false);
		expect(response.statusCode).toBe(503);
	});

	it("checkAdminJson delegates to sessionAuth when configured", () => {
		const request = { headers: {} } as never;
		const response = mockResponse();
		const result = checkAdminJson(request, response as never, {
			sessionAuth: { requireAdminJson: () => true } as never,
		} as never);
		expect(result).toBe(true);
	});

	it("checkAdminJson delegates to requireAdminJsonAllowBasic when allowBasicAuth is true", () => {
		const request = { headers: {} } as never;
		const response = mockResponse();
		const requireAdminJson = vi.fn(() => true);
		const requireAdminJsonAllowBasic = vi.fn(() => true);
		const result = checkAdminJson(request, response as never, {
			sessionAuth: { requireAdminJson, requireAdminJsonAllowBasic } as never,
		} as never, true);
		expect(result).toBe(true);
		expect(requireAdminJsonAllowBasic).toHaveBeenCalledTimes(1);
		expect(requireAdminJson).not.toHaveBeenCalled();
	});

	it("checkAdminJson with allowBasicAuth false uses requireAdminJson", () => {
		const request = { headers: {} } as never;
		const response = mockResponse();
		const requireAdminJson = vi.fn(() => true);
		const requireAdminJsonAllowBasic = vi.fn(() => true);
		const result = checkAdminJson(request, response as never, {
			sessionAuth: { requireAdminJson, requireAdminJsonAllowBasic } as never,
		} as never, false);
		expect(result).toBe(true);
		expect(requireAdminJson).toHaveBeenCalledTimes(1);
		expect(requireAdminJsonAllowBasic).not.toHaveBeenCalled();
	});

	it("checkAdminTextAllowOnboarding always allows (login screen is served by the SPA)", () => {
		const request = { headers: {} } as never;
		const response = { statusCode: 0 } as never;
		expect(checkAdminTextAllowOnboarding(request, response, {} as never)).toBe(true);
		expect(checkAdminTextAllowOnboarding(request, response, {
			sessionAuth: { requireAdminText: () => false } as never,
		} as never)).toBe(true);
	});

	it("requireDeps sends the configured dependency error response", () => {
		const response = mockResponse();
		const ctx = {
			request: { headers: {} },
			response,
			deps: {},
			body: {},
			params: [],
		} as unknown as AdminRouteContext;

		const ok = requireDeps(ctx, ["settingsStore"]);

		expect(ok).toBe(false);
		expect(response.statusCode).toBe(500);
		expect(JSON.parse(response.body).error).toBe("Settings store not configured");
	});

	it("requireDeps reports the Ollama sign-in service dependency error", () => {
		const response = mockResponse();
		const ctx = {
			request: { headers: {} },
			response,
			deps: {},
			body: {},
			params: [],
		} as unknown as AdminRouteContext;

		const ok = requireDeps(ctx, ["ollamaSignInService"]);

		expect(ok).toBe(false);
		expect(JSON.parse(response.body).error).toBe("Ollama sign-in service not configured");
	});

	it("requireDeps returns true when every required dep is present", () => {
		const response = mockResponse();
		const ctx = {
			request: { headers: {} },
			response,
			deps: { settingsStore: {} },
			body: {},
			params: [],
		} as unknown as AdminRouteContext;

		expect(requireDeps(ctx, ["settingsStore"])).toBe(true);
		expect(response.statusCode).toBe(0);
	});

	it("getRequiredDeps returns the requested dependency views", () => {
		const settingsStore = { id: "settings" } as never;
		const userStore = { id: "users" } as never;
		const deps = { settingsStore, userStore } as never;
		const result = getRequiredDeps(deps, ["settingsStore", "userStore"]);
		expect(result.settingsStore).toBe(settingsStore);
		expect(result.userStore).toBe(userStore);
	});

	it("registry handles missing route deps before invoking the handler", async () => {
		const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));
		const registry = new AdminRouteRegistry().route({
			method: "GET",
			pattern: /^\/api\/settings$/u,
			auth: false,
			requiresDeps: ["settingsStore"],
			handler,
		});
		const response = mockResponse();

		const handled = await registry.handle(
			{ method: "GET", url: "/api/settings", headers: {} } as never,
			response as never,
			{} as never,
			"/api/settings",
		);

		expect(handled).toBe(true);
		expect(response.statusCode).toBe(500);
		expect(JSON.parse(response.body).error).toBe("Settings store not configured");
		expect(handler).not.toHaveBeenCalled();
	});
});

describe("resolveAdminPath / resolveAdminDefaultPage", () => {
	it("falls back to the default admin path when unset", () => {
		expect(resolveAdminPath({} as never)).toBe("/yolomatic/admin");
	});

	it("returns the configured admin path when set", () => {
		expect(resolveAdminPath({ adminPath: "/custom/admin" } as never)).toBe("/custom/admin");
	});

	it("falls back to the default admin default page when unset", () => {
		expect(resolveAdminDefaultPage({} as never)).toBe("#/dashboard");
	});

	it("returns the configured admin default page when set", () => {
		expect(resolveAdminDefaultPage({ adminDefaultPage: "#/repos" } as never)).toBe("#/repos");
	});
});
