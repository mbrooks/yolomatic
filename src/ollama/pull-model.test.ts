import { afterEach, describe, expect, it, vi } from "vitest";
import { pullOllamaModel } from "./pull-model.js";

function ollamaResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("pullOllamaModel", () => {
	it("returns ok=true on a successful pull and posts to the daemon-native endpoint", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(ollamaResponse({ status: "success" }));

		const result = await pullOllamaModel("llama3");

		expect(result).toEqual({ ok: true });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://127.0.0.1:11434/api/pull");
		expect(init.method).toBe("POST");
		const body = JSON.parse(String(init.body)) as Record<string, unknown>;
		expect(body.model).toBe("llama3");
		expect(body.stream).toBe(false);
	});

	it("returns ok=false with the upstream error message on a non-2xx JSON error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			ollamaResponse({ error: "pull model manifest: file does not exist" }, 404),
		);

		const result = await pullOllamaModel("nope");

		expect(result.ok).toBe(false);
		expect(result.error).toBe("pull model manifest: file does not exist");
	});

	it("returns ok=false with an HTTP status fallback when the failure body is not JSON", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("<html>oops</html>", {
				status: 500,
				headers: { "content-type": "text/html" },
			}),
		);

		const result = await pullOllamaModel("llama3");

		expect(result.ok).toBe(false);
		expect(result.error).toBe("Ollama returned HTTP 500");
	});

	it("returns ok=false with an HTTP status fallback when the JSON body cannot be parsed", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("not-json", {
				status: 404,
				headers: { "content-type": "application/json" },
			}),
		);

		const result = await pullOllamaModel("llama3");

		expect(result.ok).toBe(false);
		expect(result.error).toBe("Ollama returned HTTP 404");
	});

	it("returns ok=false when a 200 response body carries an error field", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			ollamaResponse({ error: "pull model manifest: file does not exist" }),
		);

		const result = await pullOllamaModel("nope");

		expect(result.ok).toBe(false);
		expect(result.error).toBe("pull model manifest: file does not exist");
	});

	it("returns ok=false with the underlying message when the daemon is unreachable", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED"));

		const result = await pullOllamaModel("llama3");

		expect(result.ok).toBe(false);
		expect(result.error).toBe("connect ECONNREFUSED");
	});

	it("rejects an empty model identifier without calling fetch", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const empty = await pullOllamaModel("");
		const blank = await pullOllamaModel("   ");

		expect(empty).toEqual({ ok: false, error: "Missing model identifier" });
		expect(blank).toEqual({ ok: false, error: "Missing model identifier" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("uses the configured OLLAMA_HOST and strips a trailing /v1", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(ollamaResponse({ status: "success" }));

		await pullOllamaModel("llama3", undefined, { OLLAMA_HOST: "http://ollama.internal:11434/v1" });

		expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://ollama.internal:11434/api/pull");
	});

	it("trims whitespace from the model identifier", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(ollamaResponse({ status: "success" }));

		await pullOllamaModel("  llama3:8b  ");

		const body = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body)) as Record<
			string,
			unknown
		>;
		expect(body.model).toBe("llama3:8b");
	});
});