import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	fetchOnboardingStatus,
	fetchOnboardingConfig,
	verifyGitHubToken,
	generateWebhookSecret,
	listAccessibleRepositories,
	initializeWorkspaces,
	submitOnboarding,
	fetchOnboardingOllamaSignInStatus,
	fetchOnboardingLlmModels,
	isSecretField,
} from "./onboarding.js";

function mockOkResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("onboarding API", () => {
	let fetchSpy: any;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return mockOkResponse({});
		});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	describe("isSecretField", () => {
		it("returns true for an object with { configured }", () => {
			expect(isSecretField({ configured: true })).toBe(true);
			expect(isSecretField({ configured: false })).toBe(true);
		});

		it("returns false for plain strings", () => {
			expect(isSecretField("")).toBe(false);
			expect(isSecretField("token")).toBe(false);
		});

		it("returns false for invalid shapes", () => {
			expect(isSecretField(null as any)).toBe(false);
			expect(isSecretField({} as any)).toBe(false);
			expect(isSecretField({ configured: "yes" } as any)).toBe(false);
		});
	});

	describe("fetchOnboardingStatus", () => {
		it("calls /api/onboarding/status", async () => {
			fetchSpy.mockImplementation(async () => {
				return mockOkResponse({ complete: false, missing: ["github_token"] });
			});
			const result = await fetchOnboardingStatus();
			expect(result.complete).toBe(false);
			const calls = fetchSpy.mock.calls as [string, RequestInit][];
			expect(calls[0][0]).toBe("/api/onboarding/status");
		});
	});

	describe("fetchOnboardingConfig", () => {
		it("calls /api/onboarding/config", async () => {
			fetchSpy.mockImplementation(async () => {
				return mockOkResponse({
					admin_username: "bob",
					admin_password: { configured: true },
					github_token: { configured: false },
					github_username: "",
					github_event_mode: "polling",
					github_poll_interval_ms: "15000",
					webhook_secret: { configured: true },
				});
			});
			const result = await fetchOnboardingConfig();
			expect(result.admin_username).toBe("bob");
			expect(result.admin_password).toEqual({ configured: true });
			expect(result.github_event_mode).toBe("polling");
			expect(result.github_poll_interval_ms).toBe("15000");
			const calls = fetchSpy.mock.calls as [string, RequestInit | undefined][];
			expect(calls[0][0]).toBe("/api/onboarding/config");
			expect(calls[0][1]).toBeUndefined();
		});
	});

	describe("verifyGitHubToken", () => {
		it("calls /api/onboarding/verify-token with token", async () => {
			fetchSpy.mockImplementation(async () => {
				return mockOkResponse({ username: "octocat" });
			});
			const result = await verifyGitHubToken("ghp_test");
			expect(result.username).toBe("octocat");
			const calls = fetchSpy.mock.calls as [string, RequestInit][];
			expect(calls[0][0]).toBe("/api/onboarding/verify-token");
			const body = JSON.parse(calls[0][1].body as string);
			expect(body.token).toBe("ghp_test");
		});
	});

	describe("generateWebhookSecret", () => {
		it("calls /api/onboarding/generate-secret", async () => {
			fetchSpy.mockImplementation(async () => {
				return mockOkResponse({ secret: "abc123" });
			});
			const result = await generateWebhookSecret();
			expect(result.secret).toBe("abc123");
			const calls = fetchSpy.mock.calls as [string, RequestInit][];
			expect(calls[0][0]).toBe("/api/onboarding/generate-secret");
			expect(calls[0][1].method).toBe("POST");
		});
	});

	describe("listAccessibleRepositories", () => {
		it("calls /api/onboarding/repos with token", async () => {
			fetchSpy.mockImplementation(async () => {
				return mockOkResponse({
					repositories: [{ owner: "a", repo: "b", fullName: "a/b" }],
					configured: [{ owner: "a", repo: "b" }],
				});
			});
			const result = await listAccessibleRepositories("ghp_test");
			expect(result.repositories).toHaveLength(1);
			expect(result.configured).toEqual([{ owner: "a", repo: "b" }]);
			const calls = fetchSpy.mock.calls as [string, RequestInit][];
			expect(calls[0][0]).toBe("/api/onboarding/repos");
			const body = JSON.parse(calls[0][1].body as string);
			expect(body.token).toBe("ghp_test");
		});
	});

	describe("initializeWorkspaces", () => {
		it("calls /api/onboarding/init-workspaces with payload", async () => {
			fetchSpy.mockImplementation(async () => {
				return mockOkResponse({ initialized: ["a/b"] });
			});
			const result = await initializeWorkspaces({
				token: "ghp_test",
				username: "user",
				repos: [{ owner: "a", repo: "b" }],
			});
			expect(result.initialized).toEqual(["a/b"]);
			const calls = fetchSpy.mock.calls as [string, RequestInit][];
			expect(calls[0][0]).toBe("/api/onboarding/init-workspaces");
			const body = JSON.parse(calls[0][1].body as string);
			expect(body.token).toBe("ghp_test");
			expect(body.repos).toEqual([{ owner: "a", repo: "b" }]);
		});
	});

	describe("submitOnboarding", () => {
		it("calls /api/onboarding with body", async () => {
			fetchSpy.mockImplementation(async () => {
				return mockOkResponse({ success: true, requiresRestart: ["github_token"] });
			});
			const result = await submitOnboarding({
				github_token: "tok",
				github_username: "user",
				webhook_secret: "shh",
				admin_username: "admin",
				admin_password: "pass",
			});
			expect(result.success).toBe(true);
			const calls = fetchSpy.mock.calls as [string, RequestInit][];
			expect(calls[0][0]).toBe("/api/onboarding");
			const body = JSON.parse(calls[0][1].body as string);
			expect(body.github_token).toBe("tok");
		});
	});

	describe("fetchOnboardingOllamaSignInStatus", () => {
		it("GETs /api/onboarding/ollama-signin and returns the parsed status", async () => {
			fetchSpy.mockImplementation(async () => {
				return mockOkResponse({
					signedIn: true,
					user: "alice",
					message: "You are already signed in as user 'alice'",
				});
			});
			const result = await fetchOnboardingOllamaSignInStatus();
			expect(result.signedIn).toBe(true);
			expect(result.user).toBe("alice");
			const calls = fetchSpy.mock.calls as [string, RequestInit | undefined][];
			expect(calls[0][0]).toBe("/api/onboarding/ollama-signin");
			expect(calls[0][1]).toBeUndefined();
		});

		it("passes through the not-signed-in shape with a sign-in URL", async () => {
			fetchSpy.mockImplementation(async () => {
				return mockOkResponse({
					signedIn: false,
					signInUrl: "https://ollama.com/connect?name=x&key=y",
					message: "You need to be signed in.",
				});
			});
			const result = await fetchOnboardingOllamaSignInStatus();
			expect(result.signedIn).toBe(false);
			expect(result.signInUrl).toBe("https://ollama.com/connect?name=x&key=y");
		});

		it("throws when the response is not ok", async () => {
			fetchSpy.mockImplementation(async () => {
				return new Response(JSON.stringify({ error: "boom" }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			});
			await expect(fetchOnboardingOllamaSignInStatus()).rejects.toThrow("HTTP 500");
		});
	});

	describe("fetchOnboardingLlmModels", () => {
		it("GETs /api/onboarding/llm/models for the requested provider", async () => {
			fetchSpy.mockImplementation(async () => mockOkResponse({ models: ["gpt-4"] }));
			const result = await fetchOnboardingLlmModels("openai");
			expect(result.models).toEqual(["gpt-4"]);
			const calls = fetchSpy.mock.calls as [string, RequestInit | undefined][];
			expect(calls[0][0]).toBe("/api/onboarding/llm/models?provider=openai");
		});

		it("includes the submitted API key in the query string", async () => {
			fetchSpy.mockImplementation(async () => mockOkResponse({ models: ["gpt-4"] }));
			await fetchOnboardingLlmModels("openai", "sk-wizard");
			const calls = fetchSpy.mock.calls as [string, RequestInit | undefined][];
			expect(calls[0][0]).toBe("/api/onboarding/llm/models?provider=openai&apiKey=sk-wizard");
		});
	});
});
