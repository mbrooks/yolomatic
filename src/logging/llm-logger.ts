import { DEFAULT_LOGGING_SETTINGS, type LoggingSettings } from "../runtime-settings.js";

/**
 * Comprehensive LLM interaction logger.
 *
 * Logs all prompts, chain-of-thought reasoning, tool calls, tool results,
 * responses, and errors to stdout with a consistent format:
 *
 *   [ISO_TIMESTAMP] [repo-issue-N] [category] message
 *
 * Logging flags and level are injected via {@link LlmLoggerOptions} so the
 * logger never reads `process.env` directly; the configuration boundary
 * (`getConfig()` for the control plane, worker env ingestion for workers)
 * supplies the settings.
 */
export interface LlmLoggerOptions {
	/** Explicit logging settings. Defaults to {@link DEFAULT_LOGGING_SETTINGS}. */
	loggingSettings?: LoggingSettings;
}

export class LlmLogger {
	private readonly sessionTag: string;
	private readonly logPrompts: boolean;
	private readonly logThoughts: boolean;
	private readonly logTools: boolean;
	private readonly logResponses: boolean;
	private readonly logLevel: string;

	constructor(repo: string, issueNumber: number, sessionTag?: string, options?: LlmLoggerOptions) {
		this.sessionTag = sessionTag ?? `${repo}-issue-${issueNumber}`;
		const settings = options?.loggingSettings ?? DEFAULT_LOGGING_SETTINGS;
		this.logLevel = settings.logLevel.trim().toLowerCase() || "info";
		this.logPrompts = settings.logPrompts;
		this.logThoughts = settings.logThoughts;
		this.logTools = settings.logTools;
		this.logResponses = settings.logResponses;
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

	/**
	 * Logs the model run summary (model id, provider, API, reasoning effort,
	 * context window, and max output tokens) under the `model` category. Gated
	 * by the log level only; there is no dedicated category flag.
	 */
	logModel(message: string): void {
		if (this.isLevelSuppressed("model")) return;
		if (!message.trim()) return;
		this.log("model", message);
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
