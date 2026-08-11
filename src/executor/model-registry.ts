import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { OPENAI_CODEX_MODELS } from "../llm/openai-codex-models.js";
import type { ModelLookup, ModelReference } from "./model-selection.js";

/** Base URL for the OpenAI platform API (pay-as-you-go API key access). */
export const OPENAI_PROVIDER_BASE_URL = "https://api.openai.com/v1";

/** OpenAI API provider id (API-key access via the OpenAI platform API). */
export const OPENAI_PROVIDER_ID = "openai";

/**
 * Yolomatic's model registry wraps pi's `ModelRuntime` and exposes the small
 * `ModelLookup` surface used by `resolveConfiguredModel`. The underlying
 * runtime is exposed so `createAgentSession` can receive the canonical model/auth
 * runtime it expects in newer pi versions.
 */
export interface YolomaticModelRegistry extends ModelLookup<ModelReference> {
	runtime: ModelRuntime;
}

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
 *
 * Registers the Ollama provider (existing behavior) plus the OpenAI platform
 * API provider (`openai`, API-key access). OAuth-based ChatGPT Codex access
 * is no longer supported.
 */
export async function createYolomaticModelRegistry(): Promise<YolomaticModelRegistry> {
	const runtime = await ModelRuntime.create({ refreshOnCreate: false });

	runtime.registerProvider("ollama", {
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

	const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
	if (openaiApiKey) {
		runtime.registerProvider(OPENAI_PROVIDER_ID, {
			baseUrl: OPENAI_PROVIDER_BASE_URL,
			api: "openai-responses",
			apiKey: openaiApiKey,
			models: OPENAI_CODEX_MODELS,
		});
	}

	return {
		runtime,
		find(provider, modelId) {
			const model = runtime.getModel(provider, modelId);
			if (!model) return undefined;
			return { provider: model.provider, id: model.id };
		},
		getAll() {
			return runtime.getModels().map((model) => ({ provider: model.provider, id: model.id }));
		},
	};
}

export { resolveOllamaBaseUrl };
