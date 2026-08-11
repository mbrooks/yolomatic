/**
 * OpenAI Codex models supported through the OpenAI Platform API.
 *
 * This catalog deliberately does not include ChatGPT/Codex App OAuth models
 * or non-Codex OpenAI models. It is shared by model selection and the Pi
 * runtime registration so a selectable model always has API-key metadata.
 */
export interface OpenAiCodexModel {
	id: string;
	name: string;
	api: "openai-responses";
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

export const OPENAI_CODEX_MODELS: OpenAiCodexModel[] = [
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

const OPENAI_CODEX_MODEL_IDS = new Set(OPENAI_CODEX_MODELS.map(({ id }) => id));

export function isSupportedOpenAiCodexModel(modelId: string): boolean {
	return OPENAI_CODEX_MODEL_IDS.has(modelId);
}
