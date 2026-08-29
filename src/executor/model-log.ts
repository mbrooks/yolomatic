/**
 * Human-readable model run summary.
 *
 * Produces the single-line description of the model serving an execution so
 * operators can see, at a glance, which model ran, through which provider and
 * API, whether reasoning was engaged and at what effort, and the model's
 * context and output token budgets. Example:
 *
 *   Running on deepseek-v4-flash:0731-cloud, served through Ollama
 *   (openai-completions API). Reasoning is enabled at medium effort, with a
 *   1M-token context window and 64K max output tokens.
 */

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
	ollama: "Ollama",
	openai: "OpenAI",
};

/**
 * Display name for a provider id. Known ids map to their conventional
 * capitalization; unknown ids are title-cased.
 */
export function providerDisplayName(provider: string): string {
	const known = PROVIDER_DISPLAY_NAMES[provider];
	if (known) return known;
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * Human-readable token count. Round decimal budgets use decimal notation
 * (400000 -> "400K", 128000 -> "128K"); exact binary multiples use binary
 * notation (1048576 -> "1M", 65536 -> "64K", 16384 -> "16K"); anything else
 * falls back to one-decimal compact notation. Sub-1024 counts pass through
 * unchanged (999 -> "999").
 */
export function formatTokenCount(tokens: number | undefined): string {
	if (tokens === undefined || !Number.isFinite(tokens)) {
		return "unknown";
	}
	if (tokens < 1024) {
		return `${tokens}`;
	}

	if (tokens % 1000 === 0) {
		const decimalK = tokens / 1000;
		return decimalK >= 1000 ? `${trimFraction(decimalK / 1000)}M` : `${decimalK}K`;
	}

	const binaryM = tokens / 1_048_576;
	if (Number.isInteger(binaryM)) {
		return `${binaryM}M`;
	}
	const binaryK = tokens / 1024;
	if (Number.isInteger(binaryK)) {
		return `${binaryK}K`;
	}

	// Neither decimal-round nor a binary multiple: compact with at most one
	// fractional digit (1_500_000 -> "1.5M", 5_120_000 -> "5.1M").
	const decimalK = tokens / 1000;
	return decimalK >= 1000 ? `${trimFraction(decimalK / 1000)}M` : `${trimFraction(decimalK)}K`;
}

function trimFraction(value: number): string {
	return String(Number(value.toFixed(1)));
}

/** The model fields that appear in the run summary. */
export interface ModelRunInfo {
	/** Provider id (e.g. "ollama", "openai"). */
	provider: string;
	/** Model id as served by the provider (e.g. "deepseek-v4-flash:0731-cloud"). */
	id: string;
	/** Provider API technology (e.g. "openai-completions"). */
	api?: string;
	/** Whether the model supports reasoning. */
	reasoning?: boolean;
	/** Context window size in tokens. */
	contextWindow?: number;
	/** Maximum output tokens. */
	maxTokens?: number;
}

/**
 * Build the model run summary for the session log (and stdout logger):
 *
 *   Running on {id}, served through {Provider} ({api} API). Reasoning is
 *   enabled at {level} effort, with a {ctx}-token context window and {max}
 *   max output tokens.
 *
 * `thinkingLevel` is the session's effective level. Reasoning is reported as
 * disabled when the model does not support it or the level is "off".
 */
export function describeModelRun(model: ModelRunInfo, thinkingLevel: string): string {
	const apiPart = model.api ? ` (${model.api} API)` : "";
	const limits = buildLimitsClause(model);
	if (model.reasoning === true && thinkingLevel !== "off") {
		return `Running on ${model.id}, served through ${providerDisplayName(model.provider)}${apiPart}. ` +
			`Reasoning is enabled at ${thinkingLevel} effort, with ${limits}.`;
	}
	return `Running on ${model.id}, served through ${providerDisplayName(model.provider)}${apiPart}. ` +
		`Reasoning is disabled, with ${limits}.`;
}

function buildLimitsClause(model: ModelRunInfo): string {
	const contextPart = model.contextWindow === undefined
		? "an unknown context window"
		: `a ${formatTokenCount(model.contextWindow)}-token context window`;
	const maxPart = model.maxTokens === undefined
		? "unknown max output tokens"
		: `${formatTokenCount(model.maxTokens)} max output tokens`;
	return `${contextPart} and ${maxPart}`;
}