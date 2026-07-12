/**
 * Logging configuration for {@link LlmLogger}.
 *
 * Prefer passing an explicit config object at construction time. The
 * `process.env`-derived defaults are kept only as an initial fallback for
 * callers (e.g. tests, CLI entry points) that do not have a typed
 * {@link AppConfig} available.
 */
export interface LlmLoggerConfig {
	logLevel: string;
	logPrompts: boolean;
	logThoughts: boolean;
	logTools: boolean;
	logResponses: boolean;
}

/**
 * Build a {@link LlmLoggerConfig} from `process.env`, applying the same
 * defaults the legacy constructor used: log level `info` and every category
 * enabled unless explicitly disabled via `=false`.
 */
export function defaultLlmLoggerConfigFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): LlmLoggerConfig {
	return {
		logLevel: env.LOG_LEVEL?.trim().toLowerCase() || "info",
		logPrompts: env.LOG_PROMPTS !== "false",
		logThoughts: env.LOG_THOUGHTS !== "false",
		logTools: env.LOG_TOOLS !== "false",
		logResponses: env.LOG_RESPONSES !== "false",
	};
}

/**
 * Comprehensive LLM interaction logger.
 *
 * Logs all prompts, chain-of-thought reasoning, tool calls, tool results,
 * responses, and errors to stdout with a consistent format:
 *
 *   [ISO_TIMESTAMP] [repo-issue-N] [category] message
 */
export class LlmLogger {
	private readonly sessionTag: string;
	private readonly logPrompts: boolean;
	private readonly logThoughts: boolean;
	private readonly logTools: boolean;
	private readonly logResponses: boolean;
	private readonly logLevel: string;

	constructor(repo: string, issueNumber: number, sessionTag?: string, config?: LlmLoggerConfig) {
		this.sessionTag = sessionTag ?? `${repo}-issue-${issueNumber}`;
		const resolved = config ?? defaultLlmLoggerConfigFromEnv();
		this.logLevel = resolved.logLevel;
		this.logPrompts = resolved.logPrompts;
		this.logThoughts = resolved.logThoughts;
		this.logTools = resolved.logTools;
		this.logResponses = resolved.logResponses;
	}

	logPrompt(prompt: string, tokens?: number): void {
		if (!this.logPrompts || this.isLevelSuppressed("prompt")) return;
		const tokenInfo = tokens !== undefined ? `${tokens} tokens` : "unknown tokens";
		this.log("prompt", `Prompt sent (${tokenInfo})`);
		const limit = this.logLevel === "debug" ? 10000 : 2000;
		if (prompt.length > 0) {
			const truncated = prompt.length > limit ? `${prompt.slice(0, limit)}...` : prompt;
			for (const line of truncated.split("\n")) {
				this.log("prompt", line);
			}
		}
	}

	logThought(thought: string): void {
		if (!this.logThoughts || this.isLevelSuppressed("thought")) return;
		if (!thought.trim()) return;
		this.log("thought", thought);
	}

	logToolCall(toolName: string, params: Record<string, unknown>): void {
		if (!this.logTools || this.isLevelSuppressed("tool")) return;
		this.log(`tool:${toolName}`, JSON.stringify(params));
	}

	logToolResult(toolName: string, result: unknown): void {
		if (!this.logTools || this.isLevelSuppressed("tool-result")) return;
		const resultStr = typeof result === "string" ? result : JSON.stringify(result);
		const limit = this.logLevel === "debug" ? 10000 : 500;
		const truncated = resultStr.length > limit ? `${resultStr.slice(0, limit)}...` : resultStr;
		this.log(`tool-result:${toolName}`, truncated);
	}

	logResponse(response: string): void {
		if (!this.logResponses || this.isLevelSuppressed("response")) return;
		if (!response.trim()) return;
		for (const line of response.split("\n")) {
			this.log("response", line);
		}
	}

	logError(error: Error, context?: string): void {
		this.log("error", `${context ?? "Unknown error"}: ${error.message}`);
	}

	private isLevelSuppressed(category: string): boolean {
		if (this.logLevel === "error") {
			return category !== "error";
		}
		if (this.logLevel === "warn") {
			return category !== "error" && category !== "tool-result" && category !== "tool";
		}
		return false;
	}

	private log(category: string, message: string): void {
		const timestamp = new Date().toISOString();
		const line = `[${timestamp}] [${this.sessionTag}] [${category}] ${message}`;
		process.stdout.write(line + "\n");
	}
}
