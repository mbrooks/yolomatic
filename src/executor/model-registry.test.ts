import { describe, expect, it, vi } from "vitest";
import { createTarsModelRegistry } from "./model-registry.js";

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
