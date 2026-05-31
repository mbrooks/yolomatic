import { type AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * Creates a TARS model registry with custom providers defined in code.
 * This replaces the previous models.json-based configuration.
 */
export function createTarsModelRegistry(authStorage: AuthStorage): ModelRegistry {
	const registry = ModelRegistry.inMemory(authStorage);

	registry.registerProvider("ollama", {
		baseUrl: "http://127.0.0.1:11434/v1",
		api: "openai-completions",
		apiKey: "ollama",
		models: [
			{
				id: "kimi-k2.6:cloud",
				name: "kimi-k2.6:cloud",
				api: "openai-completions",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 16_384,
				compat: {
					supportsDeveloperRole: false,
				},
			},
		],
	});

	return registry;
}
