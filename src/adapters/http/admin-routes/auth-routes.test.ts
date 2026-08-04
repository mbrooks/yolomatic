import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleAuthRoutes } from "./auth-routes.js";

function request(url: string, method = "GET", body?: string): http.IncomingMessage {
	const chunks = body ? [Buffer.from(body)] : [];
	return {
		url,
		method,
		headers: {},
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
		sessionAuth: {
			requireAdminJson: () => true,
			requireAdminText: () => true,
			isAdminAuthorized: () => true,
			hasUsers: () => true,
			verifyRequest: vi.fn(() => null),
			login: vi.fn(() => null),
			clearSessionCookie: vi.fn(),
		},
		...overrides,
	} as any;
}

const sampleUser = {
	id: "u1",
	fullName: "Admin",
	username: "admin",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
};

describe("handleAuthRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const handled = await handleAuthRoutes(
			request("/api/other"),
			response(),
			makeDeps(),
			"/api/other",
		);
		expect(handled).toBe(false);
	});

	describe("POST /api/login", () => {
		it("logs in with valid credentials and returns the user", async () => {
			const res = response();
			const deps = makeDeps({
				sessionAuth: { login: vi.fn(() => sampleUser) } as any,
			});
			const handled = await handleAuthRoutes(
				request("/api/login", "POST", JSON.stringify({ username: "admin", password: "secret" })),
				res,
				deps,
				"/api/login",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.user.username).toBe("admin");
			expect(deps.sessionAuth.login).toHaveBeenCalledWith(expect.anything(), expect.anything(), "admin", "secret");
		});

		it("returns 401 for invalid credentials", async () => {
			const res = response();
			const deps = makeDeps({
				sessionAuth: { login: vi.fn(() => null) } as any,
			});
			const handled = await handleAuthRoutes(
				request("/api/login", "POST", JSON.stringify({ username: "admin", password: "wrong" })),
				res,
				deps,
				"/api/login",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(401);
			expect(JSON.parse(res.body).error).toBe("Invalid username or password");
		});

		it("returns 400 when required fields are missing", async () => {
			const res = response();
			const deps = makeDeps();
			const handled = await handleAuthRoutes(
				request("/api/login", "POST", JSON.stringify({ username: "admin" })),
				res,
				deps,
				"/api/login",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			expect(JSON.parse(res.body).error).toContain("password");
		});

		it("returns 500 when sessionAuth is not configured", async () => {
			const res = response();
			const deps = makeDeps({ sessionAuth: undefined });
			const handled = await handleAuthRoutes(
				request("/api/login", "POST", JSON.stringify({ username: "admin", password: "secret" })),
				res,
				deps,
				"/api/login",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
		});

		it("returns 400 for malformed JSON", async () => {
			const res = response();
			const deps = makeDeps({ sessionAuth: { login: vi.fn() } as any });
			const handled = await handleAuthRoutes(
				request("/api/login", "POST", "{not json"),
				res,
				deps,
				"/api/login",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
		});
	});

	describe("POST /api/logout", () => {
		it("clears the session cookie and returns ok", async () => {
			const res = response();
			const clear = vi.fn();
			const deps = makeDeps({ sessionAuth: { clearSessionCookie: clear } as any });
			const handled = await handleAuthRoutes(request("/api/logout", "POST"), res, deps, "/api/logout");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			expect(JSON.parse(res.body)).toEqual({ ok: true });
			expect(clear).toHaveBeenCalled();
		});

		it("returns ok even when sessionAuth is not configured", async () => {
			const res = response();
			const deps = makeDeps({ sessionAuth: undefined });
			const handled = await handleAuthRoutes(request("/api/logout", "POST"), res, deps, "/api/logout");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			expect(JSON.parse(res.body)).toEqual({ ok: true });
		});
	});

	describe("GET /api/me", () => {
		it("returns the authenticated user", async () => {
			const res = response();
			const deps = makeDeps({
				sessionAuth: { requireAdminJson: () => true, verifyRequest: vi.fn(() => sampleUser) } as any,
			});
			const handled = await handleAuthRoutes(request("/api/me"), res, deps, "/api/me");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			expect(JSON.parse(res.body).user.username).toBe("admin");
		});

		it("returns 401 when unauthenticated", async () => {
			const res = response();
			const deps = makeDeps({
				sessionAuth: { requireAdminJson: () => true, verifyRequest: vi.fn(() => null) } as any,
			});
			const handled = await handleAuthRoutes(request("/api/me"), res, deps, "/api/me");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(401);
		});

		it("returns 503 when in onboarding mode (no sessionAuth)", async () => {
			const res = response();
			const deps = makeDeps({ sessionAuth: undefined });
			const handled = await handleAuthRoutes(request("/api/me"), res, deps, "/api/me");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(503);
		});
	});
});