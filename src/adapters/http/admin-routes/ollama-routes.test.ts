import { afterEach, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleOllamaRoutes } from "./ollama-routes.js";
import type { OllamaSignInService, OllamaSignInResult } from "../../../ollama/signin-status.js";

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

function makeService(result: OllamaSignInResult): OllamaSignInService {
	return {
		checkSignInStatus: vi.fn(async () => result),
	};
}

function makeDeps(overrides: Record<string, unknown> = {}) {
	return {
		sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never,
		settingsStore: {
			getString: vi.fn((_key: string, fallback?: string) => fallback ?? "yolomatic-ollama"),
		},
		ollamaSignInService: makeService({
			signedIn: true,
			user: "alice",
			message: "You are already signed in as user 'alice'",
		}),
		...overrides,
	} as any;
}

describe("handleOllamaRoutes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it("returns false for unrelated paths", async () => {
		const handled = await handleOllamaRoutes(
			request("/api/other"),
			response(),
			makeDeps(),
			"/api/other",
		);
		expect(handled).toBe(false);
	});

	it("returns the sign-in status payload", async () => {
		const res = response();
		const deps = makeDeps();
		const handled = await handleOllamaRoutes(request("/api/ollama/signin"), res, deps, "/api/ollama/signin");

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.signedIn).toBe(true);
		expect(body.user).toBe("alice");
		expect(deps.settingsStore.getString).toHaveBeenCalledWith("ollama_container_name", "yolomatic-ollama");
		expect(deps.ollamaSignInService.checkSignInStatus).toHaveBeenCalledWith({ containerName: "yolomatic-ollama" });
	});

	it("uses the configured container name from settings", async () => {
		const res = response();
		const deps = makeDeps({
			settingsStore: {
				getString: vi.fn(() => "custom-ollama"),
			},
		});
		await handleOllamaRoutes(request("/api/ollama/signin"), res, deps, "/api/ollama/signin");
		expect(deps.ollamaSignInService.checkSignInStatus).toHaveBeenCalledWith({ containerName: "custom-ollama" });
	});

	it("passes through the not-signed-in payload", async () => {
		const res = response();
		const notSignedIn: OllamaSignInResult = {
			signedIn: false,
			signInUrl: "https://ollama.com/connect?name=x&key=y",
			message: "You need to be signed in to Ollama to run Cloud models.",
		};
		const deps = makeDeps({ ollamaSignInService: makeService(notSignedIn) });
		const handled = await handleOllamaRoutes(request("/api/ollama/signin"), res, deps, "/api/ollama/signin");

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.signedIn).toBe(false);
		expect(body.signInUrl).toBe("https://ollama.com/connect?name=x&key=y");
	});

	it("returns 500 when the settings store is missing", async () => {
		const res = response();
		const handled = await handleOllamaRoutes(
			request("/api/ollama/signin"),
			res,
			{ sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never, ollamaSignInService: makeService({ signedIn: false, message: "" }) } as any,
			"/api/ollama/signin",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toBe("Settings store not configured");
	});

	it("returns 500 when the ollama sign-in service is missing", async () => {
		const res = response();
		const handled = await handleOllamaRoutes(
			request("/api/ollama/signin"),
			res,
			{ sessionAuth: { requireAdminJson: () => true, requireAdminText: () => true, isAdminAuthorized: () => true, hasUsers: () => true } as never, settingsStore: { getString: () => "ollama" } } as any,
			"/api/ollama/signin",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toBe("Ollama sign-in service not configured");
	});

	it("returns ok=true after successfully pulling a model", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ status: "success" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const res = response();
		const handled = await handleOllamaRoutes(
			request("/api/ollama/pull", "POST", JSON.stringify({ model: "llama3" })),
			res,
			makeDeps(),
			"/api/ollama/pull",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(true);
		expect(body.error).toBeUndefined();
		expect(fetchSpy).toHaveBeenCalledWith(
			"http://127.0.0.1:11434/api/pull",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("returns ok=false with the upstream error payload when the pull fails", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ error: "pull model manifest: file does not exist" }), {
				status: 404,
				headers: { "content-type": "application/json" },
			}),
		);
		const res = response();
		const handled = await handleOllamaRoutes(
			request("/api/ollama/pull", "POST", JSON.stringify({ model: "bad-model" })),
			res,
			makeDeps(),
			"/api/ollama/pull",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(false);
		expect(body.error).toContain("pull model manifest");
	});

	it("returns ok=false when the daemon is unreachable", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
		const res = response();
		const handled = await handleOllamaRoutes(
			request("/api/ollama/pull", "POST", JSON.stringify({ model: "llama3" })),
			res,
			makeDeps(),
			"/api/ollama/pull",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(false);
		expect(body.error).toContain("connection refused");
	});

	it("returns 400 when no model identifier is provided", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const res = response();
		const handled = await handleOllamaRoutes(
			request("/api/ollama/pull", "POST", JSON.stringify({})),
			res,
			makeDeps(),
			"/api/ollama/pull",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe("Missing required field: model");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("accepts a `name` field as a fallback for the model identifier", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ status: "success" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		const res = response();
		const handled = await handleOllamaRoutes(
			request("/api/ollama/pull", "POST", JSON.stringify({ name: "llama3" })),
			res,
			makeDeps(),
			"/api/ollama/pull",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).ok).toBe(true);
		const body = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body)) as Record<
			string,
			unknown
		>;
		expect(body.model).toBe("llama3");
	});

	it("rejects unauthorized requests", async () => {
		const res = response();
		const handled = await handleOllamaRoutes(
			{ method: "GET", url: "/api/ollama/signin", headers: {} } as never,
			res,
			{ sessionAuth: { requireAdminJson: (_req: any, r: any) => { r.statusCode = 401; r.end('{"error":"Unauthorized"}'); return false; }, requireAdminText: () => false, isAdminAuthorized: () => false, hasUsers: () => true } as never, settingsStore: { getString: () => "ollama" }, ollamaSignInService: makeService({ signedIn: false, message: "" }) } as any,
			"/api/ollama/signin",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});
});