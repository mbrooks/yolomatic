import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleRepoRoutes } from "./repo-routes.js";

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

describe("handleRepoRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const handled = await handleRepoRoutes(
			{ method: "GET", url: "/api/other", headers: {} } as never,
			response(),
			{} as never,
			"/api/other",
		);

		expect(handled).toBe(false);
	});

	it("rejects unauthorized repo issue requests", async () => {
		const res = response();
		const handled = await handleRepoRoutes(
			{ method: "GET", url: "/api/repos/mbrooks/tars/issues", headers: {} } as never,
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/repos/mbrooks/tars/issues",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("returns 500 when assign is requested without settings store", async () => {
		const res = response();
		const handled = await handleRepoRoutes(
			{
				method: "POST",
				url: "/api/repos/mbrooks/tars/issues/12/assign",
				headers: {
					authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
				},
			} as http.IncomingMessage,
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				githubService: {
					updateIssueAssignees: vi.fn(),
		getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
		listAccessibleRepositories: vi.fn(async () => []),
				},
			} as never,
			"/api/repos/mbrooks/tars/issues/12/assign",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});
});
