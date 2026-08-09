import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleUserRoutes } from "./user-routes.js";

function request(url: string, method = "GET", body?: string): http.IncomingMessage {
	const chunks = body ? [Buffer.from(body)] : [];
	return {
		url,
		method,
		headers: { cookie: "yolomatic_admin_session=valid" },
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

const sampleUser = {
	id: "u1",
	fullName: "Admin",
	username: "admin",
	passwordHash: "scrypt:hash",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
};

function makeDeps(overrides: Record<string, unknown> = {}) {
	return {
		sessionAuth: { requireAdminJson: () => true } as never,
		userStore: {
			listSync: vi.fn(() => [sampleUser]),
			createSync: vi.fn(() => sampleUser),
			updateFullNameSync: vi.fn(() => sampleUser),
			updatePasswordSync: vi.fn(() => sampleUser),
			deleteSync: vi.fn(() => true),
		},
		...overrides,
	} as any;
}

describe("handleUserRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const handled = await handleUserRoutes(
			{ method: "GET", url: "/api/other", headers: {} } as never,
			response(),
			makeDeps(),
			"/api/other",
		);
		expect(handled).toBe(false);
	});

	it("blocks unauthenticated requests with 401", async () => {
		const res = response();
		const deps = makeDeps({
			sessionAuth: {
				requireAdminJson: vi.fn((_req: unknown, r: unknown) => {
					(r as { statusCode: number }).statusCode = 401;
					(res as { body: string }).body = JSON.stringify({ error: "Unauthorized" });
					return false;
				}),
			} as never,
		});
		const handled = await handleUserRoutes(request("/api/users"), res, deps, "/api/users");

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("returns 503 when in onboarding mode (no sessionAuth)", async () => {
		const res = response();
		const deps = makeDeps({ sessionAuth: undefined });
		const handled = await handleUserRoutes(request("/api/users"), res, deps, "/api/users");

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(503);
	});

	describe("GET /api/users", () => {
		it("lists users without password hashes", async () => {
			const res = response();
			const deps = makeDeps();
			const handled = await handleUserRoutes(request("/api/users"), res, deps, "/api/users");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.users).toHaveLength(1);
			expect(body.users[0].username).toBe("admin");
			expect("passwordHash" in body.users[0]).toBe(false);
		});

		it("returns 500 when userStore is not configured", async () => {
			const res = response();
			const deps = makeDeps({ userStore: undefined });
			const handled = await handleUserRoutes(request("/api/users"), res, deps, "/api/users");

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
		});
	});

	describe("POST /api/users", () => {
		it("creates a user and returns 201", async () => {
			const res = response();
			const deps = makeDeps();
			const handled = await handleUserRoutes(
				request("/api/users", "POST", JSON.stringify({ full_name: "Jane", username: "jane", password: "p" })),
				res,
				deps,
				"/api/users",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(201);
			expect(JSON.parse(res.body).username).toBe("admin");
			expect(deps.userStore.createSync).toHaveBeenCalledWith({ fullName: "Jane", username: "jane", password: "p" });
		});

		it("returns 409 when the username is taken", async () => {
			const res = response();
			const deps = makeDeps({
				userStore: {
					listSync: vi.fn(() => []),
					createSync: vi.fn(() => {
						throw new Error("Username 'jane' is already taken");
					}),
				},
			});
			const handled = await handleUserRoutes(
				request("/api/users", "POST", JSON.stringify({ full_name: "Jane", username: "jane", password: "p" })),
				res,
				deps,
				"/api/users",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(409);
			expect(JSON.parse(res.body).error).toContain("already taken");
		});

		it("returns 400 for a validation error from the store", async () => {
			const res = response();
			const deps = makeDeps({
				userStore: {
					listSync: vi.fn(() => []),
					createSync: vi.fn(() => {
						throw new Error("full_name is required");
					}),
				},
			});
			const handled = await handleUserRoutes(
				request("/api/users", "POST", JSON.stringify({ full_name: "Jane", username: "jane", password: "p" })),
				res,
				deps,
				"/api/users",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
		});

		it("returns 400 when required fields are missing", async () => {
			const res = response();
			const deps = makeDeps();
			const handled = await handleUserRoutes(
				request("/api/users", "POST", JSON.stringify({ full_name: "Jane", username: "jane" })),
				res,
				deps,
				"/api/users",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			expect(JSON.parse(res.body).error).toContain("password");
		});
	});

	describe("PATCH /api/users/:id", () => {
		it("updates a user's full name", async () => {
			const res = response();
			const deps = makeDeps();
			const handled = await handleUserRoutes(
				request("/api/users/u1", "PATCH", JSON.stringify({ full_name: "New Name" })),
				res,
				deps,
				"/api/users/u1",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			expect(deps.userStore.updateFullNameSync).toHaveBeenCalledWith("u1", "New Name");
		});

		it("returns 400 when full_name is missing", async () => {
			const res = response();
			const deps = makeDeps();
			const handled = await handleUserRoutes(
				request("/api/users/u1", "PATCH", JSON.stringify({})),
				res,
				deps,
				"/api/users/u1",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			expect(JSON.parse(res.body).error).toContain("full_name");
		});

		it("returns 404 when the user does not exist", async () => {
			const res = response();
			const deps = makeDeps({
				userStore: {
					listSync: vi.fn(() => []),
					updateFullNameSync: vi.fn(() => null),
				},
			});
			const handled = await handleUserRoutes(
				request("/api/users/missing", "PATCH", JSON.stringify({ full_name: "X" })),
				res,
				deps,
				"/api/users/missing",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(404);
		});

		it("returns 400 when the store throws a validation error", async () => {
			const res = response();
			const deps = makeDeps({
				userStore: {
					listSync: vi.fn(() => []),
					updateFullNameSync: vi.fn(() => {
						throw new Error("full_name is required");
					}),
				},
			});
			const handled = await handleUserRoutes(
				request("/api/users/u1", "PATCH", JSON.stringify({ full_name: "   " })),
				res,
				deps,
				"/api/users/u1",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
		});
	});

	describe("POST /api/users/:id/password", () => {
		it("resets a user's password", async () => {
			const res = response();
			const deps = makeDeps();
			const handled = await handleUserRoutes(
				request("/api/users/u1/password", "POST", JSON.stringify({ password: "new-p" })),
				res,
				deps,
				"/api/users/u1/password",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			expect(deps.userStore.updatePasswordSync).toHaveBeenCalledWith("u1", "new-p");
		});

		it("returns 400 when password is missing", async () => {
			const res = response();
			const deps = makeDeps();
			const handled = await handleUserRoutes(
				request("/api/users/u1/password", "POST", JSON.stringify({})),
				res,
				deps,
				"/api/users/u1/password",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
		});

		it("returns 404 when the user does not exist", async () => {
			const res = response();
			const deps = makeDeps({
				userStore: {
					listSync: vi.fn(() => []),
					updatePasswordSync: vi.fn(() => null),
				},
			});
			const handled = await handleUserRoutes(
				request("/api/users/missing/password", "POST", JSON.stringify({ password: "p" })),
				res,
				deps,
				"/api/users/missing/password",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(404);
		});

		it("returns 400 when the store throws a validation error", async () => {
			const res = response();
			const deps = makeDeps({
				userStore: {
					listSync: vi.fn(() => []),
					updatePasswordSync: vi.fn(() => {
						throw new Error("password is required");
					}),
				},
			});
			const handled = await handleUserRoutes(
				request("/api/users/u1/password", "POST", JSON.stringify({ password: "" })),
				res,
				deps,
				"/api/users/u1/password",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
		});
	});

	describe("DELETE /api/users/:id", () => {
		it("deletes a user when more than one remains", async () => {
			const res = response();
			const deps = makeDeps({
				userStore: {
					listSync: vi.fn(() => [sampleUser, { ...sampleUser, id: "u2" }]),
					deleteSync: vi.fn(() => true),
				},
			});
			const handled = await handleUserRoutes(
				request("/api/users/u2", "DELETE"),
				res,
				deps,
				"/api/users/u2",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			expect(JSON.parse(res.body)).toEqual({ deleted: true });
			expect(deps.userStore.deleteSync).toHaveBeenCalledWith("u2");
		});

		it("refuses to delete the last admin user with 409", async () => {
			const res = response();
			const deps = makeDeps({
				userStore: {
					listSync: vi.fn(() => [sampleUser]),
					deleteSync: vi.fn(),
				},
			});
			const handled = await handleUserRoutes(
				request("/api/users/u1", "DELETE"),
				res,
				deps,
				"/api/users/u1",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(409);
			expect(JSON.parse(res.body).error).toContain("last admin");
			expect(deps.userStore.deleteSync).not.toHaveBeenCalled();
		});

		it("returns 404 when the user does not exist", async () => {
			const res = response();
			const deps = makeDeps({
				userStore: {
					listSync: vi.fn(() => [sampleUser, { ...sampleUser, id: "u2" }]),
					deleteSync: vi.fn(() => false),
				},
			});
			const handled = await handleUserRoutes(
				request("/api/users/missing", "DELETE"),
				res,
				deps,
				"/api/users/missing",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(404);
		});
	});
});