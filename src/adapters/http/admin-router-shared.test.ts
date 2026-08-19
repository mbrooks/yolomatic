import { describe, expect, it, vi } from "vitest";
import {
	AdminRouteRegistry,
	NotFoundError,
	ValidationError,
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

	function mockRequest(options: { method: string; url: string; body?: string }) {
		const chunks = options.body ? [Buffer.from(options.body)] : [];
		return {
			method: options.method,
			url: options.url,
			headers: {},
			async *[Symbol.asyncIterator]() {
				for (const chunk of chunks) {
					yield chunk;
				}
			},
		} as never;
	}

	it("rejects an auth-required route with 503 when sessionAuth is missing", async () => {
		const handler = vi.fn(async () => ({ status: 200, body: {} }));
		const registry = new AdminRouteRegistry().route({
			method: "GET",
			pattern: /^\/api\/secret$/u,
			handler,
		});
		const response = mockResponse();

		const handled = await registry.handle(
			mockRequest({ method: "GET", url: "/api/secret" }),
			response as never,
			{} as never,
			"/api/secret",
		);

		expect(handled).toBe(true);
		expect(response.statusCode).toBe(503);
		expect(handler).not.toHaveBeenCalled();
	});

	it("parses an empty parseBody as an empty object", async () => {
		const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));
		const registry = new AdminRouteRegistry().route({
			method: "POST",
			pattern: /^\/api\/empty$/u,
			auth: false,
			parseBody: true,
			handler,
		});
		const response = mockResponse();

		await registry.handle(
			mockRequest({ method: "POST", url: "/api/empty", body: "" }),
			response as never,
			{} as never,
			"/api/empty",
		);

		expect(handler).toHaveBeenCalledTimes(1);
		expect((handler.mock.calls as unknown as Array<[{ body: unknown }]>)[0][0].body).toEqual({});
	});

	it("returns 400 by default when parseBody receives invalid JSON", async () => {
		const handler = vi.fn(async () => ({ status: 200, body: {} }));
		const registry = new AdminRouteRegistry().route({
			method: "POST",
			pattern: /^\/api\/bad$/u,
			auth: false,
			parseBody: true,
			handler,
		});
		const response = mockResponse();

		const handled = await registry.handle(
			mockRequest({ method: "POST", url: "/api/bad", body: "not json" }),
			response as never,
			{} as never,
			"/api/bad",
		);

		expect(handled).toBe(true);
		expect(response.statusCode).toBe(400);
		expect(JSON.parse(response.body).error).toBeDefined();
		expect(handler).not.toHaveBeenCalled();
	});

	it("honors a custom parseErrorStatus on invalid JSON", async () => {
		const handler = vi.fn(async () => ({ status: 200, body: {} }));
		const registry = new AdminRouteRegistry().route({
			method: "POST",
			pattern: /^\/api\/bad2$/u,
			auth: false,
			parseBody: true,
			parseErrorStatus: 422,
			handler,
		});
		const response = mockResponse();

		await registry.handle(
			mockRequest({ method: "POST", url: "/api/bad2", body: "not json" }),
			response as never,
			{} as never,
			"/api/bad2",
		);

		expect(response.statusCode).toBe(422);
	});

	it("reports a single missing required field", async () => {
		const handler = vi.fn(async () => ({ status: 200, body: {} }));
		const registry = new AdminRouteRegistry().route<{ a?: string }>({
			method: "POST",
			pattern: /^\/api\/req1$/u,
			auth: false,
			parseBody: true,
			required: ["a"],
			handler,
		});
		const response = mockResponse();

		await registry.handle(
			mockRequest({ method: "POST", url: "/api/req1", body: JSON.stringify({}) }),
			response as never,
			{} as never,
			"/api/req1",
		);

		expect(response.statusCode).toBe(400);
		expect(JSON.parse(response.body).error).toBe("Missing required field: a");
		expect(handler).not.toHaveBeenCalled();
	});

	it("reports multiple missing required fields and proceeds when all are present", async () => {
		const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));
		const registry = new AdminRouteRegistry().route<{ a?: string; b?: string }>({
			method: "POST",
			pattern: /^\/api\/req2$/u,
			auth: false,
			parseBody: true,
			required: ["a", "b"],
			handler,
		});
		const missingResponse = mockResponse();
		await registry.handle(
			mockRequest({ method: "POST", url: "/api/req2", body: JSON.stringify({ a: "" }) }),
			missingResponse as never,
			{} as never,
			"/api/req2",
		);
		expect(missingResponse.statusCode).toBe(400);
		expect(JSON.parse(missingResponse.body).error).toBe("Missing required fields: a, b");

		const okResponse = mockResponse();
		await registry.handle(
			mockRequest({ method: "POST", url: "/api/req2", body: JSON.stringify({ a: "x", b: "y" }) }),
			okResponse as never,
			{} as never,
			"/api/req2",
		);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(okResponse.statusCode).toBe(200);
	});

	it("maps handler ValidationError, NotFoundError, and generic errors to the right status codes", async () => {
		const validationRegistry = new AdminRouteRegistry().route({
			method: "POST",
			pattern: /^\/api\/err\/validation$/u,
			auth: false,
			handler: async () => {
				throw new ValidationError("nope");
			},
		});
		const validationResponse = mockResponse();
		await validationRegistry.handle(
			mockRequest({ method: "POST", url: "/api/err/validation" }),
			validationResponse as never,
			{} as never,
			"/api/err/validation",
		);
		expect(validationResponse.statusCode).toBe(400);
		expect(JSON.parse(validationResponse.body).error).toBe("nope");

		const notFoundRegistry = new AdminRouteRegistry().route({
			method: "POST",
			pattern: /^\/api\/err\/notfound$/u,
			auth: false,
			handler: async () => {
				throw new NotFoundError("missing");
			},
		});
		const notFoundResponse = mockResponse();
		await notFoundRegistry.handle(
			mockRequest({ method: "POST", url: "/api/err/notfound" }),
			notFoundResponse as never,
			{} as never,
			"/api/err/notfound",
		);
		expect(notFoundResponse.statusCode).toBe(404);
		expect(JSON.parse(notFoundResponse.body).error).toBe("missing");

		const errorRegistry = new AdminRouteRegistry().route({
			method: "POST",
			pattern: /^\/api\/err\/generic$/u,
			auth: false,
			handler: async () => {
				throw new Error("boom");
			},
		});
		const errorResponse = mockResponse();
		await errorRegistry.handle(
			mockRequest({ method: "POST", url: "/api/err/generic" }),
			errorResponse as never,
			{} as never,
			"/api/err/generic",
		);
		expect(errorResponse.statusCode).toBe(500);
		expect(JSON.parse(errorResponse.body).error).toBe("boom");

		const nonErrorRegistry = new AdminRouteRegistry().route({
			method: "POST",
			pattern: /^\/api\/err\/string$/u,
			auth: false,
			handler: async () => {
				throw "string error";
			},
		});
		const nonErrorResponse = mockResponse();
		await nonErrorRegistry.handle(
			mockRequest({ method: "POST", url: "/api/err/string" }),
			nonErrorResponse as never,
			{} as never,
			"/api/err/string",
		);
		expect(nonErrorResponse.statusCode).toBe(500);
		expect(JSON.parse(nonErrorResponse.body).error).toBe("string error");
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
