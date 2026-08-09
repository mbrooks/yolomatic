import { type AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Base URL for the OpenAI platform API (pay-as-you-go API key access). */
export const OPENAI_PROVIDER_BASE_URL = "https://api.openai.com/v1";
/** Base URL for the ChatGPT Plus/Pro Codex OAuth backend. */
export const OPENAI_CODEX_PROVIDER_BASE_URL = "https://chatgpt.com/backend-api";

/** OpenAI API provider id (API-key access via the OpenAI platform API). */
export const OPENAI_PROVIDER_ID = "openai";
/** OpenAI Codex provider id (ChatGPT Plus/Pro subscription OAuth access). */
export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

/**
 * Shape of a registered provider model entry, matching the subset of
 * pi's `ProviderConfigInput.models` item Yolomatic uses. Declared locally
 * because `ProviderConfigInput` is not re-exported by the pi package.
 */
interface RegisteredProviderModel {
	id: string;
	name: string;
	api: "openai-responses" | "openai-codex-responses";
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
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
 * Curated model entries for the OpenAI platform API (API-key) provider.
 * Mirrors the `openai` provider entries pi-ai catalogues so a configured
 * `openai` model resolves through Yolomatic's in-memory registry instead of
 * falling back to pi's built-in defaults.
 */
const OPENAI_MODELS: RegisteredProviderModel[] = [
	{
		id: "gpt-5.2",
		name: "GPT-5.2",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { off: "none", xhigh: "xhigh" },
		input: ["text", "image"],
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	},
	{
		id: "gpt-5.2-codex",
		name: "GPT-5.2 Codex",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { off: null, xhigh: "xhigh" },
		input: ["text", "image"],
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	},
	{
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { off: null, xhigh: "xhigh" },
		input: ["text", "image"],
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	},
];

/**
 * Curated model entries for the OpenAI Codex (ChatGPT OAuth) provider. These
 * are the gpt-5.x codex models pi-ai catalogues for the `openai-codex`
 * provider, reachable via a ChatGPT Plus/Pro subscription rather than an API
 * key.
 */
const OPENAI_CODEX_MODELS: RegisteredProviderModel[] = [
	{
		id: "gpt-5.2",
		name: "GPT-5.2",
		api: "openai-codex-responses",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text", "image"],
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	},
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		api: "openai-codex-responses",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text", "image"],
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-codex-responses",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text", "image"],
		cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	},
];

/**
 * Creates a Yolomatic model registry with custom providers defined in code.
 * This replaces the previous models.json-based configuration.
 *
 * Registers the Ollama provider (existing behavior) plus first-class OpenAI
 * providers: `openai` (platform API key) and `openai-codex` (ChatGPT Plus/Pro
 * OAuth). OAuth credentials for `openai-codex` are resolved at request time by
 * pi's `AuthStorage` from `auth.json` (see `design/architecture.md`), so the
 * registry registration only declares the provider shape and model catalogue.
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

	registry.registerProvider(OPENAI_PROVIDER_ID, {
		baseUrl: OPENAI_PROVIDER_BASE_URL,
		api: "openai-responses",
		models: OPENAI_MODELS,
	});

	registry.registerProvider(OPENAI_CODEX_PROVIDER_ID, {
		baseUrl: OPENAI_CODEX_PROVIDER_BASE_URL,
		api: "openai-codex-responses",
		models: OPENAI_CODEX_MODELS,
	});

	return registry;
}

export { resolveOllamaBaseUrl };
