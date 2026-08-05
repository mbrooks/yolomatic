import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleStatusRoutes } from "./status-routes.js";
import { AdminSessionAuth } from "../admin-auth.js";
import { UserStore } from "../../../users/store.js";
import { ok } from "../../../app/result.js";

function request(
	url: string,
	method = "GET",
	body?: string,
	headers: http.IncomingHttpHeaders = {},
): http.IncomingMessage {
	const chunks = body ? [Buffer.from(body)] : [];
	return {
		url,
		method,
		headers: { cookie: "yeetomatic_admin_session=valid", ...headers },
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

function basicAuthHeader(username: string, password: string): http.IncomingHttpHeaders {
	return { authorization: "Basic " + Buffer.from(`${username}:${password}`).toString("base64") };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
	return {
		sessionAuth: {
			requireAdminJson: () => true,
			requireAdminJsonAllowBasic: () => true,
			requireAdminText: () => true,
			isAdminAuthorized: () => true,
			hasUsers: () => true,
		} as never,
		getAdminStatus: {
			execute: vi.fn(async () =>
				ok({
					sessions: [
						{
							owner: "mbrooks",
							repo: "yeetomatic",
							issueNumber: 1,
							status: "working",
							lastActivity: new Date().toISOString(),
						},
					],
				}),
			),
		},
		taskController: {
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		},
		...overrides,
	} as any;
}

async function tmpUserStore(): Promise<UserStore> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-status-routes-"));
	const store = new UserStore(path.join(dir, "users.sqlite"));
	store.createSync({ fullName: "Admin", username: "admin", password: "secret" });
	return store;
}

function makeRealDeps(store: UserStore, overrides: Record<string, unknown> = {}) {
	const sessionAuth = new AdminSessionAuth(store);
	return {
		sessionAuth,
		getAdminStatus: {
			execute: vi.fn(async () =>
				ok({
					sessions: [
						{
							owner: "mbrooks",
							repo: "yeetomatic",
							issueNumber: 1,
							status: "working",
							lastActivity: new Date().toISOString(),
						},
					],
				}),
			),
		},
		taskController: {
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		},
		...overrides,
	} as any;
}

function cookieHeaderFor(auth: AdminSessionAuth, store: UserStore): string {
	const req = {
		headers: {},
		socket: {},
	} as unknown as http.IncomingMessage;
	const res = response();
	const user = auth.login(req, res, "admin", "secret");
	if (!user) throw new Error("login failed");
	const setCookie = String((res.setHeader as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "Set-Cookie")?.[1]);
	return setCookie.split(";")[0];
}

describe("handleStatusRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const handled = await handleStatusRoutes(
			{ method: "GET", url: "/api/other", headers: {} } as never,
			response(),
			{} as never,
			"/api/other",
		);

		expect(handled).toBe(false);
	});

	it("rejects unauthorized status requests", async () => {
		const res = response();
		const handled = await handleStatusRoutes(
			{ method: "GET", url: "/api/status", headers: {} } as never,
			res,
			{
				sessionAuth: {
					requireAdminJsonAllowBasic: (_req: any, r: any) => {
						r.statusCode = 401;
						r.end('{"error":"Unauthorized"}');
						return false;
					},
					requireAdminJson: (_req: any, r: any) => {
						r.statusCode = 401;
						r.end('{"error":"Unauthorized"}');
						return false;
					},
					requireAdminText: () => false,
					isAdminAuthorized: () => false,
					hasUsers: () => true,
				} as never,
			} as never,
			"/api/status",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("returns working session status", async () => {
		const res = response();
		const handled = await handleStatusRoutes(
			request("/api/status/working"),
			res,
			makeDeps(),
			"/api/status/working",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.working).toBe(true);
		expect(body.count).toBe(1);
	});

	it("returns mapped error when working status lookup fails", async () => {
		const res = response();
		const deps = makeDeps({
			getAdminStatus: {
				execute: vi.fn(async () => ({
					success: false,
					code: "not_found",
					message: "Not found",
				})),
			},
		});
		const handled = await handleStatusRoutes(request("/api/status/working"), res, deps, "/api/status/working");

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.body).error).toBe("Not found");
	});

	it("returns maintenance mode status", async () => {
		const res = response();
		const handled = await handleStatusRoutes(
			request("/api/maintenance"),
			res,
			makeDeps(),
			"/api/maintenance",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).draining).toBe(false);
	});

	it("toggles maintenance mode", async () => {
		const res = response();
		const deps = makeDeps();
		const handled = await handleStatusRoutes(
			request("/api/maintenance", "POST", JSON.stringify({ enabled: true })),
			res,
			deps,
			"/api/maintenance",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).draining).toBe(true);
		expect(deps.taskController.setDraining).toHaveBeenCalledWith(true);
	});

	it("returns full status payload", async () => {
		const res = response();
		const handled = await handleStatusRoutes(
			request("/api/status"),
			res,
			makeDeps(),
			"/api/status",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).sessions).toHaveLength(1);
	});

	it("returns mapped error when full status lookup fails", async () => {
		const res = response();
		const deps = makeDeps({
			getAdminStatus: {
				execute: vi.fn(async () => ({
					success: false,
					code: "invalid_state",
					message: "Invalid",
				})),
			},
		});
		const handled = await handleStatusRoutes(request("/api/status"), res, deps, "/api/status");

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe("Invalid");
	});
});

