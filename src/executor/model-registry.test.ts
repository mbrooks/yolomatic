import { describe, expect, it, vi } from "vitest";
import { createTarsModelRegistry, resolveOllamaBaseUrl } from "./model-registry.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	AuthStorage: { create: vi.fn(() => ({})) },
	ModelRegistry: {
		inMemory: vi.fn(() => ({
			registerProvider: vi.fn(),
		})),
	},
}));

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

describe("createTarsModelRegistry", () => {
	it("creates an in-memory registry with ollama provider", () => {
		const mockAuthStorage = {};
		(AuthStorage.create as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthStorage);
		const mockRegistry = { registerProvider: vi.fn() };
		(ModelRegistry.inMemory as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry);

		const registry = createTarsModelRegistry(mockAuthStorage as never);

		expect(ModelRegistry.inMemory).toHaveBeenCalledWith(mockAuthStorage);
		expect(mockRegistry.registerProvider).toHaveBeenCalledWith("ollama", expect.objectContaining({
			baseUrl: "http://127.0.0.1:11434/v1",
			api: "openai-completions",
			apiKey: "ollama",
			models: expect.arrayContaining([
				expect.objectContaining({ id: "kimi-k2.7-code:cloud" }),
				expect.objectContaining({ id: "glm-5.2:cloud" }),
			]),
		}));
		expect(registry).toBe(mockRegistry);
	});
});

describe("resolveOllamaBaseUrl", () => {
	it("defaults to localhost with /v1", () => {
		expect(resolveOllamaBaseUrl({})).toBe("http://127.0.0.1:11434/v1");
	});

	it("appends /v1 to a configured host", () => {
		expect(resolveOllamaBaseUrl({ OLLAMA_HOST: "http://ollama.internal:11434" })).toBe(
			"http://ollama.internal:11434/v1",
		);
	});

	it("preserves an explicit /v1 path", () => {
		expect(resolveOllamaBaseUrl({ OLLAMA_HOST: "http://ollama.internal:11434/v1" })).toBe(
			"http://ollama.internal:11434/v1",
		);
	});

	it("preserves nested base paths when appending /v1", () => {
		expect(resolveOllamaBaseUrl({ OLLAMA_HOST: "http://ollama.internal:11434/proxy/ollama/" })).toBe(
			"http://ollama.internal:11434/proxy/ollama/v1",
		);
	});
});
