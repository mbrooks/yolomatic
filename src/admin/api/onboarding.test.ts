import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	fetchOnboardingStatus,
	verifyGitHubToken,
	generateWebhookSecret,
	listAccessibleRepositories,
	initializeWorkspaces,
	submitOnboarding,
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
				return mockOkResponse({ repositories: [{ owner: "a", repo: "b", fullName: "a/b" }] });
			});
			const result = await listAccessibleRepositories("ghp_test");
			expect(result.repositories).toHaveLength(1);
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
});
