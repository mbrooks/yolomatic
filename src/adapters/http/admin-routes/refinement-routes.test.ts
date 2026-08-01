import { describe, expect, it, vi, beforeEach } from "vitest";
import type http from "node:http";
import { handleRefinementRoutes } from "./refinement-routes.js";
import type { AdminRouterDeps } from "../admin-router-shared.js";
import { ok, fail } from "../../../app/result.js";

function request(url: string, method: string): http.IncomingMessage {
	return {
		url,
		method,
		headers: {
			authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
		},
		async *[Symbol.asyncIterator]() {
			yield* [];
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

function makeDeps(overrides: Partial<AdminRouterDeps> = {}): AdminRouterDeps {
	return {
		adminUsername: "admin",
		adminPassword: "secret",
		adminAssetsDir: "",
		refinementStore: {} as AdminRouterDeps["refinementStore"],
		getRefinementLog: {
			execute: vi.fn(async () => ok({ available: true, logs: [] })),
		} as unknown as AdminRouterDeps["getRefinementLog"],
		listRefinementAttempts: {
			execute: vi.fn(async () => ok({ attempts: [] })),
		} as unknown as AdminRouterDeps["listRefinementAttempts"],
		getAdminStatus: {} as AdminRouterDeps["getAdminStatus"],
		getSession: {} as AdminRouterDeps["getSession"],
		getSessionLog: {} as AdminRouterDeps["getSessionLog"],
		runSessionCommand: {} as AdminRouterDeps["runSessionCommand"],
		taskController: {} as AdminRouterDeps["taskController"],
		...overrides,
	} as AdminRouterDeps;
}

describe("handleRefinementRoutes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns false for unrelated paths", async () => {
		const handled = await handleRefinementRoutes(
			request("/api/other", "GET"),
			response(),
			makeDeps(),
			new URL("http://localhost/api/other"),
			"/api/other",
		);
		expect(handled).toBe(false);
	});

	it("returns 500 when the refinement store is not configured", async () => {
		const res = response();
		const deps = makeDeps({ refinementStore: undefined, getRefinementLog: undefined, listRefinementAttempts: undefined });
		const handled = await handleRefinementRoutes(
			request("/api/refinements/mbrooks/yeetomatic/1/log", "GET"),
			res,
			deps,
			new URL("http://localhost/api/refinements/mbrooks/yeetomatic/1/log"),
			"/api/refinements/mbrooks/yeetomatic/1/log",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(res.body).toContain("Refinement store not configured");
	});

	it("returns 500 when the refinement store is not configured for attempts", async () => {
		const res = response();
		const deps = makeDeps({ refinementStore: undefined, getRefinementLog: undefined, listRefinementAttempts: undefined });
		const handled = await handleRefinementRoutes(
			request("/api/refinements/mbrooks/yeetomatic/1/attempts", "GET"),
			res,
			deps,
			new URL("http://localhost/api/refinements/mbrooks/yeetomatic/1/attempts"),
			"/api/refinements/mbrooks/yeetomatic/1/attempts",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(res.body).toContain("Refinement store not configured");
	});

	it("serves the refinement log", async () => {
		const res = response();
		const deps = makeDeps({
			getRefinementLog: {
				execute: vi.fn(async () =>
					ok({
						available: true,
						logs: [{ timestamp: "2026-08-01T00:00:00.000Z", level: "info", message: "Refinement started" }],
					}),
				),
			} as unknown as AdminRouterDeps["getRefinementLog"],
		});
		const handled = await handleRefinementRoutes(
			request("/api/refinements/mbrooks/yeetomatic/1/log?since=2026-08-01T00:00:00.000Z", "GET"),
			res,
			deps,
			new URL("http://localhost/api/refinements/mbrooks/yeetomatic/1/log?since=2026-08-01T00:00:00.000Z"),
			"/api/refinements/mbrooks/yeetomatic/1/log",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(deps.getRefinementLog!.execute).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "2026-08-01T00:00:00.000Z");
		expect(res.body).toContain("Refinement started");
	});

	it("returns 404 when no refinement activity exists", async () => {
		const res = response();
		const deps = makeDeps({
			getRefinementLog: {
				execute: vi.fn(async () => fail("not_found", "No refinement activity for this issue")),
			} as unknown as AdminRouterDeps["getRefinementLog"],
		});
		const handled = await handleRefinementRoutes(
			request("/api/refinements/mbrooks/yeetomatic/1/log", "GET"),
			res,
			deps,
			new URL("http://localhost/api/refinements/mbrooks/yeetomatic/1/log"),
			"/api/refinements/mbrooks/yeetomatic/1/log",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
		expect(res.body).toContain("No refinement activity for this issue");
	});

	it("serves the refinement attempts list", async () => {
		const res = response();
		const deps = makeDeps({
			listRefinementAttempts: {
				execute: vi.fn(async () =>
					ok({ attempts: [{ id: "a1", state: "applied", requester: "admin", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", instructionSource: "prompt-defaults" }] }),
				),
			} as unknown as AdminRouterDeps["listRefinementAttempts"],
		});
		const handled = await handleRefinementRoutes(
			request("/api/refinements/mbrooks/yeetomatic/1/attempts", "GET"),
			res,
			deps,
			new URL("http://localhost/api/refinements/mbrooks/yeetomatic/1/attempts"),
			"/api/refinements/mbrooks/yeetomatic/1/attempts",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(deps.listRefinementAttempts!.execute).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1);
		expect(res.body).toContain("applied");
	});

	it("returns 404 for the attempts endpoint when listing fails", async () => {
		const res = response();
		const deps = makeDeps({
			listRefinementAttempts: {
				execute: vi.fn(async () => fail("internal", "store unavailable")),
			} as unknown as AdminRouterDeps["listRefinementAttempts"],
		});
		const handled = await handleRefinementRoutes(
			request("/api/refinements/mbrooks/yeetomatic/1/attempts", "GET"),
			res,
			deps,
			new URL("http://localhost/api/refinements/mbrooks/yeetomatic/1/attempts"),
			"/api/refinements/mbrooks/yeetomatic/1/attempts",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(res.body).toContain("store unavailable");
	});

	it("returns 404 for unmatched refinement paths", async () => {
		const res = response();
		const handled = await handleRefinementRoutes(
			request("/api/refinements/mbrooks/yeetomatic/1/unknown", "GET"),
			res,
			makeDeps(),
			new URL("http://localhost/api/refinements/mbrooks/yeetomatic/1/unknown"),
			"/api/refinements/mbrooks/yeetomatic/1/unknown",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});
});