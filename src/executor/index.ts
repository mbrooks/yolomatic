import {
	AgentSession,
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager as PiSessionManager,
} from "@mariozechner/pi-coding-agent";
import { readFile } from "node:fs/promises";

import { LlmLogger } from "../logging/llm-logger.js";
import { recordSessionLog } from "../logging/session-log-store.js";
import { FatalSystemError, SelfMonitor } from "../self-monitor/index.js";
import { sessionKey as buildSessionKey } from "../domain/session/model.js";
import type { SessionState } from "../session/store.js";

export interface ExecutionResult {
	status: "working" | "waiting-feedback" | "complete" | "cancelled";
	summary: string;
	rawResponse: string;
}

interface ModelReference {
	provider: string;
	id: string;
}

interface ModelLookup<TModel extends ModelReference> {
	find(provider: string, modelId: string): TModel | undefined;
	getAll(): TModel[];
}

export function extractText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item) {
					return typeof item.text === "string" ? item.text : "";
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

export function getLastAssistantText(session: { messages: Array<{ role?: string; content?: unknown }> }): string {
	for (let index = session.messages.length - 1; index >= 0; index -= 1) {
		const message = session.messages[index];
		if (message.role === "assistant") {
			return extractText(message.content).trim();
		}
	}
	return "";
}

let soulContentCache: string | null = null;

async function loadSoulContent(soulPath: string): Promise<string> {
	if (soulContentCache !== null) {
		return soulContentCache;
	}
	try {
		const content = await readFile(soulPath, "utf-8");
		soulContentCache = content;
		process.stdout.write(`Loaded SOUL.md from ${soulPath}\n`);
		return content;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Warning: Failed to load SOUL.md from ${soulPath}: ${message}\n`);
		soulContentCache = "";
		return "";
	}
}

export function parseExecutionResult(rawResponse: string): ExecutionResult {
	const trimmed = rawResponse.trim();
	const lines = trimmed.split(/\r?\n/u);
	const firstLine = lines[0]?.trim() || "";
	const match = /^TARS_STATUS:\s*(working|waiting-feedback|complete)$/u.exec(firstLine);
	const status = match?.[1] as ExecutionResult["status"] | undefined;

	return {
		status: status ?? "working",
		summary: lines.slice(match ? 1 : 0).join("\n").trim() || trimmed,
		rawResponse: trimmed,
	};
}

export function buildIssuePrompt(state: SessionState): string {
	return [
		`You are working on GitHub issue #${state.issueNumber} in ${state.owner}/${state.repo}.`,
		`Workspace: ${state.workspacePath}`,
		"",
		"Status protocol:",
		"- First line must be exactly one of:",
		"  TARS_STATUS: working",
		"  TARS_STATUS: waiting-feedback",
		"  TARS_STATUS: complete",
		"- If you need human clarification, ask the question immediately after the status line.",
		"- If complete, summarize what code was generated after the status line.",
		"",
		"When you mark TARS_STATUS: complete, do not commit, push, or open a Pull Request yourself.",
		"The host process owns delivery and will publish your completed branch after the run finishes.",
		"",
		`Title: ${state.title}`,
		"Description:",
		state.body.trim() || "(no description provided)",
	].join("\n");
}

export function buildFeedbackPrompt(comment: string): string {
	return [
		"Human feedback received. Continue from the existing session context.",
		"",
		"Status protocol:",
		"- First line must be exactly one of:",
		"  TARS_STATUS: working",
		"  TARS_STATUS: waiting-feedback",
		"  TARS_STATUS: complete",
		"",
		comment.trim(),
	].join("\n");
}

export interface PRReviewComment {
	body: string;
	user: string;
	path?: string;
	line?: number;
}

export function buildPRReviewPrompt(state: SessionState, comments: PRReviewComment[], reviewBody?: string): string {
	const lines = [
		`PR review feedback received for PR associated with issue #${state.issueNumber} in ${state.owner}/${state.repo}.`,
		`Workspace: ${state.workspacePath}`,
		`Branch: tars/issue-${state.issueNumber}`,
		"",
		"Status protocol:",
		"- First line must be exactly one of:",
		"  TARS_STATUS: working",
		"  TARS_STATUS: waiting-feedback",
		"  TARS_STATUS: complete",
		"- If complete, commit all changes and push to the branch:",
		`  git add -A && git commit -m "TARS: Iteration on PR for issue #${state.issueNumber}" && git push origin tars/issue-${state.issueNumber}`,
		"- Do NOT force-push. Append commits to the existing PR branch.",
		"",
	];

	if (reviewBody) {
		lines.push("Overall review comment:");
		lines.push(reviewBody.trim());
		lines.push("");
	}

	if (comments.length > 0) {
		lines.push("Review comments:");
		for (const comment of comments) {
			const location = comment.path && comment.line !== undefined
				? ` (${comment.path}:${comment.line})`
				: "";
			lines.push(`- @${comment.user}${location}: ${comment.body.trim()}`);
		}
		lines.push("");
	}

	lines.push("Address the review feedback by making the requested changes, running tests, and summarizing changes.");
	lines.push("If the feedback is a question or non-actionable discussion, reply with an explanation and no code change.");

	return lines.join("\n");
}

export function resolveConfiguredModel<TModel extends ModelReference>(
	registry: ModelLookup<TModel>,
	env: NodeJS.ProcessEnv = process.env,
): TModel | undefined {
	const configuredModel = env.PI_AGENT_MODEL?.trim();
	if (!configuredModel) {
		return undefined;
	}

	const configuredProvider = env.PI_AGENT_PROVIDER?.trim();
	if (configuredProvider) {
		return registry.find(configuredProvider, configuredModel);
	}

	const exactMatches = registry
		.getAll()
		.filter((model) => model.id === configuredModel || `${model.provider}/${model.id}` === configuredModel);
	if (exactMatches.length === 1) {
		return exactMatches[0];
	}

	const slashIndex = configuredModel.indexOf("/");
	if (slashIndex > 0) {
		const provider = configuredModel.slice(0, slashIndex).trim();
		const modelId = configuredModel.slice(slashIndex + 1).trim();
		if (provider && modelId) {
			return registry.find(provider, modelId);
		}
	}

	return undefined;
}

export class PiAgentExecutor {
	private readonly soulPath: string;

	constructor(options: { soulPath: string }) {
		this.soulPath = options.soulPath;
	}

	async execute(
		state: SessionState,
		newComment?: string,
		prReview?: { comments: PRReviewComment[]; reviewBody?: string },
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: AgentSession) => void,
		overridePrompt?: string,
	): Promise<ExecutionResult> {
		const logger = new LlmLogger(state.repo, state.issueNumber);
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
		const modelRegistry = ModelRegistry.create(authStorage);
		const configuredModel = resolveConfiguredModel(modelRegistry);
		if (process.env.PI_AGENT_MODEL?.trim() && !configuredModel) {
			process.stderr.write(
				`Warning: PI_AGENT_MODEL=${process.env.PI_AGENT_MODEL} did not resolve to a configured Pi model; falling back to Pi defaults.\n`,
			);
		}

		const { session } = await createAgentSession({
			cwd: state.workspacePath,
			sessionManager: piSessionManager,
			resourceLoader: loader,
			authStorage,
			modelRegistry,
			model: configuredModel,
		});
		onSessionCreated?.(session);

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
				}
			}

			if (event.type === "tool_execution_start") {
				logger.logToolCall(event.toolName, event.args as Record<string, unknown>);
				recordSessionLog(key, {
					level: "tool",
					message: `${event.toolName} ${JSON.stringify(event.args).slice(0, 200)}`,
					details: { type: "tool_execution_start", toolName: event.toolName, args: event.args },
				});
			}

			if (event.type === "tool_execution_end") {
				logger.logToolResult(event.toolName, event.result);
				recordSessionLog(key, {
					level: event.isError ? "error" : "info",
					message: `${event.toolName} ${event.isError ? "failed" : "done"}`,
					details: { type: "tool_execution_end", toolName: event.toolName, result: event.result, isError: event.isError },
				});
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
			}

			if (event.type === "auto_retry_end" && !event.success && event.finalError) {
				logger.logError(new Error(event.finalError), "Auto-retry failed");
				recordSessionLog(key, {
					level: "error",
					message: `Auto-retry failed: ${event.finalError}`,
					details: { type: "auto_retry_end", success: false, finalError: event.finalError },
				});
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
		recordSessionLog(key, {
			level: "assistant",
			message: rawResponse || "(no response)",
			details: { type: "response", status: parseExecutionResult(rawResponse).status },
		});

		return parseExecutionResult(rawResponse);
	}
}
