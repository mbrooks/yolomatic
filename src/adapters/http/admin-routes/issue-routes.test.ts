import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleIssueRoutes } from "./issue-routes.js";

function request(body?: string): http.IncomingMessage {
	const chunks = body ? [Buffer.from(body)] : [];
	return {
		method: "POST",
		url: "/api/issues",
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

describe("handleIssueRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const handled = await handleIssueRoutes(
			{ method: "GET", url: "/api/other", headers: {} } as never,
			response(),
			{} as never,
			"/api/other",
		);

		expect(handled).toBe(false);
	});

	it("rejects unauthorized create-issue requests", async () => {
		const res = response();
		const handled = await handleIssueRoutes(
			{ method: "POST", url: "/api/issues", headers: {} } as never,
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/issues",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("returns 500 when issue creation throws", async () => {
		const res = response();
		const handled = await handleIssueRoutes(
			request(JSON.stringify({ owner: "mbrooks", repo: "tars", title: "boom" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				githubService: {
					createIssue: vi.fn(async () => {
						throw new Error("boom");
					}),
				},
			} as never,
			"/api/issues",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("returns 400 when issue chat is missing messages", async () => {
		const res = response();
		const handled = await handleIssueRoutes(
			{
				...request(JSON.stringify({ owner: "mbrooks", repo: "tars" })),
				url: "/api/issues/chat",
			} as http.IncomingMessage,
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/issues/chat",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});
});
