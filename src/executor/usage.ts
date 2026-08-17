/**
 * Aggregated token-usage summary extracted from a Pi agent session's message
 * history. `available` is false when no assistant message reported usage (for
 * example, when the underlying provider does not return token counts); in that
 * case the numeric fields are all zero and the UI should display "unknown".
 */
export interface TokenUsage {
	available: boolean;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

const EMPTY_USAGE: TokenUsage = {
	available: false,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
};

interface ProviderUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

interface MessageWithUsage {
	role?: string;
	usage?: ProviderUsage;
}

/**
 * Sum token usage across every assistant message in `messages`. Non-assistant
 * messages (user, toolResult, etc.) are ignored even if they carry a `usage`
 * field, so tool-execution usage does not pollute the LLM token accounting.
 *
 * Returns {@link EMPTY_USAGE} (with `available: false`) when no assistant
 * message contributes any usage number, so callers can render "unknown"
 * without guarding against null.
 */
export function extractTokenUsage(messages: unknown[] | null | undefined): TokenUsage {
	if (!Array.isArray(messages)) {
		return { ...EMPTY_USAGE };
	}

	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalTokens = 0;
	let cost = 0;
	let seen = false;

	for (const message of messages as MessageWithUsage[]) {
		if (!message || typeof message !== "object") continue;
		if (message.role !== "assistant") continue;
		const usage = message.usage;
		if (!usage || typeof usage !== "object") continue;

		const msgInput = numberOr(usage.input, 0);
		const msgOutput = numberOr(usage.output, 0);
		const msgCacheRead = numberOr(usage.cacheRead, 0);
		const msgCacheWrite = numberOr(usage.cacheWrite, 0);
		const msgTotal =
			typeof usage.totalTokens === "number"
				? usage.totalTokens
				: msgInput + msgOutput + msgCacheRead + msgCacheWrite;
		const msgCost = numberOr(usage.cost?.total, 0);

		// Any numeric usage field on an assistant message signals the provider
		// reported usage, so the aggregate is considered available even when all
		// values happen to be zero.
		if (
			usage.input !== undefined ||
			usage.output !== undefined ||
			usage.cacheRead !== undefined ||
			usage.cacheWrite !== undefined ||
			usage.totalTokens !== undefined ||
			usage.cost !== undefined
		) {
			seen = true;
		}

		input += msgInput;
		output += msgOutput;
		cacheRead += msgCacheRead;
		cacheWrite += msgCacheWrite;
		totalTokens += msgTotal;
		cost += msgCost;
	}

	if (!seen) {
		return { ...EMPTY_USAGE };
	}

	return {
		available: true,
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost,
	};
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Combine two usage snapshots into one. The later snapshot wins on
 * `available`; when it is unavailable the prior snapshot is preserved so a
 * follow-up turn that did not report usage does not erase a prior report.
 * Numeric fields always add, matching the per-message aggregation semantics.
 */
export function mergeUsage(prior: TokenUsage | undefined, next: TokenUsage): TokenUsage {
	if (!prior) return next;
	return {
		available: next.available || prior.available,
		input: prior.input + next.input,
		output: prior.output + next.output,
		cacheRead: prior.cacheRead + next.cacheRead,
		cacheWrite: prior.cacheWrite + next.cacheWrite,
		totalTokens: prior.totalTokens + next.totalTokens,
		cost: prior.cost + next.cost,
	};
}