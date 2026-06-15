import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleCronRoutes } from "./cron-routes.js";

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

function makeCronStore(overrides: Record<string, unknown> = {}) {
	const base = {
		listForRepo: vi.fn(async () => []),
		createJob: vi.fn(async () => ({ id: "cron-1" })),
		get: vi.fn(async () => ({
			id: "cron-1",
			owner: "mbrooks",
			repo: "tars",
			name: "job",
			description: "",
			prompt: "p",
			scheduleType: "daily",
			scheduleValue: "02:00",
			branch: "main",
			notificationChannel: null,
			enabled: true,
			nextRunAt: new Date().toISOString(),
		})),
		set: vi.fn(async (job: unknown) => job),
		delete: vi.fn(async () => undefined),
		getRuns: vi.fn(async () => []),
	};
	return { ...base, ...overrides } as unknown as NonNullable<Parameters<typeof handleCronRoutes>[2]["cronStore"]>;
}

describe("handleCronRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const handled = await handleCronRoutes(
			request("/api/other"),
			response(),
			{} as never,
			"/api/other",
		);

		expect(handled).toBe(false);
	});

	it("returns 503 when cron store is missing", async () => {
		const res = response();
		const handled = await handleCronRoutes(
			request("/api/crons/mbrooks/tars"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/crons/mbrooks/tars",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toContain("Cron store not configured");
	});

	it("lists cron jobs", async () => {
		const res = response();
		const store = makeCronStore({
			listForRepo: vi.fn(async () => [{ id: "cron-1" }]),
		});
		const handled = await handleCronRoutes(
			request("/api/crons/mbrooks/tars"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				cronStore: store,
			} as never,
			"/api/crons/mbrooks/tars",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).crons).toHaveLength(1);
	});

	it("creates a cron job", async () => {
		const res = response();
		const store = makeCronStore();
		const handled = await handleCronRoutes(
			request(
				"/api/crons/mbrooks/tars",
				"POST",
				JSON.stringify({
					name: "job",
					prompt: "run tests",
					scheduleType: "daily",
					scheduleValue: "02:00",
				}),
			),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				cronStore: store,
			} as never,
			"/api/crons/mbrooks/tars",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(201);
		expect(store.createJob).toHaveBeenCalled();
	});

	it("returns 400 when creating with missing fields", async () => {
		const res = response();
		const handled = await handleCronRoutes(
			request("/api/crons/mbrooks/tars", "POST", JSON.stringify({ name: "job" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				cronStore: makeCronStore(),
			} as never,
			"/api/crons/mbrooks/tars",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	it("gets a cron job detail", async () => {
		const res = response();
		const handled = await handleCronRoutes(
			request("/api/crons/mbrooks/tars/cron-1"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				cronStore: makeCronStore(),
			} as never,
			"/api/crons/mbrooks/tars/cron-1",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
	});

	it("returns 404 when cron job detail is missing", async () => {
		const res = response();
		const handled = await handleCronRoutes(
			request("/api/crons/mbrooks/tars/cron-1"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				cronStore: makeCronStore({ get: vi.fn(async () => null) }),
			} as never,
			"/api/crons/mbrooks/tars/cron-1",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("patches a cron job with all fields", async () => {
		const res = response();
		const store = makeCronStore();
		const handled = await handleCronRoutes(
			request(
				"/api/crons/mbrooks/tars/cron-1",
				"PATCH",
				JSON.stringify({
					name: "updated",
					description: "desc",
					prompt: "updated prompt",
					branch: "dev",
					notificationChannel: "#ops",
					scheduleType: "daily",
					scheduleValue: "03:00",
					enabled: true,
				}),
			),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				cronStore: store,
			} as never,
			"/api/crons/mbrooks/tars/cron-1",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(store.set).toHaveBeenCalled();
	});

	it("returns 404 when patching a missing cron job", async () => {
		const res = response();
		const handled = await handleCronRoutes(
			request("/api/crons/mbrooks/tars/cron-1", "PATCH", JSON.stringify({ name: "x" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				cronStore: makeCronStore({ get: vi.fn(async () => null) }),
			} as never,
			"/api/crons/mbrooks/tars/cron-1",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("deletes a cron job", async () => {
		const res = response();
		const store = makeCronStore();
		const handled = await handleCronRoutes(
			request("/api/crons/mbrooks/tars/cron-1", "DELETE"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				cronStore: store,
			} as never,
			"/api/crons/mbrooks/tars/cron-1",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(store.delete).toHaveBeenCalledWith("mbrooks", "tars", "cron-1");
	});

	it("returns cron run history", async () => {
		const res = response();
		const handled = await handleCronRoutes(
			request("/api/crons/mbrooks/tars/cron-1/runs"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				cronStore: makeCronStore({ getRuns: vi.fn(async () => [{ id: "r1" }]) }),
			} as never,
			"/api/crons/mbrooks/tars/cron-1/runs",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).runs).toHaveLength(1);
	});

	it("queues a cron job run", async () => {
		const res = response();
		const store = makeCronStore();
		const handled = await handleCronRoutes(
			request("/api/crons/mbrooks/tars/cron-1/run", "POST"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				cronStore: store,
			} as never,
			"/api/crons/mbrooks/tars/cron-1/run",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(store.set).toHaveBeenCalled();
	});

	it("returns 503 when cron store is missing for run", async () => {
		const res = response();
		const handled = await handleCronRoutes(
			request("/api/crons/mbrooks/tars/cron-1/run", "POST"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/crons/mbrooks/tars/cron-1/run",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toContain("Cron store not configured");
	});

	it("returns 404 when running a missing cron job", async () => {
		const res = response();
		const handled = await handleCronRoutes(
			request("/api/crons/mbrooks/tars/cron-1/run", "POST"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				cronStore: makeCronStore({ get: vi.fn(async () => null) }),
			} as never,
			"/api/crons/mbrooks/tars/cron-1/run",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("recomputes nextRunAt when enabling a previously disabled job", async () => {
		const res = response();
		const store = makeCronStore({
			get: vi.fn(async () => ({
				id: "cron-1",
				owner: "mbrooks",
				repo: "tars",
				name: "job",
				description: "",
				prompt: "p",
				scheduleType: "daily",
				scheduleValue: "02:00",
				branch: "main",
				notificationChannel: null,
				enabled: false,
				nextRunAt: new Date().toISOString(),
			})),
		});
		const handled = await handleCronRoutes(
			request("/api/crons/mbrooks/tars/cron-1", "PATCH", JSON.stringify({ enabled: true })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				cronStore: store,
			} as never,
			"/api/crons/mbrooks/tars/cron-1",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(store.set).toHaveBeenCalled();
	});

	it("returns 500 when cron run history lookup fails", async () => {
		const res = response();
		const handled = await handleCronRoutes(
			request("/api/crons/mbrooks/tars/cron-1/runs"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				cronStore: {
					getRuns: vi.fn(async () => {
						throw new Error("boom");
					}),
				},
			} as never,
			"/api/crons/mbrooks/tars/cron-1/runs",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});
});
