import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleOllamaRoutes } from "./ollama-routes.js";
import type { OllamaSignInService, OllamaSignInResult } from "../../../ollama/signin-status.js";

function request(url: string, method = "GET"): http.IncomingMessage {
	return {
		url,
		method,
		headers: {
			authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
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
		adminUsername: "admin",
		adminPassword: "secret",
		settingsStore: {
			getString: vi.fn((_key: string, fallback?: string) => fallback ?? "yeetomatic-ollama"),
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
		expect(deps.settingsStore.getString).toHaveBeenCalledWith("ollama_container_name", "yeetomatic-ollama");
		expect(deps.ollamaSignInService.checkSignInStatus).toHaveBeenCalledWith({ containerName: "yeetomatic-ollama" });
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
			{ adminUsername: "admin", adminPassword: "secret", ollamaSignInService: makeService({ signedIn: false, message: "" }) } as any,
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
			{ adminUsername: "admin", adminPassword: "secret", settingsStore: { getString: () => "ollama" } } as any,
			"/api/ollama/signin",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toBe("Ollama sign-in service not configured");
	});

	it("rejects unauthorized requests", async () => {
		const res = response();
		const handled = await handleOllamaRoutes(
			{ method: "GET", url: "/api/ollama/signin", headers: {} } as never,
			res,
			{ adminUsername: "admin", adminPassword: "secret", settingsStore: { getString: () => "ollama" }, ollamaSignInService: makeService({ signedIn: false, message: "" }) } as any,
			"/api/ollama/signin",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});
});