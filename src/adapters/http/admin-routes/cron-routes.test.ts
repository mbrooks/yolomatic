import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleCronRoutes } from "./cron-routes.js";

function request(url: string): http.IncomingMessage {
	return {
		url,
		method: "GET",
		headers: {
			authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
		},
		async *[Symbol.asyncIterator]() {},
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
