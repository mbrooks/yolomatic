import { describe, expect, it, vi } from "vitest";
import { fetchOpenAiModels, fetchOllamaModels, resolveOllamaHost } from "./fetch-models.js";

function mockResponse(options: {
	ok: boolean;
	status: number;
	json?: () => Promise<unknown>;
	text?: () => Promise<string>;
}): Response {
	return {
		ok: options.ok,
		status: options.status,
		json: options.json ?? (async () => ({})),
		text: options.text ?? (async () => ""),
	} as Response;
}

describe("resolveOllamaHost", () => {
	it("defaults to localhost when OLLAMA_HOST is unset", () => {
		expect(resolveOllamaHost({})).toBe("http://127.0.0.1:11434");
	});

	it("strips a trailing /v1 segment", () => {
		expect(resolveOllamaHost({ OLLAMA_HOST: "http://host:11434/v1" })).toBe("http://host:11434");
		expect(resolveOllamaHost({ OLLAMA_HOST: "http://host:11434/v1/" })).toBe("http://host:11434");
	});

	it("preserves a non-/v1 path", () => {
		expect(resolveOllamaHost({ OLLAMA_HOST: "http://host:11434/path" })).toBe("http://host:11434/path");
	});

	it("handles a plain host without scheme", () => {
		expect(resolveOllamaHost({ OLLAMA_HOST: "http://host:11434" })).toBe("http://host:11434");
	});

	it("falls back to string handling when URL parsing fails", () => {
		expect(resolveOllamaHost({ OLLAMA_HOST: "host/v1" })).toBe("host");
	});

	it("returns the raw host when string parsing cannot strip /v1", () => {
		expect(resolveOllamaHost({ OLLAMA_HOST: "host" })).toBe("host");
	});
});

describe("fetchOpenAiModels", () => {
	it("returns an empty list when no API key is provided", async () => {
		const result = await fetchOpenAiModels("");
		expect(result.models).toEqual([]);
		expect(result.error).toBe("Enter an OpenAI API key to load models");
	});

	it("returns an empty list when the response data field is missing", async () => {
		const fetchImpl = vi.fn(async () =>
			mockResponse({
				ok: true,
				status: 200,
				json: async () => ({}),
			}),
		);
		const result = await fetchOpenAiModels("sk-test", fetchImpl);
		expect(result.models).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	it("uses the status-based message when the error object has no message", async () => {
		const fetchImpl = vi.fn(async () =>
			mockResponse({
				ok: false,
				status: 403,
				json: async () => ({ error: { code: "forbidden" } }),
			}),
		);
		const result = await fetchOpenAiModels("sk-test", fetchImpl);
		expect(result.models).toEqual([]);
		expect(result.error).toContain("HTTP 403");
	});

	it("survives a thrown non-Error value", async () => {
		const fetchImpl = vi.fn(async () => {
			throw "boom";
		});
		const result = await fetchOpenAiModels("sk-test", fetchImpl);
		expect(result.models).toEqual([]);
		expect(result.error).toContain("boom");
	});

	it("returns sorted model ids on success", async () => {
		const fetchImpl = vi.fn(async () =>
			mockResponse({
				ok: true,
				status: 200,
				json: async () => ({
					data: [{ id: "gpt-4" }, { id: "gpt-3.5" }, { id: "" }],
				}),
			}),
		);
		const result = await fetchOpenAiModels("sk-test", fetchImpl);

		expect(result.models).toEqual(["gpt-3.5", "gpt-4"]);
		expect(result.error).toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/models", {
			headers: { Authorization: "Bearer sk-test" },
		});
	});

	it("uses global fetch when no implementation is injected", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			mockResponse({
				ok: true,
				status: 200,
				json: async () => ({ data: [{ id: "gpt-4" }] }),
			}),
		);
		const result = await fetchOpenAiModels("sk-global");
		expect(result.models).toEqual(["gpt-4"]);
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://api.openai.com/v1/models",
			expect.objectContaining({ headers: { Authorization: "Bearer sk-global" } }),
		);
		fetchSpy.mockRestore();
	});

	it("returns an empty list with an error on HTTP failure", async () => {
		const fetchImpl = vi.fn(async () =>
			mockResponse({
				ok: false,
				status: 401,
				json: async () => ({ error: { message: "Invalid authentication" } }),
			}),
		);
		const result = await fetchOpenAiModels("sk-bad", fetchImpl);

		expect(result.models).toEqual([]);
		expect(result.error).toContain("Invalid authentication");
	});

	it("falls back to the HTTP status message when OpenAI error JSON cannot be parsed", async () => {
		const fetchImpl = vi.fn(async () =>
			mockResponse({
				ok: false,
				status: 500,
				json: async () => {
					throw new Error("invalid JSON");
				},
			}),
		);
		const result = await fetchOpenAiModels("sk-bad", fetchImpl);
		expect(result.models).toEqual([]);
		expect(result.error).toContain("HTTP 500");
	});

	it("returns an empty list with an error on network failure", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("network down");
		});
		const result = await fetchOpenAiModels("sk-test", fetchImpl);

		expect(result.models).toEqual([]);
		expect(result.error).toContain("network down");
	});
});

describe("fetchOllamaModels", () => {
	it("returns sorted model names on success", async () => {
		const fetchImpl = vi.fn(async () =>
			mockResponse({
				ok: true,
				status: 200,
				json: async () => ({
					models: [{ name: "llama2" }, { name: "mistral" }, { name: "" }],
				}),
			}),
		);
		const result = await fetchOllamaModels("http://host:11434", fetchImpl);

		expect(result.models).toEqual(["llama2", "mistral"]);
		expect(result.error).toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledWith("http://host:11434/api/tags");
	});

	it("returns an empty list when the response models field is missing", async () => {
		const fetchImpl = vi.fn(async () =>
			mockResponse({
				ok: true,
				status: 200,
				json: async () => ({}),
			}),
		);
		const result = await fetchOllamaModels("http://host:11434", fetchImpl);
		expect(result.models).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	it("returns an empty list with an error when Ollama is unreachable", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("fetch failed");
		});
		const result = await fetchOllamaModels("http://host:11434", fetchImpl);

		expect(result.models).toEqual([]);
		expect(result.error).toContain("Ollama is not reachable");
	});

	it("survives a thrown non-Error value", async () => {
		const fetchImpl = vi.fn(async () => {
			throw "boom";
		});
		const result = await fetchOllamaModels("http://host:11434", fetchImpl);
		expect(result.models).toEqual([]);
		expect(result.error).toContain("boom");
	});

	it("returns an empty list with an error on non-OK response", async () => {
		const fetchImpl = vi.fn(async () => mockResponse({ ok: false, status: 503 }));
		const result = await fetchOllamaModels("http://host:11434", fetchImpl);

		expect(result.models).toEqual([]);
		expect(result.error).toContain("Ollama is not reachable");
		expect(result.error).toContain("503");
	});
});
