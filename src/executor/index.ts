import {
	AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type LoadExtensionsResult,
	SessionManager as PiSessionManager,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { createYolomaticModelRegistry } from "./model-registry.js";

import { LlmLogger } from "../logging/llm-logger.js";
import { recordSessionLog } from "../logging/session-log-store.js";
import { SelfMonitor } from "../self-monitor/index.js";
import { sessionStorageKey, type SessionState } from "../session/store.js";
import { resolveConfiguredModel, type ConfiguredModelOverride, type ModelSettingsFallback } from "./model-selection.js";
import {
	resolveRuntimeSettings,
	type RuntimeSettings,
	type RuntimeSettingsProvider,
} from "../runtime-settings.js";
import { buildFeedbackPrompt, buildIssuePrompt, buildIssueRefinementPrompt, buildPRReviewPrompt, buildRefinementJsonCorrectionPrompt, buildStatusCorrectionPrompt, type PRReviewComment, type PriorDiscussionComment } from "./prompts.js";
import { detectStatusMarker, getLastAssistantText, isExecutionEnvironmentBlocker, isRateLimitError, parseExecutionResult, parseRefinementResult, type ExecutionResult, type RefinementResult } from "./results.js";
import { extractTokenUsage, mergeUsage, type TokenUsage } from "./usage.js";
import { loadSoulContent } from "./soul-loader.js";
import type { ExecutionService, LiveExecutionSession } from "../ports/execution-service.js";

export { resolveConfiguredModel } from "./model-selection.js";
export { extractText, getLastAssistantText, isExecutionEnvironmentBlocker, isRateLimitError, parseExecutionResult, parseRefinementResult, detectStatusMarker, type ExecutionResult, type ExecutionStatus, type RefinementResult } from "./results.js";
export { buildFeedbackPrompt, buildIssuePrompt, buildIssueRefinementPrompt, buildPRReviewPrompt, buildRefinementJsonCorrectionPrompt, buildStatusCorrectionPrompt, formatPriorDiscussion, type PRReviewComment, type PriorDiscussionComment } from "./prompts.js";
export { loadSoulContent } from "./soul-loader.js";

type ModelConfigProvider = ConfiguredModelOverride | (() => ConfiguredModelOverride | undefined) | undefined;

/**
 * Runtime settings input for {@link PiAgentExecutor}. Accepts a static
 * snapshot, a `() => RuntimeSettings` function, or a {@link RuntimeSettingsProvider}
 * so live database-setting updates affect the next execution. Omitted
 * settings preserve the legacy default behavior (Pi default model, default
 * logging flags).
 */
type RuntimeSettingsInput = RuntimeSettings | RuntimeSettingsProvider | (() => RuntimeSettings) | undefined;

export class PiAgentExecutor implements ExecutionService {
	private readonly soulPath: string;
	private readonly modelConfig: ModelConfigProvider;
	private readonly trustedExtensionPath: string | undefined;
	private readonly runtimeSettings: RuntimeSettingsInput;

	constructor(options: {
		soulPath: string;
		modelConfig?: ModelConfigProvider;
		trustedExtensionPath?: string;
		runtimeSettings?: RuntimeSettingsInput;
	}) {
		this.soulPath = options.soulPath;
		this.modelConfig = options.modelConfig;
		this.trustedExtensionPath = options.trustedExtensionPath;
		this.runtimeSettings = options.runtimeSettings;
	}

	execute(
		state: SessionState,
		comment?: string,
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
		priorComments?: PriorDiscussionComment[],
	): Promise<ExecutionResult> {
		return this.run(state, comment, undefined, abortSignal, onSessionCreated, undefined, onActivity, undefined, priorComments);
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

	async executeRefinement(
		state: SessionState,
		overridePrompt: string,
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
	): Promise<RefinementResult> {
		const result = await this.run(
			state,
			undefined,
			undefined,
			abortSignal,
			onSessionCreated,
			overridePrompt,
			onActivity,
			{ refinement: true },
		);
		const parsed = parseRefinementResult(result.rawResponse);
		if (!parsed) {
			if (result.status === "failed" && result.summary.startsWith("Worker did not return a parseable refinement result")) {
				throw new Error(result.summary);
			}
			throw new Error("Worker did not return a parseable refinement result.");
		}
		return { ...parsed, usage: result.usage };
	}

	private async run(
		state: SessionState,
		newComment?: string,
		prReview?: { comments: PRReviewComment[]; reviewBody?: string },
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		overridePrompt?: string,
		onActivity?: () => void,
		options?: { refinement?: boolean },
		priorComments?: PriorDiscussionComment[],
	): Promise<ExecutionResult> {
		const settings = resolveRuntimeSettings(this.runtimeSettings);
		const logger = new LlmLogger(state.repo, state.issueNumber, state.sessionTag, {
			loggingSettings: settings.logging,
		});
		const notifyActivity = () => {
			onActivity?.();
		};
		const key = sessionStorageKey(state.owner, state.repo, state.issueNumber, state.kind ?? "implementation");

		let prompt: string;
		if (overridePrompt) {
			prompt = overridePrompt;
		} else if (prReview) {
			prompt = buildPRReviewPrompt(state, prReview.comments, prReview.reviewBody);
		} else if (newComment) {
			prompt = buildFeedbackPrompt(newComment, priorComments ?? []);
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
			...(this.trustedExtensionPath
				? {
					additionalExtensionPaths: [this.trustedExtensionPath],
					extensionsOverride: (base: LoadExtensionsResult) =>
						preferTrustedExtension(base, this.trustedExtensionPath!),
				}
				: {}),
			agentsFilesOverride: (current) => ({
				agentsFiles: [
					...current.agentsFiles,
					{ path: "/virtual/SOUL.md", content: soulContent },
				],
			}),
		});
		await loader.reload();

		const modelRegistry = await createYolomaticModelRegistry({
			openaiApiKey: settings.model.openaiApiKey,
			ollamaHost: settings.model.ollamaHost,
		});
		const configuredModelOverride = this.getModelConfig();
		const configuredModelRef = resolveConfiguredModel(modelRegistry, configuredModelOverride, settings.model);
		const configuredModel = configuredModelRef
			? modelRegistry.runtime.getModel(configuredModelRef.provider, configuredModelRef.id)
			: undefined;
		const configuredModelName = configuredModelOverride?.model?.trim() ?? settings.model.piAgentModel?.trim();
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
			modelRuntime: modelRegistry.runtime,
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

		let rawResponse = getLastAssistantText(session);
		// Aggregate token usage from the assistant messages produced during the
		// run. When the provider does not report usage, `available` is false and
		// all counts are zero; the dashboard renders "unknown" in that case.
		const usage = extractTokenUsage(session.messages);
		if (usage.available) {
			recordSessionLog(key, {
				level: "info",
				message: `Token usage: ${usage.totalTokens} tokens (in ${usage.input}, out ${usage.output}), cost ${usage.cost.toFixed(4)}`,
				details: {
					type: "usage",
					available: true,
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					totalTokens: usage.totalTokens,
					cost: usage.cost,
				},
			});
		} else {
			recordSessionLog(key, {
				level: "info",
				message: "Token usage unavailable (provider did not report usage).",
				details: { type: "usage", available: false },
			});
		}
		logger.logResponse(rawResponse);
		let result = parseExecutionResult(rawResponse);
		if (result.status === "working" && isExecutionEnvironmentBlocker(result.summary || result.rawResponse)) {
			result = {
				...result,
				status: "failed",
			};
		}

		// Honor an abort that fired during (or just before) the run before issuing
		// the status-correction prompt. The correction prompt runs another full
		// agent turn; issuing it after a Stop would re-engage the worker and
		// undercut the cancel. Return a cancelled result so the reporter leaves
		// the session in `cancelled`.
		if (abortSignal?.aborted) {
			return {
				status: "cancelled",
				summary: "Task cancelled by admin.",
				rawResponse: rawResponse,
				usage,
			};
		}

		if (options?.refinement && !parseRefinementResult(rawResponse)) {
			result = await this.correctRefinementJson(session, key, rawResponse, logger, abortSignal, usage);
			rawResponse = result.rawResponse;
		} else if (!options?.refinement && result.status !== "failed" && detectStatusMarker(rawResponse) === null) {
			result = await this.correctStatusProtocol(session, key, rawResponse, logger, abortSignal, usage);
		} else {
			result = { ...result, usage };
		}

		recordSessionLog(key, {
			level: "assistant",
			message: rawResponse || "(no response)",
			details: { type: "response", status: result.status },
		});
		notifyActivity();

		return result;
	}

	private async correctRefinementJson(
		session: AgentSession,
		key: string,
		originalRaw: string,
		logger: LlmLogger,
		abortSignal?: AbortSignal,
		priorUsage?: TokenUsage,
	): Promise<ExecutionResult> {
		recordSessionLog(key, {
			level: "warn",
			message: "Refinement result protocol violation: worker response was not parseable JSON. Issuing one correction prompt.",
			details: { type: "refinement_protocol_violation" },
		});
		recordSessionLog(key, {
			level: "assistant",
			message: originalRaw || "(no response)",
			details: { type: "invalid_refinement_response" },
		});
		const correctionPrompt = buildRefinementJsonCorrectionPrompt();
		logger.logPrompt(correctionPrompt);
		recordSessionLog(key, {
			level: "info",
			message: "Correction prompt sent to request valid refinement JSON.",
			details: { type: "refinement_correction_prompt", length: correctionPrompt.length },
		});

		try {
			await session.prompt(correctionPrompt);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.logError(error instanceof Error ? error : new Error(message), "Refinement JSON correction prompt failed");
			recordSessionLog(key, {
				level: "error",
				message: `Refinement JSON correction prompt failed: ${message}`,
				details: { type: "refinement_correction_prompt_error", error: message },
			});
			return {
				status: "failed",
				summary: `Worker did not return a parseable refinement result and the correction prompt failed (${message}).`,
				rawResponse: originalRaw,
				usage: priorUsage,
			};
		}

		const correctedUsage = mergeUsage(priorUsage, extractTokenUsage(session.messages));
		if (abortSignal?.aborted) {
			return {
				status: "cancelled",
				summary: "Task cancelled by admin during refinement JSON correction.",
				rawResponse: "",
				usage: correctedUsage,
			};
		}

		const correctedRaw = getLastAssistantText(session);
		logger.logResponse(correctedRaw);
		if (parseRefinementResult(correctedRaw)) {
			recordSessionLog(key, {
				level: "info",
				message: "Refinement JSON correction succeeded.",
				details: { type: "refinement_correction_result" },
			});
			return { ...parseExecutionResult(correctedRaw), usage: correctedUsage };
		}

		recordSessionLog(key, {
			level: "error",
			message: "Refinement result remained invalid after one correction prompt.",
			details: { type: "refinement_protocol_violation_exhausted" },
		});
		return {
			status: "failed",
			summary: "Worker did not return a parseable refinement result after one correction prompt.",
			rawResponse: correctedRaw || originalRaw,
			usage: correctedUsage,
		};
	}

	private async correctStatusProtocol(
		session: AgentSession,
		key: string,
		originalRaw: string,
		logger: LlmLogger,
		abortSignal?: AbortSignal,
		priorUsage?: TokenUsage,
	): Promise<ExecutionResult> {
		recordSessionLog(key, {
			level: "warn",
			message: "Status protocol violation: worker response omitted a valid YOLO_STATUS marker. Issuing one correction prompt.",
			details: { type: "protocol_violation" },
		});
		const correctionPrompt = buildStatusCorrectionPrompt();
		logger.logPrompt(correctionPrompt);
		recordSessionLog(key, {
			level: "info",
			message: "Correction prompt sent to request a valid status marker.",
			details: { type: "correction_prompt", length: correctionPrompt.length },
		});

		try {
			await session.prompt(correctionPrompt);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.logError(error instanceof Error ? error : new Error(message), "Status correction prompt failed");
			recordSessionLog(key, {
				level: "error",
				message: `Status correction prompt failed: ${message}`,
				details: { type: "correction_prompt_error", error: message },
			});
			return {
				status: "failed",
				summary: `Worker protocol failure: the worker response omitted a valid YOLO_STATUS marker and the correction prompt failed (${message}). No work was delivered.`,
				rawResponse: originalRaw,
				usage: priorUsage,
			};
		}

		if (abortSignal?.aborted) {
			return {
				status: "cancelled",
				summary: "Task cancelled by admin during status correction.",
				rawResponse: "",
				usage: extractTokenUsage(session.messages),
			};
		}

		const correctedRaw = getLastAssistantText(session);
		// Re-extract usage after the correction turn so it includes the extra
		// assistant message. Falls back to the prior usage snapshot when the
		// correction produced no new usage.
		const correctedUsage = mergeUsage(priorUsage, extractTokenUsage(session.messages));
		logger.logResponse(correctedRaw);
		if (detectStatusMarker(correctedRaw) !== null) {
			const corrected = parseExecutionResult(correctedRaw);
			recordSessionLog(key, {
				level: "info",
				message: `Status correction succeeded with status ${corrected.status}.`,
				details: { type: "correction_result", status: corrected.status },
			});
			return { ...corrected, usage: correctedUsage };
		}

		recordSessionLog(key, {
			level: "error",
			message: "Status protocol violation persisted after one correction prompt; failing execution without delivery.",
			details: { type: "protocol_violation_exhausted" },
		});
		return {
			status: "failed",
			summary: "Worker protocol failure: the worker did not return a valid YOLO_STATUS marker after one correction prompt. No work was delivered.",
			rawResponse: correctedRaw || originalRaw,
			usage: correctedUsage,
		};
	}

	private getModelConfig(): ConfiguredModelOverride | undefined {
		if (typeof this.modelConfig === "function") {
			return this.modelConfig();
		}
		return this.modelConfig;
	}
}

export function preferTrustedExtension(
	base: LoadExtensionsResult,
	trustedExtensionPath: string,
): LoadExtensionsResult {
	const resolvedTrustedPath = path.resolve(trustedExtensionPath);
	const trustedExtension = base.extensions.find(
		(extension) => path.resolve(extension.resolvedPath) === resolvedTrustedPath,
	);
	if (!trustedExtension) return base;

	const trustedToolNames = new Set(trustedExtension.tools.keys());
	const removedPaths = new Set<string>();
	const extensions = base.extensions.filter((extension) => {
		if (extension === trustedExtension) return true;
		const conflictsWithTrustedExtension = [...extension.tools.keys()].some((toolName) =>
			trustedToolNames.has(toolName),
		);
		if (conflictsWithTrustedExtension) {
			removedPaths.add(extension.path);
			return false;
		}
		return true;
	});
	const errors = base.errors.filter(
		(error) =>
			!removedPaths.has(error.path) ||
			![...trustedToolNames].some((toolName) =>
				error.error.startsWith(`Tool "${toolName}" conflicts with `),
			),
	);

	return { ...base, extensions, errors };
}
