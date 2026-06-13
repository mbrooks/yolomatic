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

vi.mock("../../../app/commands/issue-chat.js", () => ({
	chatIssueViaLLM: vi.fn(async () => ({
		shouldCreate: false,
		draft: { title: "", body: "", labels: [], assignees: [] },
		message: "",
		owner: "",
		repo: "",
		readyToCreate: false,
	})),
}));

vi.mock("../../../app/commands/generate-issue.js", () => ({
	generateIssueViaLLM: vi.fn(async () => ({
		title: "Generated",
		body: "Body",
		labels: ["bug"],
		assignees: [],
	})),
}));

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

	it("returns 200 for successful issue chat", async () => {
		const { chatIssueViaLLM } = await import("../../../app/commands/issue-chat.js");
		vi.mocked(chatIssueViaLLM).mockResolvedValueOnce({
			shouldCreate: false,
			owner: "mbrooks",
			repo: "tars",
			draft: { title: "Chat Title", body: "Chat Body", labels: [], assignees: [] },
			message: "Draft ready",
			readyToCreate: true,
		});

		const res = response();
		const handled = await handleIssueRoutes(
			{
				...request(JSON.stringify({ messages: [{ role: "user", text: "hello" }] })),
				url: "/api/issues/chat",
			} as http.IncomingMessage,
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				githubService: {
					createIssue: vi.fn(async () => ({ number: 99, html_url: "https://github.com/mbrooks/tars/issues/99" })),
				},
			} as never,
			"/api/issues/chat",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.message).toBe("Draft ready");
	});

	it("returns 500 when issue chat throws", async () => {
		const { chatIssueViaLLM } = await import("../../../app/commands/issue-chat.js");
		vi.mocked(chatIssueViaLLM).mockRejectedValueOnce(new Error("LLM error"));

		const res = response();
		const handled = await handleIssueRoutes(
			{
				...request(JSON.stringify({ messages: [{ role: "user", text: "hello" }] })),
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
		expect(res.statusCode).toBe(500);
		expect(res.body).toContain("LLM error");
	});

	it("returns 400 when issue chat body has invalid JSON", async () => {
		const res = response();
		const handled = await handleIssueRoutes(
			{
				...request("not json"),
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
		expect(res.statusCode).toBe(500);
	});

	it("returns 200 for successful issue generation", async () => {
		const res = response();
		const handled = await handleIssueRoutes(
			{
				...request(JSON.stringify({ owner: "mbrooks", repo: "tars", prompt: "make an issue" })),
				url: "/api/issues/generate",
			} as http.IncomingMessage,
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/issues/generate",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.title).toBe("Generated");
	});

	it("returns 400 when issue generation is missing fields", async () => {
		const res = response();
		const handled = await handleIssueRoutes(
			{
				...request(JSON.stringify({ owner: "mbrooks" })),
				url: "/api/issues/generate",
			} as http.IncomingMessage,
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/issues/generate",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		expect(res.body).toContain("Missing required fields");
	});

	it("returns 500 when issue generation throws", async () => {
		const { generateIssueViaLLM } = await import("../../../app/commands/generate-issue.js");
		vi.mocked(generateIssueViaLLM).mockRejectedValueOnce(new Error("generate failed"));

		const res = response();
		const handled = await handleIssueRoutes(
			{
				...request(JSON.stringify({ owner: "mbrooks", repo: "tars", prompt: "make an issue" })),
				url: "/api/issues/generate",
			} as http.IncomingMessage,
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/issues/generate",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(res.body).toContain("generate failed");
	});

	it("returns 201 for successful issue creation", async () => {
		const res = response();
		const handled = await handleIssueRoutes(
			request(JSON.stringify({ owner: "mbrooks", repo: "tars", title: "Bug", body: "details" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				githubService: {
					createIssue: vi.fn(async () => ({ number: 42, html_url: "http://issue/42" })),
				},
			} as never,
			"/api/issues",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(201);
		const body = JSON.parse(res.body);
		expect(body.number).toBe(42);
	});

	it("returns 400 when issue creation is missing fields", async () => {
		const res = response();
		const handled = await handleIssueRoutes(
			request(JSON.stringify({ owner: "mbrooks" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				githubService: {
					createIssue: vi.fn(async () => ({ number: 42, html_url: "http://issue/42" })),
				},
			} as never,
			"/api/issues",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		expect(res.body).toContain("Missing required fields");
	});

	it("returns 500 when github service is missing for issue creation", async () => {
		const res = response();
		const handled = await handleIssueRoutes(
			request(JSON.stringify({ owner: "mbrooks", repo: "tars", title: "Bug" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/issues",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(res.body).toContain("GitHub service not configured");
	});
});
