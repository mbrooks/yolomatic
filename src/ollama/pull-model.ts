import { resolveOllamaHost } from "../llm/fetch-models.js";

export interface OllamaPullResult {
	ok: boolean;
	error?: string;
}

interface OllamaPullResponse {
	error?: string;
	status?: string;
}

function getFetch(fetchImpl?: typeof fetch): typeof fetch {
	return fetchImpl ?? globalThis.fetch;
}

/**
 * Best-effort attempt to pull a model into the local Ollama daemon.
 *
 * Uses the daemon-native endpoint at `${OLLAMA_HOST}/api/pull` (not the OpenAI
 * compatible `/v1` prefix).
 */
export async function pullOllamaModel(
	model: string,
	fetchImpl?: typeof fetch,
	env: NodeJS.ProcessEnv = process.env,
): Promise<OllamaPullResult> {
	const trimmed = model.trim();
	if (!trimmed) {
		return { ok: false, error: "Missing model identifier" };
	}

	const fetchFn = getFetch(fetchImpl);
	const host = resolveOllamaHost(env);
	const url = `${host}/api/pull`;

	try {
		const response = await fetchFn(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			// Some Ollama versions document the field name as `name`, others as
			// `model`. Sending both is harmless and keeps this best-effort.
			body: JSON.stringify({ model: trimmed, name: trimmed, stream: false }),
		});

		const contentType = response.headers.get("content-type") ?? "";
		const isJson = contentType.includes("application/json");
		const parsed: OllamaPullResponse | null = isJson
			? ((await response.json().catch(() => null)) as OllamaPullResponse | null)
			: null;

		const upstreamError = parsed?.error?.trim();
		if (!response.ok) {
			return {
				ok: false,
				error: upstreamError || `Ollama returned HTTP ${response.status}`,
			};
		}

		if (upstreamError) {
			return { ok: false, error: upstreamError };
		}

		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message };
	}
}
