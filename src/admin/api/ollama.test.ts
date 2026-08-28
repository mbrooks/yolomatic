import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOllamaSignInStatus, pullOllamaModel } from "./ollama.js";

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

describe("pullOllamaModel", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("POSTs the model identifier to /api/ollama/pull and returns the parsed result", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse({ ok: true }));

		const result = await pullOllamaModel("llama3:8b");

		expect(result).toEqual({ ok: true });
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/ollama/pull");
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual({ model: "llama3:8b" });
	});

	it("returns a failed pull result from the API payload", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ ok: false, error: "pull model manifest: file does not exist" }),
		);

		const result = await pullOllamaModel("nope");

		expect(result.ok).toBe(false);
		expect(result.error).toContain("pull model manifest");
	});
});