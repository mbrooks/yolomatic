import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleSettingsRoutes } from "./settings-routes.js";

function request(url: string, method = "GET", body?: string): http.IncomingMessage {
	const chunks = body ? [Buffer.from(body)] : [];
	return {
		url,
		method,
		headers: {
			cookie: "yolomatic_admin_session=valid",
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

function makeDeps(overrides: Record<string, unknown> = {}) {
	return {
		sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never,
		settingsStore: {
			getAllViews: vi.fn(() => ({})),
			setTyped: vi.fn(),
			getString: vi.fn((key: string, defaultValue: string) => defaultValue),
			get: vi.fn(),
		},
		githubService: {
			listPendingInvitations: vi.fn(async () => []),
			acceptInvitation: vi.fn(async () => undefined),
		},
		...overrides,
	} as any;
}

describe("handleSettingsRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const handled = await handleSettingsRoutes(
			{ method: "GET", url: "/api/other", headers: {} } as never,
			response(),
			{} as never,
			"/api/other",
		);

		expect(handled).toBe(false);
	});

	it("returns 503 when settings store is missing for GET settings", async () => {
		const res = response();
		const handled = await handleSettingsRoutes(
			request("/api/settings"),
			res,
			{ sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never } as never,
			"/api/settings",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toContain("Settings store not configured");
	});

	it("lists all settings", async () => {
		const res = response();
		const deps = makeDeps({
			settingsStore: {
				getAllViews: vi.fn(() => ({ theme: "dark" })),
			},
		});
		const handled = await handleSettingsRoutes(request("/api/settings"), res, deps, "/api/settings");

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).settings).toEqual({ theme: "dark" });
	});

	it("updates settings and tracks restart requirements", async () => {
		const res = response();
		const deps = makeDeps();
		const handled = await handleSettingsRoutes(
			request("/api/settings", "PATCH", JSON.stringify({ github_username: "x", github_token: "" })),
			res,
			deps,
			"/api/settings",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.updated).toContain("github_username");
		expect(body.updated).not.toContain("github_token");
		expect(body.requiresRestart).toContain("github_username");
	});

	it("lists pending GitHub invitations", async () => {
		const res = response();
		const deps = makeDeps({
			githubService: {
				listPendingInvitations: vi.fn(async () => [{ id: 1 }]),
			},
		});
		const handled = await handleSettingsRoutes(request("/api/github/invitations"), res, deps, "/api/github/invitations");

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).invitations).toHaveLength(1);
	});

	it("returns 500 when github service is missing for invitations", async () => {
		const res = response();
		const handled = await handleSettingsRoutes(
			request("/api/github/invitations"),
			res,
			{ sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never } as never,
			"/api/github/invitations",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("accepts a GitHub invitation", async () => {
		const res = response();
		const deps = makeDeps();
		const handled = await handleSettingsRoutes(
			request("/api/github/invitations/42/accept", "POST"),
			res,
			deps,
			"/api/github/invitations/42/accept",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(deps.githubService.acceptInvitation).toHaveBeenCalledWith(42);
	});

	it("returns 500 when github service is missing for accepting invitations", async () => {
		const res = response();
		const handled = await handleSettingsRoutes(
			request("/api/github/invitations/42/accept", "POST"),
			res,
			{ sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never } as any,
			"/api/github/invitations/42/accept",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("returns 400 for an invalid invitation id", async () => {
		const res = response();
		const deps = makeDeps();
		const handled = await handleSettingsRoutes(
			request("/api/github/invitations/abc/accept", "POST"),
			res,
			deps,
			"/api/github/invitations/abc/accept",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	describe("GET /api/llm/models", () => {
		function providerResponse(data: unknown): Response {
			return new Response(JSON.stringify(data), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}

		it("returns sorted OpenAI model ids using the stored API key", async () => {
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				providerResponse({ data: [{ id: "gpt-4" }, { id: "gpt-3.5" }] }),
			);
			const res = response();
			const deps = makeDeps({
				settingsStore: {
					getAllViews: vi.fn(() => ({})),
					setTyped: vi.fn(),
					getString: vi.fn((key: string, defaultValue: string) => defaultValue),
					get: vi.fn((key: string) => (key === "openai_api_key" ? "sk-stored" : undefined)),
				},
			});
			const handled = await handleSettingsRoutes(
				request("/api/llm/models?provider=openai"),
				res,
				deps,
				"/api/llm/models",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.models).toEqual(["gpt-3.5", "gpt-4"]);
			expect(body.error).toBeUndefined();
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.openai.com/v1/models",
				expect.objectContaining({ headers: { Authorization: "Bearer sk-stored" } }),
			);
			expect(String(res.body)).not.toContain("sk-stored");
		});

		it("returns a placeholder error when the OpenAI API key is missing", async () => {
			const res = response();
			const deps = makeDeps({
				settingsStore: {
					getAllViews: vi.fn(() => ({})),
					setTyped: vi.fn(),
					getString: vi.fn((key: string, defaultValue: string) => defaultValue),
					get: vi.fn(() => undefined),
				},
			});
			const handled = await handleSettingsRoutes(
				request("/api/llm/models?provider=openai"),
				res,
				deps,
				"/api/llm/models",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.models).toEqual([]);
			expect(body.error).toBe("Enter an OpenAI API key to load models");
		});

		it("returns sorted Ollama model names", async () => {
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				providerResponse({ models: [{ name: "llama2" }, { name: "mistral" }] }),
			);
			const res = response();
			const handled = await handleSettingsRoutes(
				request("/api/llm/models?provider=ollama"),
				res,
				makeDeps(),
				"/api/llm/models",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.models).toEqual(["llama2", "mistral"]);
			expect(body.error).toBeUndefined();
			expect(fetchSpy).toHaveBeenCalledWith("https://ollama.com/api/tags");
		});

		it("returns a graceful error when Ollama is unreachable", async () => {
			vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
			const res = response();
			const handled = await handleSettingsRoutes(
				request("/api/llm/models?provider=ollama"),
				res,
				makeDeps(),
				"/api/llm/models",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.models).toEqual([]);
			expect(body.error).toContain("Could not load Ollama models");
		});

		it("returns 400 for an unsupported provider", async () => {
			const res = response();
			const handled = await handleSettingsRoutes(
				request("/api/llm/models?provider=anthropic"),
				res,
				makeDeps(),
				"/api/llm/models",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
			expect(JSON.parse(res.body).error).toContain("Unsupported LLM provider");
		});

		it("returns 500 when settingsStore is missing", async () => {
			const res = response();
			const handled = await handleSettingsRoutes(
				request("/api/llm/models?provider=openai"),
				res,
				{ sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never } as any,
				"/api/llm/models",
			);

			expect(handled).toBe(true);
			expect(res.statusCode).toBe(500);
			expect(JSON.parse(res.body).error).toContain("Settings store not configured");
		});
	});
});
