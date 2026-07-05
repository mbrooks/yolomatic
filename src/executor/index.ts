import {
	AgentSession,
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager as PiSessionManager,
} from "@earendil-works/pi-coding-agent";
import { createTarsModelRegistry } from "./model-registry.js";

import { LlmLogger } from "../logging/llm-logger.js";
import { recordSessionLog } from "../logging/session-log-store.js";
import { SelfMonitor } from "../self-monitor/index.js";
import { sessionKey as buildSessionKey } from "../domain/session/model.js";
import type { SessionState } from "../session/store.js";
import { resolveConfiguredModel, type ConfiguredModelOverride } from "./model-selection.js";
import { buildFeedbackPrompt, buildIssuePrompt, buildPRReviewPrompt, type PRReviewComment } from "./prompts.js";
import { getLastAssistantText, isExecutionEnvironmentBlocker, isRateLimitError, parseExecutionResult, type ExecutionResult } from "./results.js";
import { loadSoulContent } from "./soul-loader.js";
import type { ExecutionService, LiveExecutionSession } from "../ports/execution-service.js";

export { resolveConfiguredModel } from "./model-selection.js";
export { buildFeedbackPrompt, buildIssuePrompt, buildPRReviewPrompt, type PRReviewComment } from "./prompts.js";
export { extractText, getLastAssistantText, isExecutionEnvironmentBlocker, isRateLimitError, parseExecutionResult, type ExecutionResult } from "./results.js";
export { loadSoulContent } from "./soul-loader.js";

type ModelConfigProvider = ConfiguredModelOverride | (() => ConfiguredModelOverride | undefined) | undefined;

export class PiAgentExecutor implements ExecutionService {
	private readonly soulPath: string;
	private readonly modelConfig: ModelConfigProvider;

	constructor(options: { soulPath: string; modelConfig?: ModelConfigProvider }) {
		this.soulPath = options.soulPath;
		this.modelConfig = options.modelConfig;
	}

	execute(
		state: SessionState,
		comment?: string,
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
	): Promise<ExecutionResult> {
		return this.run(state, comment, undefined, abortSignal, onSessionCreated, undefined, onActivity);
	}

	executePRReview(
		state: SessionState,
		prReview: { comments: PRReviewComment[]; reviewBody?: string },
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
	): Promise<ExecutionResult> {
		return this.run(state, undefined, prReview, abortSignal, onSessionCreated, undefined, onActivity);
	}

	executeWithOverride(
		state: SessionState,
		overridePrompt: string,
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
	): Promise<ExecutionResult> {
		return this.run(state, undefined, undefined, abortSignal, onSessionCreated, overridePrompt, onActivity);
	}

	private async run(
		state: SessionState,
		newComment?: string,
		prReview?: { comments: PRReviewComment[]; reviewBody?: string },
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		overridePrompt?: string,
		onActivity?: () => void,
	): Promise<ExecutionResult> {
		const logger = new LlmLogger(state.repo, state.issueNumber, state.sessionTag);
		const notifyActivity = () => {
			onActivity?.();
		};
		const key = buildSessionKey(state.owner, state.repo, state.issueNumber);

		let prompt: string;
		if (overridePrompt) {
			prompt = overridePrompt;
		} else if (prReview) {
			prompt = buildPRReviewPrompt(state, prReview.comments, prReview.reviewBody);
		} else if (newComment) {
			prompt = buildFeedbackPrompt(newComment);
		} else {
			prompt = buildIssuePrompt(state);
		}
		logger.logPrompt(prompt);
		recordSessionLog(key, { level: "info", message: `Prompt sent`, details: { type: "prompt", length: prompt.length } });

		const piSessionManager = PiSessionManager.open(state.sessionPath, undefined, state.workspacePath);

		const soulContent = await loadSoulContent(this.soulPath);
		const loader = new DefaultResourceLoader({
			cwd: state.workspacePath,
			agentDir: getAgentDir(),
			agentsFilesOverride: (current) => ({
				agentsFiles: [
					...current.agentsFiles,
					{ path: "/virtual/SOUL.md", content: soulContent },
				],
			}),
		});
		await loader.reload();

		const authStorage = AuthStorage.create();
		const modelRegistry = createTarsModelRegistry(authStorage);
		const configuredModelOverride = this.getModelConfig();
		const configuredModel = resolveConfiguredModel(modelRegistry, configuredModelOverride);
		const configuredModelName = configuredModelOverride?.model?.trim() ?? process.env.PI_AGENT_MODEL?.trim();
		if (configuredModelName && !configuredModel) {
			process.stderr.write(
				`Warning: configured Pi model ${configuredModelName} did not resolve; falling back to Pi defaults.\n`,
			);
		}

		const resolvedModelId = configuredModel
			? `${configuredModel.provider}/${configuredModel.id}`
			: "(pi defaults)";
		recordSessionLog(key, {
			level: "info",
			message:
				`Using model: ${resolvedModelId}` +
				(configuredModelName && !configuredModel ? " (configured model unresolved, fell back)" : ""),
			details: {
				type: "model",
				provider: configuredModel?.provider,
				modelId: configuredModel?.id,
				configured: configuredModelName ?? null,
			},
		});

		const { session } = await createAgentSession({
			cwd: state.workspacePath,
			sessionManager: piSessionManager,
			resourceLoader: loader,
			authStorage,
			modelRegistry,
			model: configuredModel,
		});
		onSessionCreated?.({
			steer: (message: string) => session.steer(message),
		});

		const selfMonitor = new SelfMonitor(state.workspacePath);

		if (abortSignal?.aborted) {
			return {
				status: "cancelled",
				summary: "Task cancelled before execution started.",
				rawResponse: "",
			};
		}

		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_update") {
				if (event.assistantMessageEvent.type === "thinking_end") {
					logger.logThought(event.assistantMessageEvent.content);
					recordSessionLog(key, { level: "info", message: event.assistantMessageEvent.content, details: { type: "thinking" } });
					notifyActivity();
				}
			}

