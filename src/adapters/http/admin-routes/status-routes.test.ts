import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleStatusRoutes } from "./status-routes.js";

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
});
