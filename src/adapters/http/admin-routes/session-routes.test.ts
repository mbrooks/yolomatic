import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleSessionRoutes } from "./session-routes.js";
import type { AdminRouterDeps } from "../admin-router-shared.js";
import { ok } from "../../../app/result.js";

function request(url: string, method: string, body?: string): http.IncomingMessage {
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

const deps: AdminRouterDeps = {
	adminUsername: "admin",
	adminPassword: "secret",
	adminAssetsDir: "",
	getSessionLog: {
		execute: vi.fn(async () => {
			throw new Error("boom");
		}),
	} as unknown as AdminRouterDeps["getSessionLog"],
	runSessionCommand: {
		execute: vi.fn(async () =>
			ok({
				paused: true,
				status: "paused",
				message: "Session paused.",
			}),
		),
	} as unknown as AdminRouterDeps["runSessionCommand"],
	getAdminStatus: {} as AdminRouterDeps["getAdminStatus"],
	getSession: {} as AdminRouterDeps["getSession"],
	taskController: {} as AdminRouterDeps["taskController"],
};

describe("handleSessionRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const handled = await handleSessionRoutes(
			request("/api/other", "GET"),
			response(),
			deps,
			new URL("http://localhost/api/other"),
			"/api/other",
		);

		expect(handled).toBe(false);
	});

	it("returns 404 for unmatched session GET paths", async () => {
		const res = response();
		const handled = await handleSessionRoutes(
			request("/api/sessions/mbrooks/tars/1", "GET"),
			res,
			deps,
			new URL("http://localhost/api/sessions/mbrooks/tars/1"),
			"/api/sessions/mbrooks/tars/1",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("returns 500 when session command execution throws", async () => {
		const res = response();
		const throwingDeps: AdminRouterDeps = {
			...deps,
			runSessionCommand: {
				execute: vi.fn(async () => {
					throw new Error("command exploded");
				}),
			} as unknown as AdminRouterDeps["runSessionCommand"],
		};

		const handled = await handleSessionRoutes(
			request(
				"/api/sessions/mbrooks/tars/1/commands",
				"POST",
				JSON.stringify({ command: "pause" }),
			),
			res,
			throwingDeps,
			new URL("http://localhost/api/sessions/mbrooks/tars/1/commands"),
			"/api/sessions/mbrooks/tars/1/commands",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("returns 400 when a session command is missing", async () => {
		const res = response();
		const handled = await handleSessionRoutes(
			request(
				"/api/sessions/mbrooks/tars/1/commands",
				"POST",
				JSON.stringify({ payload: { reason: "none" } }),
			),
			res,
			deps,
			new URL("http://localhost/api/sessions/mbrooks/tars/1/commands"),
			"/api/sessions/mbrooks/tars/1/commands",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});
});
