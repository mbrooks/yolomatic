import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createYolomaticModelRegistry,
	resolveOllamaBaseUrl,
	OPENAI_PROVIDER_BASE_URL,
	OPENAI_PROVIDER_ID,
} from "./model-registry.js";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

vi.mock("@earendil-works/pi-coding-agent", () => ({
	ModelRuntime: {
		create: vi.fn(),
	},
}));

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

function mockRuntime() {
	return {
		registerProvider: vi.fn(),
		getModel: vi.fn(),
		getModels: vi.fn(() => [] as Array<{ provider: string; id: string }>),
	};
}

function stubRuntime(mock: ReturnType<typeof mockRuntime>) {
	(ModelRuntime.create as ReturnType<typeof vi.fn>).mockResolvedValue(mock);
}

describe("createYolomaticModelRegistry", () => {
	beforeEach(() => {
		fetchSpy.mockReset();
		// Default: Ollama tag listing unavailable, so the registry falls back
		// to its built-in curated list.
		fetchSpy.mockResolvedValue({
			ok: false,
			status: 500,
			json: async () => ({}),
		});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("creates a runtime-backed registry with the ollama provider", async () => {
		const mock = mockRuntime();
		stubRuntime(mock);

		const registry = await createYolomaticModelRegistry();

		expect(ModelRuntime.create).toHaveBeenCalledWith(expect.objectContaining({ refreshOnCreate: false }));
		expect(mock.registerProvider).toHaveBeenCalledWith(
			"ollama",
			expect.objectContaining({
				baseUrl: "http://127.0.0.1:11434/v1",
				api: "openai-completions",
				apiKey: "ollama",
				models: expect.arrayContaining([
					expect.objectContaining({ id: "kimi-k2.7-code:cloud" }),
					expect.objectContaining({ id: "glm-5.2:cloud" }),
				]),
			}),
		);
		expect(registry.runtime).toBe(mock);
	});

	it("registers the openai provider against the platform API", async () => {
		const mock = mockRuntime();
		stubRuntime(mock);

		await createYolomaticModelRegistry({ openaiApiKey: "sk-test-openai-key" });

		expect(mock.registerProvider).toHaveBeenCalledWith(
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

	it("registers only ollama when no OpenAI API key is configured", async () => {
		const mock = mockRuntime();
		stubRuntime(mock);

		await createYolomaticModelRegistry({ openaiApiKey: "" });

		expect(mock.registerProvider.mock.calls.map(([provider]) => provider)).toEqual(["ollama"]);
	});

	it("registers only ollama when no options are provided", async () => {
		const mock = mockRuntime();
		stubRuntime(mock);

		await createYolomaticModelRegistry();

		expect(mock.registerProvider.mock.calls.map(([provider]) => provider)).toEqual(["ollama"]);
	});

	it("registers both providers in order (ollama, openai)", async () => {
		const mock = mockRuntime();
		stubRuntime(mock);

		await createYolomaticModelRegistry({ openaiApiKey: "sk-test-openai-key" });

		const registeredNames = mock.registerProvider.mock.calls.map((call) => call[0]);
		expect(registeredNames).toEqual(["ollama", OPENAI_PROVIDER_ID]);
	});

	it("uses the injected ollamaHost to resolve the ollama base URL", async () => {
		const mock = mockRuntime();
		stubRuntime(mock);

		await createYolomaticModelRegistry({ ollamaHost: "http://ollama.internal:11434" });

		expect(mock.registerProvider).toHaveBeenCalledWith(
			"ollama",
			expect.objectContaining({ baseUrl: "http://ollama.internal:11434/v1" }),
		);
	});

	it("registers locally installed ollama models returned by /api/tags", async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ models: [{ name: "glm-5.3-flash:cloud" }] }),
		});

		const mock = mockRuntime();
		stubRuntime(mock);

		await createYolomaticModelRegistry();

		expect(mock.registerProvider).toHaveBeenCalledWith(
			"ollama",
			expect.objectContaining({
				models: expect.arrayContaining([
					expect.objectContaining({ id: "glm-5.3-flash:cloud" }),
				]),
			}),
		);
	});

	it("exposes a lookup that maps runtime models to provider/id references", async () => {
		const mock = mockRuntime();
		mock.getModels.mockReturnValue([
			{ provider: "ollama", id: "kimi-k2.7-code:cloud" },
			{ provider: "openai", id: "gpt-5.2" },
		]);
		mock.getModel.mockImplementation((provider: string, id: string) =>
			mock.getModels().find((m: { provider: string; id: string }) => m.provider === provider && m.id === id),
		);
		stubRuntime(mock);

		const registry = await createYolomaticModelRegistry();

		expect(registry.getAll()).toEqual([
			{ provider: "ollama", id: "kimi-k2.7-code:cloud" },
			{ provider: "openai", id: "gpt-5.2" },
		]);
		expect(registry.find("openai", "gpt-5.2")).toEqual({ provider: "openai", id: "gpt-5.2" });
		expect(registry.find("openai", "missing")).toBeUndefined();
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
