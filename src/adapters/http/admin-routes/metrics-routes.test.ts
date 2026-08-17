import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleMetricsRoutes } from "./metrics-routes.js";
import { ok, fail } from "../../../app/result.js";

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
		headers: { cookie: "yolomatic_admin_session=valid", ...headers },
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
			requireAdminJsonAllowBasic: () => true,
			requireAdminText: () => true,
			isAdminAuthorized: () => true,
			hasUsers: () => true,
		} as never,
		getMetrics: {
			execute: vi.fn(async () =>
				ok({
					windowDays: 7,
					buckets: [
						{
							date: "2026-08-01",
							sessions: { total: 2, complete: 1, failed: 1, cancelled: 0 },
							tokens: { available: true, input: 30, output: 15, total: 45, cost: 0.9 },
							runtimeMs: 120000,
						},
					],
					recent: [
						{
							sessionKey: "github-mbrooks-yolomatic-issue-1-implementation",
							owner: "mbrooks",
							repo: "yolomatic",
							issueNumber: 1,
							kind: "implementation",
							status: "complete",
							startedAt: "2026-08-01T00:00:00.000Z",
							finishedAt: "2026-08-01T00:01:00.000Z",
							durationMs: 60000,
							tokenUsage: { available: true, input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: 0.6 },
						},
					],
				}),
			),
		},
		...overrides,
	} as any;
}

describe("handleMetricsRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const handled = await handleMetricsRoutes(
			{ method: "GET", url: "/api/other", headers: {} } as never,
			response(),
			{} as never,
			undefined,
			"/api/other",
		);
		expect(handled).toBe(false);
	});

	it("rejects unauthorized requests", async () => {
		const res = response();
		const handled = await handleMetricsRoutes(
			{ method: "GET", url: "/api/metrics", headers: {} } as never,
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
				getMetrics: { execute: vi.fn() } as never,
			} as never,
			new URL("http://localhost/api/metrics"),
			"/api/metrics",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("returns 500 with a missing-deps error when getMetrics is not configured", async () => {
		const res = response();
		const handled = await handleMetricsRoutes(
			request("/api/metrics"),
			res,
			{ sessionAuth: { requireAdminJsonAllowBasic: () => true, requireAdminJson: () => true } } as never,
			new URL("http://localhost/api/metrics"),
			"/api/metrics",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toBe("Metrics query not configured");
	});

	it("returns the metrics time-series for the default 7-day window", async () => {
		const res = response();
		const deps = makeDeps();
		const handled = await handleMetricsRoutes(
			request("/api/metrics"),
			res,
			deps,
			new URL("http://localhost/api/metrics"),
			"/api/metrics",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.windowDays).toBe(7);
		expect(deps.getMetrics.execute).toHaveBeenCalledWith({ days: undefined });
		expect(body.buckets).toHaveLength(1);
		expect(body.buckets[0].tokens.total).toBe(45);
		expect(body.recent[0].issueNumber).toBe(1);
	});

	it("forwards the days query parameter as an integer", async () => {
		const res = response();
		const deps = makeDeps();
		await handleMetricsRoutes(
			request("/api/metrics?days=30"),
			res,
			deps,
			new URL("http://localhost/api/metrics?days=30"),
			"/api/metrics",
		);
		expect(res.statusCode).toBe(200);
		expect(deps.getMetrics.execute).toHaveBeenCalledWith({ days: 30 });
	});

	it("ignores non-numeric days query parameters", async () => {
		const res = response();
		const deps = makeDeps();
		await handleMetricsRoutes(
			request("/api/metrics?days=abc"),
			res,
			deps,
			new URL("http://localhost/api/metrics?days=abc"),
			"/api/metrics",
		);
		expect(deps.getMetrics.execute).toHaveBeenCalledWith({ days: undefined });
	});

	it("maps query failure codes to HTTP status codes", async () => {
		const res = response();
		const deps = makeDeps({
			getMetrics: {
				execute: vi.fn(async () => fail("internal", "boom")),
			},
		});
		await handleMetricsRoutes(
			request("/api/metrics"),
			res,
			deps,
			new URL("http://localhost/api/metrics"),
			"/api/metrics",
		);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toBe("boom");
	});

	it("returns 404 for unknown /api/metrics sub-paths", async () => {
		const res = response();
		const handled = await handleMetricsRoutes(
			request("/api/metrics/unknown"),
			res,
			makeDeps(),
			new URL("http://localhost/api/metrics/unknown"),
			"/api/metrics/unknown",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});
});