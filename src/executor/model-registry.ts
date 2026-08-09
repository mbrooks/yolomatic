import { type AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

function resolveOllamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	const configuredHost = env.OLLAMA_HOST?.trim();
	if (!configuredHost) {
		return "http://127.0.0.1:11434/v1";
	}

	try {
		const url = new URL(configuredHost);
		const normalizedPath = url.pathname.replace(/\/+$/u, "");
		if (normalizedPath === "/v1") {
			return url.toString();
		}
		url.pathname = normalizedPath ? `${normalizedPath}/v1` : "/v1";
		return url.toString();
	} catch {
		const trimmed = configuredHost.replace(/\/+$/u, "");
		return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
	}
}

/**
 * Creates a Yolomatic model registry with custom providers defined in code.
 * This replaces the previous models.json-based configuration.
 */
export function createYolomaticModelRegistry(authStorage: AuthStorage): ModelRegistry {
	const registry = ModelRegistry.inMemory(authStorage);

	registry.registerProvider("ollama", {
		baseUrl: resolveOllamaBaseUrl(),
		api: "openai-completions",
		apiKey: "ollama",
		models: [
			{
				id: "kimi-k2.7-code:cloud",
				name: "kimi-k2.7-code:cloud",
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
			{
				id: "glm-5.2:cloud",
				name: "glm-5.2:cloud",
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

export { resolveOllamaBaseUrl };
