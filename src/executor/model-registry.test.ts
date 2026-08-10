import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createYolomaticModelRegistry,
	resolveOllamaBaseUrl,
	OPENAI_PROVIDER_BASE_URL,
	OPENAI_PROVIDER_ID,
} from "./model-registry.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	AuthStorage: { create: vi.fn(() => ({})) },
	ModelRegistry: {
		inMemory: vi.fn(() => ({
			registerProvider: vi.fn(),
		})),
	},
}));

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

describe("createYolomaticModelRegistry", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("creates an in-memory registry with the ollama provider", () => {
		const mockAuthStorage = {};
		(AuthStorage.create as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthStorage);
		const mockRegistry = { registerProvider: vi.fn() };
		(ModelRegistry.inMemory as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry);

		const registry = createYolomaticModelRegistry(mockAuthStorage as never);

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

	it("registers the openai provider against the platform API", () => {
		const mockAuthStorage = {};
		(AuthStorage.create as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthStorage);
		const mockRegistry = { registerProvider: vi.fn() };
		(ModelRegistry.inMemory as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry);
		vi.stubEnv("OPENAI_API_KEY", "sk-test-openai-key");

		createYolomaticModelRegistry(mockAuthStorage as never);

		expect(mockRegistry.registerProvider).toHaveBeenCalledWith(
			OPENAI_PROVIDER_ID,
			expect.objectContaining({
				baseUrl: OPENAI_PROVIDER_BASE_URL,
				api: "openai-responses",
				apiKey: "sk-test-openai-key",
				models: expect.arrayContaining([
					expect.objectContaining({ id: "gpt-5.2", api: "openai-responses" }),
					expect.objectContaining({ id: "gpt-5.2-codex", api: "openai-responses" }),
					expect.objectContaining({ id: "gpt-5.1-codex", api: "openai-responses" }),
				]),
			}),
		);
	});

	it("registers only ollama when no OpenAI API key is configured", () => {
		const mockRegistry = { registerProvider: vi.fn() };
		(ModelRegistry.inMemory as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry);
		vi.stubEnv("OPENAI_API_KEY", "");

		createYolomaticModelRegistry({} as never);

		expect(mockRegistry.registerProvider.mock.calls.map(([provider]) => provider)).toEqual(["ollama"]);
	});

	it("registers both providers in order (ollama, openai)", () => {
		const mockAuthStorage = {};
		(AuthStorage.create as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthStorage);
		const registerProvider = vi.fn();
		(ModelRegistry.inMemory as ReturnType<typeof vi.fn>).mockReturnValue({ registerProvider });
		vi.stubEnv("OPENAI_API_KEY", "sk-test-openai-key");

		createYolomaticModelRegistry(mockAuthStorage as never);

		const registeredNames = registerProvider.mock.calls.map((call) => call[0]);
		expect(registeredNames).toEqual(["ollama", OPENAI_PROVIDER_ID]);
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
