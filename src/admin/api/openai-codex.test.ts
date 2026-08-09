import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchOpenAICodexStatus,
	beginOpenAICodexLogin,
	logoutOpenAICodex,
	fetchOnboardingOpenAICodexStatus,
	beginOnboardingOpenAICodexLogin,
	logoutOnboardingOpenAICodex,
} from "./openai-codex.js";

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("openai-codex api client", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("GETs /api/openai-codex/status and returns the parsed status", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ signedIn: true, account: "chatgpt-user", message: "ok" }),
		);
		const result = await fetchOpenAICodexStatus();
		expect(fetchSpy).toHaveBeenCalledWith("/api/openai-codex/status");
		expect(result).toEqual({ signedIn: true, account: "chatgpt-user", message: "ok" });
	});

	it("POSTs /api/openai-codex/login and returns the authorization URL", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ authUrl: "https://auth.openai.com/authorize?state=abc" }),
		);
		const result = await beginOpenAICodexLogin();
		expect(fetchSpy).toHaveBeenCalledWith("/api/openai-codex/login", expect.objectContaining({ method: "POST" }));
		expect(result).toEqual({ authUrl: "https://auth.openai.com/authorize?state=abc" });
	});

	it("POSTs /api/openai-codex/logout and reports success", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ success: true }));
		const result = await logoutOpenAICodex();
		expect(fetchSpy).toHaveBeenCalledWith("/api/openai-codex/logout", expect.objectContaining({ method: "POST" }));
		expect(result).toEqual({ success: true });
	});

	it("GETs /api/onboarding/openai-codex-status for the onboarding-scoped flow", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ signedIn: false, message: "Not signed in with ChatGPT." }),
		);
		const result = await fetchOnboardingOpenAICodexStatus();
		expect(fetchSpy).toHaveBeenCalledWith("/api/onboarding/openai-codex-status");
		expect(result).toEqual({ signedIn: false, message: "Not signed in with ChatGPT." });
	});

	it("POSTs /api/onboarding/openai-codex-login for the onboarding-scoped flow", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ authUrl: "https://auth.openai.com/authorize?state=onb" }),
		);
		const result = await beginOnboardingOpenAICodexLogin();
		expect(fetchSpy).toHaveBeenCalledWith("/api/onboarding/openai-codex-login", expect.objectContaining({ method: "POST" }));
		expect(result).toEqual({ authUrl: "https://auth.openai.com/authorize?state=onb" });
	});

	it("POSTs /api/onboarding/openai-codex-logout for the onboarding-scoped flow", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ success: true }));
		const result = await logoutOnboardingOpenAICodex();
		expect(fetchSpy).toHaveBeenCalledWith("/api/onboarding/openai-codex-logout", expect.objectContaining({ method: "POST" }));
		expect(result).toEqual({ success: true });
	});

	it("throws when the status response is not ok", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "boom" }, 500));
		await expect(fetchOpenAICodexStatus()).rejects.toThrow("HTTP 500");
	});
});