describe("handleStatusRoutes — HTTP Basic Auth", () => {
	it("authorizes GET /api/status/working with valid Basic credentials and no cookie", async () => {
		const store = await tmpUserStore();
		const deps = makeRealDeps(store);
		const res = response();
		const handled = await handleStatusRoutes(
			request("/api/status/working", "GET", undefined, basicAuthHeader("admin", "secret")),
			res,
			deps,
			"/api/status/working",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.working).toBe(true);
		expect(body.count).toBe(1);
	});

	it("authorizes POST /api/maintenance with valid Basic credentials and no cookie", async () => {
		const store = await tmpUserStore();
		const deps = makeRealDeps(store);
		const res = response();
		const handled = await handleStatusRoutes(
			request(
				"/api/maintenance",
				"POST",
				JSON.stringify({ enabled: true }),
				basicAuthHeader("admin", "secret"),
			),
			res,
			deps,
			"/api/maintenance",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).draining).toBe(true);
		expect(deps.taskController.setDraining).toHaveBeenCalledWith(true);
	});

	it("authorizes GET /api/status with valid Basic credentials and no cookie", async () => {
		const store = await tmpUserStore();
		const deps = makeRealDeps(store);
		const res = response();
		const handled = await handleStatusRoutes(
			request("/api/status", "GET", undefined, basicAuthHeader("admin", "secret")),
			res,
			deps,
			"/api/status",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).sessions).toHaveLength(1);
	});

	it("rejects Basic credentials with a bad password", async () => {
		const store = await tmpUserStore();
		const deps = makeRealDeps(store);
		const res = response();
		const handled = await handleStatusRoutes(
			request("/api/status/working", "GET", undefined, basicAuthHeader("admin", "wrong")),
			res,
			deps,
			"/api/status/working",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.body).error).toBe("Unauthorized");
	});

	it("rejects Basic credentials with an unknown user", async () => {
		const store = await tmpUserStore();
		const deps = makeRealDeps(store);
		const res = response();
		const handled = await handleStatusRoutes(
			request("/api/status/working", "GET", undefined, basicAuthHeader("ghost", "secret")),
			res,
			deps,
			"/api/status/working",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("rejects a malformed Authorization header", async () => {
		const store = await tmpUserStore();
		const deps = makeRealDeps(store);
		const res = response();
		const handled = await handleStatusRoutes(
			request("/api/status/working", "GET", undefined, { authorization: "Basic not-base64!!" }),
			res,
			deps,
			"/api/status/working",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("rejects a non-Basic Authorization header", async () => {
		const store = await tmpUserStore();
		const deps = makeRealDeps(store);
		const res = response();
		const handled = await handleStatusRoutes(
			request("/api/status/working", "GET", undefined, { authorization: "Bearer token" }),
			res,
			deps,
			"/api/status/working",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("rejects a request with neither cookie nor Basic credentials", async () => {
		const store = await tmpUserStore();
		const deps = makeRealDeps(store);
		const res = response();
		const handled = await handleStatusRoutes(
			request("/api/status/working", "GET", undefined, {}),
			res,
			deps,
			"/api/status/working",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.body).error).toBe("Unauthorized");
	});

	it("still authorizes a request with a valid session cookie and no Basic header", async () => {
		const store = await tmpUserStore();
		const auth = new AdminSessionAuth(store);
		const cookie = cookieHeaderFor(auth, store);
		const deps = makeRealDeps(store);
		const res = response();
		const handled = await handleStatusRoutes(
			request("/api/status/working", "GET", undefined, { cookie }),
			res,
			deps,
			"/api/status/working",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.working).toBe(true);
	});

	it("accepts Basic credentials case-insensitively for the username", async () => {
		const store = await tmpUserStore();
		const deps = makeRealDeps(store);
		const res = response();
		const handled = await handleStatusRoutes(
			request("/api/status/working", "GET", undefined, basicAuthHeader("ADMIN", "secret")),
			res,
			deps,
			"/api/status/working",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
	});
});