			if (event.type === "tool_execution_start") {
				logger.logToolCall(event.toolName, event.args as Record<string, unknown>);
				recordSessionLog(key, {
					level: "tool",
					message: `${event.toolName} ${JSON.stringify(event.args).slice(0, 200)}`,
					details: { type: "tool_execution_start", toolName: event.toolName, args: event.args },
				});
				notifyActivity();
			}

			if (event.type === "tool_execution_end") {
				logger.logToolResult(event.toolName, event.result);
				recordSessionLog(key, {
					level: event.isError ? "error" : "info",
					message: `${event.toolName} ${event.isError ? "failed" : "done"}`,
					details: { type: "tool_execution_end", toolName: event.toolName, result: event.result, isError: event.isError },
				});
				notifyActivity();
				selfMonitor.recordToolEnd(event.toolName, event.result, event.isError);
				if (selfMonitor.hasFatalError()) {
					void session.abort();
				}
			}

			if (event.type === "auto_retry_start") {
				logger.logError(
					new Error(event.errorMessage),
					`Auto-retry attempt ${event.attempt}/${event.maxAttempts}`,
				);
				recordSessionLog(key, {
					level: "warn",
					message: `Auto-retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
					details: { type: "auto_retry_start", attempt: event.attempt, maxAttempts: event.maxAttempts, errorMessage: event.errorMessage },
				});
				notifyActivity();
			}

			if (event.type === "auto_retry_end" && !event.success && event.finalError) {
				logger.logError(new Error(event.finalError), "Auto-retry failed");
				recordSessionLog(key, {
					level: "error",
					message: `Auto-retry failed: ${event.finalError}`,
					details: { type: "auto_retry_end", success: false, finalError: event.finalError },
				});
				notifyActivity();
			}
		});

		const onAbort = () => {
			void session.abort();
		};
		abortSignal?.addEventListener("abort", onAbort);

		try {
			await session.prompt(prompt);
		} catch (error) {
			logger.logError(error instanceof Error ? error : new Error(String(error)), "Prompt execution failed");
			recordSessionLog(key, {
				level: "error",
				message: `Prompt execution failed: ${error instanceof Error ? error.message : String(error)}`,
				details: { type: "prompt_error", error: error instanceof Error ? error.message : String(error) },
			});
			notifyActivity();
			if (abortSignal?.aborted) {
				return {
					status: "cancelled",
					summary: "Task cancelled by admin.",
					rawResponse: "",
				};
			}
			if (selfMonitor.hasFatalError()) {
				throw await selfMonitor.createFatalSystemError();
			}
			throw error;
		} finally {
			abortSignal?.removeEventListener("abort", onAbort);
			unsubscribe();
		}

		if (selfMonitor.hasFatalError()) {
			throw await selfMonitor.createFatalSystemError();
		}

		// Check for agent-level errors after the run completes
		const lastMessage = session.messages[session.messages.length - 1];
		if (lastMessage && typeof lastMessage === "object" && "role" in lastMessage && lastMessage.role === "assistant") {
			const assistantMsg = lastMessage as { errorMessage?: string; stopReason?: string };
			if (assistantMsg.errorMessage) {
				if (isRateLimitError(assistantMsg.errorMessage)) {
					logger.logError(new Error(assistantMsg.errorMessage), "Assistant error");
					recordSessionLog(key, {
						level: "error",
						message: `Assistant error: ${assistantMsg.errorMessage}`,
						details: { type: "assistant_error", errorMessage: assistantMsg.errorMessage, stopReason: assistantMsg.stopReason },
					});
					return {
						status: "failed",
						summary: assistantMsg.errorMessage,
						rawResponse: "",
					};
				}
				logger.logError(new Error(assistantMsg.errorMessage), "Assistant error");
				recordSessionLog(key, {
					level: "error",
					message: `Assistant error: ${assistantMsg.errorMessage}`,
					details: { type: "assistant_error", errorMessage: assistantMsg.errorMessage, stopReason: assistantMsg.stopReason },
				});
			} else if (assistantMsg.stopReason === "error") {
				logger.logError(new Error("Assistant stopped with error reason"), "Assistant error");
				recordSessionLog(key, {
					level: "error",
					message: "Assistant stopped with error reason",
					details: { type: "assistant_error", stopReason: assistantMsg.stopReason },
				});
			}
		}

		const rawResponse = getLastAssistantText(session);
		logger.logResponse(rawResponse);
		let result = parseExecutionResult(rawResponse);
		if (result.status === "working" && isExecutionEnvironmentBlocker(result.summary || result.rawResponse)) {
			result = {
				...result,
				status: "failed",
			};
		}
		recordSessionLog(key, {
			level: "assistant",
			message: rawResponse || "(no response)",
			details: { type: "response", status: result.status },
		});
		notifyActivity();

		return result;
	}

	private getModelConfig(): ConfiguredModelOverride | undefined {
		if (typeof this.modelConfig === "function") {
			return this.modelConfig();
		}
		return this.modelConfig;
	}
}
