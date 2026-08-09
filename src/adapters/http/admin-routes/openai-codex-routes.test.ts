import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleOpenAICodexRoutes } from "./openai-codex-routes.js";

function request(url: string, method = "GET"): http.IncomingMessage {
	return {
		url,
		method,
		headers: {
			cookie: "yolomatic_admin_session=valid",
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
		sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never,
		openaiCodexAuthService: {
			getSignInStatus: vi.fn(() => ({ signedIn: false, message: "Not signed in with ChatGPT." })),
			beginLogin: vi.fn(async () => ({ authUrl: "https://auth.openai.com/authorize?state=test" })),
			logout: vi.fn(),
		},
		...overrides,
	} as any;
}

describe("handleOpenAICodexRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const handled = await handleOpenAICodexRoutes(request("/api/other"), response(), makeDeps(), "/api/other");
		expect(handled).toBe(false);
	});

	it("returns the sign-in status payload", async () => {
		const res = response();
		const deps = makeDeps();
		(deps.openaiCodexAuthService as { getSignInStatus: ReturnType<typeof vi.fn> }).getSignInStatus = vi.fn(() => ({
			signedIn: true,
			account: "chatgpt-user",
			message: "Signed in with ChatGPT.",
		}));
		const handled = await handleOpenAICodexRoutes(request("/api/openai-codex/status"), res, deps, "/api/openai-codex/status");

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.signedIn).toBe(true);
		expect(body.account).toBe("chatgpt-user");
	});

	it("begins a login and returns the authorization URL", async () => {
		const res = response();
		const deps = makeDeps();
		const handled = await handleOpenAICodexRoutes(request("/api/openai-codex/login", "POST"), res, deps, "/api/openai-codex/login");

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.authUrl).toBe("https://auth.openai.com/authorize?state=test");
		expect((deps.openaiCodexAuthService as { beginLogin: ReturnType<typeof vi.fn> }).beginLogin).toHaveBeenCalledTimes(1);
	});

	it("logs out and reports success", async () => {
		const res = response();
		const deps = makeDeps();
		const handled = await handleOpenAICodexRoutes(request("/api/openai-codex/logout", "POST"), res, deps, "/api/openai-codex/logout");

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.success).toBe(true);
		expect((deps.openaiCodexAuthService as { logout: ReturnType<typeof vi.fn> }).logout).toHaveBeenCalledTimes(1);
	});

	it("returns 500 when the auth service is missing", async () => {
		const res = response();
		const handled = await handleOpenAICodexRoutes(
			request("/api/openai-codex/status"),
			res,
			{ sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never } as any,
			"/api/openai-codex/status",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toBe("OpenAI Codex auth service not configured");
	});

	it("rejects unauthorized requests", async () => {
		const res = response();
		const handled = await handleOpenAICodexRoutes(
			{ method: "GET", url: "/api/openai-codex/status", headers: {} } as never,
			res,
			{
				sessionAuth: {
					requireAdminJson: (_req: unknown, r: http.ServerResponse & { statusCode: number; end: (d?: string) => void }) => {
						r.statusCode = 401;
						r.end('{"error":"Unauthorized"}');
						return false;
					},
					requireAdminText: () => false,
					isAdminAuthorized: () => false,
					hasUsers: () => true,
				} as never,
				openaiCodexAuthService: { getSignInStatus: () => ({ signedIn: false, message: "" }) },
			} as any,
			"/api/openai-codex/status",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});
});