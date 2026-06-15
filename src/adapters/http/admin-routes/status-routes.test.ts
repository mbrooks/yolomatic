import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleStatusRoutes } from "./status-routes.js";
import { ok } from "../../../app/result.js";

function request(url: string, method = "GET", body?: string): http.IncomingMessage {
	const chunks = body ? [Buffer.from(body)] : [];
	return {
		url,
		method,
		headers: {
			authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
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
		adminUsername: "admin",
		adminPassword: "secret",
		getAdminStatus: {
			execute: vi.fn(async () =>
				ok({
					sessions: [
						{
							owner: "mbrooks",
							repo: "tars",
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
				adminUsername: "admin",
				adminPassword: "secret",
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
