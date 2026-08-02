import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOllamaSignInStatus } from "./ollama.js";

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("fetchOllamaSignInStatus", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("GETs /api/ollama/signin and returns the parsed status", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ signedIn: true, user: "alice", message: "ok" }),
		);
		const result = await fetchOllamaSignInStatus();
		expect(fetchSpy).toHaveBeenCalledWith("/api/ollama/signin");
		expect(result).toEqual({ signedIn: true, user: "alice", message: "ok" });
	});

	it("throws when the response is not ok", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "boom" }, 500));
		await expect(fetchOllamaSignInStatus()).rejects.toThrow("HTTP 500");
	});
});