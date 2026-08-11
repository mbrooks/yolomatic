import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetchLlmModels, fetchSettings, updateSettings } from "./settings.js";

function mockOkResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("settings API", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => mockOkResponse({}));
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	describe("fetchSettings", () => {
		it("GETs /api/settings", async () => {
			fetchSpy.mockResolvedValue(mockOkResponse({ settings: [] }));
			const result = await fetchSettings();
			expect(result.settings).toEqual([]);
			expect(fetchSpy).toHaveBeenCalledWith("/api/settings");
		});
	});

	describe("updateSettings", () => {
		it("PATCHes /api/settings with the provided body", async () => {
			fetchSpy.mockResolvedValue(mockOkResponse({ updated: ["x"], requiresRestart: [] }));
			const result = await updateSettings({ x: "y" });
			expect(result.updated).toEqual(["x"]);
			const calls = fetchSpy.mock.calls as [string, RequestInit][];
			expect(calls[0][0]).toBe("/api/settings");
			expect(calls[0][1].method).toBe("PATCH");
			expect(JSON.parse(calls[0][1].body as string)).toEqual({ x: "y" });
		});

		it("throws the returned error message when the server responds with an error", async () => {
			fetchSpy.mockResolvedValue(
				new Response(JSON.stringify({ error: "bad settings" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
			);

			await expect(updateSettings({ x: "y" })).rejects.toThrow("bad settings");
		});

		it("falls back to statusText when the error body is not JSON", async () => {
			fetchSpy.mockResolvedValue(
				new Response("not json", {
					status: 500,
					headers: { "content-type": "application/json" },
					statusText: "Server Error",
				}),
			);

			await expect(updateSettings({ x: "y" })).rejects.toThrow("Server Error");
		});

		it("omits the request body when updateSettings is called with undefined", async () => {
			fetchSpy.mockResolvedValue(mockOkResponse({ updated: [], requiresRestart: [] }));
			await updateSettings(undefined as any);
			const calls = fetchSpy.mock.calls as [string, RequestInit][];
			expect(calls[0][0]).toBe("/api/settings");
			expect(calls[0][1].method).toBe("PATCH");
			expect(calls[0][1].body).toBeUndefined();
		});
	});

	describe("fetchLlmModels", () => {
		it("GETs /api/llm/models for the openai provider", async () => {
			fetchSpy.mockResolvedValue(mockOkResponse({ models: ["gpt-4"] }));
			const result = await fetchLlmModels("openai");
			expect(result.models).toEqual(["gpt-4"]);
			expect(fetchSpy).toHaveBeenCalledWith("/api/llm/models?provider=openai");
		});

		it("GETs /api/llm/models for the ollama provider", async () => {
			fetchSpy.mockResolvedValue(mockOkResponse({ models: ["llama2"], error: "boom" }));
			const result = await fetchLlmModels("ollama");
			expect(result.models).toEqual(["llama2"]);
			expect(result.error).toBe("boom");
			expect(fetchSpy).toHaveBeenCalledWith("/api/llm/models?provider=ollama");
		});
	});
});
