/**
 * Server-side helpers for fetching available model identifiers from LLM
 * providers. These functions keep provider credentials (the OpenAI API key)
 * on the control plane; callers only receive sanitized model id/name lists.
 */

export const PRIVATE_MODEL_VALUE = "private";

export interface LlmModelListResult {
	/** Available model identifiers for the provider, sorted alphabetically. */
	models: string[];
	/** Human-readable reason the list could not be loaded, if applicable. */
	error?: string;
}

/** OpenAI /v1/models payload shape. */
interface OpenAiModelsResponse {
	data?: Array<{ id?: string }>;
	error?: { message?: string };
}

/** Ollama website library /api/tags payload shape. */
interface OllamaTagsResponse {
	models?: Array<{ name?: string }>;
}

const OLLAMA_LIBRARY_TAGS_URL = "https://ollama.com/api/tags";

function getFetch(fetchImpl?: typeof fetch): typeof fetch {
	return fetchImpl ?? globalThis.fetch;
}

/**
 * Resolves the base Ollama host URL from the environment.
 * Strips a trailing `/v1` segment because the Ollama-native `/api/tags`
 * endpoint lives at the host root, not under the OpenAI-compatible `/v1`
 * prefix used by the runtime.
 */
export function resolveOllamaHost(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.OLLAMA_HOST?.trim();
	if (!configured) {
		return "http://127.0.0.1:11434";
	}

	try {
		const url = new URL(configured);
		let normalizedPath = url.pathname.replace(/\/+$/u, "");
		if (normalizedPath === "/v1") {
			normalizedPath = "";
		}
		url.pathname = normalizedPath;
		return url.toString().replace(/\/+$/u, "");
	} catch {
		const trimmed = configured.replace(/\/+$/u, "");
		return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
	}
}

/**
 * Fetches available model ids from the OpenAI platform API.
 * Returns an empty list with a descriptive error when no API key is supplied
 * or the API call fails, so the caller can degrade gracefully.
 */
export async function fetchOpenAiModels(
	apiKey: string,
	fetchImpl?: typeof fetch,
): Promise<LlmModelListResult> {
	const key = apiKey.trim();
	if (!key) {
		return { models: [], error: "Enter an OpenAI API key to load models" };
	}

	const fetchFn = getFetch(fetchImpl);
	try {
		const response = await fetchFn("https://api.openai.com/v1/models", {
			headers: {
				Authorization: `Bearer ${key}`,
			},
		});

		if (!response.ok) {
			let message = `OpenAI returned HTTP ${response.status}`;
			try {
				const body = (await response.json()) as OpenAiModelsResponse;
				if (body.error?.message) {
					message = body.error.message;
				}
			} catch {
				// ignore parse errors and use the status-based message
			}
			return { models: [], error: `Could not load OpenAI models: ${message}` };
		}

		const body = (await response.json()) as OpenAiModelsResponse;
		const ids = (body.data ?? [])
			.map((model) => model.id)
			.filter((id): id is string => typeof id === "string" && id.length > 0)
			.sort((a, b) => a.localeCompare(b));
		return { models: ids };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { models: [], error: `Could not load OpenAI models: ${message}` };
	}
}

/**
 * Fetches available model names from the Ollama website library API.
 *
 * This intentionally does **not** talk to the local Ollama daemon because
 * `/api/tags` on the daemon only lists already-installed models. The website
 * API returns the broader catalog available for pulling.
 */
export async function fetchOllamaModels(fetchImpl?: typeof fetch): Promise<LlmModelListResult> {
	const fetchFn = getFetch(fetchImpl);

	try {
		const response = await fetchFn(OLLAMA_LIBRARY_TAGS_URL);

		if (!response.ok) {
			return {
				models: [],
				error: `Could not load Ollama models: Ollama library returned HTTP ${response.status}`,
			};
		}

		const body = (await response.json()) as OllamaTagsResponse;
		const names = (body.models ?? [])
			.map((model) => model.name)
			.filter((name): name is string => typeof name === "string" && name.length > 0)
			.sort((a, b) => a.localeCompare(b));
		return { models: names };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			models: [],
			error: `Could not load Ollama models: ${message}`,
		};
	}
}
