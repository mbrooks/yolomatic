import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { AuthStorage, createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SkillStore } from "../../skills/store.js";
import type { RepoSkillService } from "../../skills/repo-skill-service.js";
import { parseSkillFile, buildSkillFile } from "../../skills/repo-skill-service.js";
import { sessionKey as buildSessionKey } from "../../domain/session/model.js";
import { createTarsModelRegistry } from "../../executor/model-registry.js";
import { resolveConfiguredModel, getLastAssistantText } from "../../executor/index.js";
import { LlmLogger } from "../../logging/llm-logger.js";
import { recordSessionLog } from "../../logging/session-log-store.js";
import { extractJson } from "./generate-issue.js";
import { buildConversationPrompt, buildConversationSystemPrompt, type GenerateOptions, type RepoContext } from "./issue-prompts.js";

const ISSUE_AGENT_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"github_get_authenticated_user",
	"github_query_issues",
	"github_fetch_issue",
	"github_set_comment",
	"github_set_status",
	"github_set_labels",
	"github_assigned_open_issues",
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_CWD = resolve(__dirname, "../../..");

export interface IssueConversationMessage {
	role: "assistant" | "user";
	text: string;
}

export interface IssueDraft {
	title: string;
	body: string;
	labels: string[];
	assignees: string[];
}

export interface IssueChatResponse {
	message: string;
	owner: string;
	repo: string;
	draft: IssueDraft;
	readyToCreate: boolean;
	shouldCreate: boolean;
	cancelled?: boolean;
}

export type ThinkingCallback = (chunk: { text: string; done: boolean }) => void;

type AgentEvent = {
	type: string;
	assistantMessageEvent?: {
		type: string;
		content?: string;
		delta?: string;
		thinking?: string;
	};
	toolName?: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
};

function normalizeString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
		: [];
}

function normalizeDraft(value: unknown): IssueDraft {
	const draft = value && typeof value === "object" ? value as Record<string, unknown> : {};
	return {
		title: normalizeString(draft.title),
		body: normalizeString(draft.body),
		labels: normalizeList(draft.labels),
		assignees: normalizeList(draft.assignees),
	};
}

interface SkillInfo {
	name: string;
	description: string;
	content: string;
}

function scanLocalSkills(cwd: string): SkillInfo[] {
	const skills: SkillInfo[] = [];
	const skillsDir = path.join(cwd, ".pi/skills");
	const dirStat = statSync(skillsDir, { throwIfNoEntry: false });
	if (!dirStat || !dirStat.isDirectory()) return skills;

	for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
			const fileStat = statSync(skillFile, { throwIfNoEntry: false });
			if (!fileStat || !fileStat.isFile()) continue;
			try {
				const raw = readFileSync(skillFile, "utf-8");
				const parsed = parseSkillFile(raw);
				skills.push({
					name: parsed.name || entry.name,
					description: parsed.description,
					content: parsed.body,
				});
			} catch {
				// ignore unreadable files
			}
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			const skillFile = path.join(skillsDir, entry.name);
			try {
				const raw = readFileSync(skillFile, "utf-8");
				const parsed = parseSkillFile(raw);
				const name = parsed.name || path.basename(entry.name, ".md");
				skills.push({ name, description: parsed.description, content: parsed.body });
			} catch {
				// ignore unreadable files
			}
		}
	}
	return skills;
}

async function buildSkillAgentsFiles(
	cwd: string,
	skillStore?: SkillStore,
	repoSkillService?: RepoSkillService,
	owner?: string,
	repo?: string,
): Promise<Array<{ path: string; content: string }>> {
	const skills = new Map<string, SkillInfo>();

	for (const skill of scanLocalSkills(cwd)) {
		skills.set(skill.name, skill);
	}

	if (skillStore) {
		try {
			const serverSkills = await skillStore.listAll();
			for (const skill of serverSkills) {
				if (!skills.has(skill.name)) {
					skills.set(skill.name, {
						name: skill.name,
						description: skill.description,
						content: skill.content,
					});
				}
			}
		} catch {
			// ignore server skill fetch errors
		}
	}

	if (repoSkillService && owner && repo) {
		try {
			const repoSkills = await repoSkillService.listRepoSkills(owner, repo);
			for (const skill of repoSkills) {
				skills.set(skill.name, {
					name: skill.name,
					description: skill.description,
					content: skill.content,
				});
			}
		} catch {
			// ignore repo skill fetch errors
		}
	}

	return Array.from(skills.values()).map((skill) => ({
		path: path.join(cwd, ".pi/skills", skill.name, "SKILL.md"),
		content: buildSkillFile(skill.name, skill.description, skill.content),
	}));
}

export async function chatIssueViaLLM({
	owner,
	repo,
	messages,
	draft,
	context,
	options,
	onThinking,
	skillStore,
	repoSkillService,
	abortSignal,
	onSessionCreated,
}: {
	owner?: string;
	repo?: string;
	messages: IssueConversationMessage[];
	draft?: Partial<IssueDraft>;
	context?: RepoContext;
	options?: GenerateOptions;
	onThinking?: ThinkingCallback;
	skillStore?: SkillStore;
	repoSkillService?: RepoSkillService;
	abortSignal?: AbortSignal;
	onSessionCreated?: (session: AgentSession) => void;
}): Promise<IssueChatResponse> {
	const authStorage = AuthStorage.create();
	const modelRegistry = createTarsModelRegistry(authStorage);
	const configuredModel = resolveConfiguredModel(modelRegistry);

	if (!configuredModel) {
		throw new Error(
			"No LLM model configured. Set PI_AGENT_MODEL and optionally PI_AGENT_PROVIDER.",
		);
	}

	const systemPrompt = buildConversationSystemPrompt();
	const fullPrompt = buildConversationPrompt({
		owner,
		repo,
		messages,
		draft,
		context,
		options,
	});

	const skillFiles = await buildSkillAgentsFiles(AGENT_CWD, skillStore, repoSkillService, owner, repo);
	const loader = new DefaultResourceLoader({
		cwd: AGENT_CWD,
		agentDir: getAgentDir(),
		agentsFilesOverride: (current) => ({
			agentsFiles: [...current.agentsFiles, ...skillFiles],
		}),
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd: AGENT_CWD,
		sessionManager: SessionManager.inMemory(),
		resourceLoader: loader,
		authStorage,
		modelRegistry,
		model: configuredModel,
		tools: ISSUE_AGENT_TOOLS,
	});

	session.agent.state.systemPrompt = systemPrompt;
	onSessionCreated?.(session);
	const logOwner = owner || "unknown";
	const logRepo = repo || "unknown";
	const key = buildSessionKey(logOwner, logRepo, -1);
	const logger = new LlmLogger(logRepo, -1, "issue-chat");

	logger.logPrompt(fullPrompt);
	recordSessionLog(key, {
		level: "info",
		message: "Issue chat prompt sent",
		details: { type: "prompt", length: fullPrompt.length },
	});

	const unsubscribe = session.subscribe((event: AgentEvent) => {
		if (event.type === "message_update" && event.assistantMessageEvent) {
			const assistantEvent = event.assistantMessageEvent;
			if (assistantEvent.type === "thinking_delta" || assistantEvent.type === "thinking") {
				const text = assistantEvent.delta ?? assistantEvent.content ?? assistantEvent.thinking ?? "";
				if (text) {
					onThinking?.({ text, done: false });
				}
			}
			if (assistantEvent.type === "thinking_end") {
				const content = assistantEvent.content ?? "";
				if (content) {
					onThinking?.({ text: content, done: true });
					logger.logThought(content);
					recordSessionLog(key, {
						level: "info",
						message: content,
						details: { type: "thinking" },
					});
				}
			}
		}

		if (event.type === "tool_execution_start" && event.toolName) {
			logger.logToolCall(event.toolName, event.args as Record<string, unknown>);
			recordSessionLog(key, {
				level: "tool",
				message: `${event.toolName} ${JSON.stringify(event.args).slice(0, 200)}`,
				details: { type: "tool_execution_start", toolName: event.toolName, args: event.args },
			});
		}

		if (event.type === "tool_execution_end" && event.toolName) {
			logger.logToolResult(event.toolName, event.result);
			recordSessionLog(key, {
				level: event.isError ? "error" : "info",
				message: `${event.toolName} ${event.isError ? "failed" : "done"}`,
				details: { type: "tool_execution_end", toolName: event.toolName, result: event.result, isError: event.isError },
			});
		}
	});

	let parsed: Record<string, unknown> | undefined;
	let lastError: string | undefined;
	const maxTurns = 3;

	const onAbort = () => {
		void session.abort();
	};
	abortSignal?.addEventListener("abort", onAbort);

	try {
		if (abortSignal?.aborted) {
			return {
				message: "Stopped by user.",
				owner: owner || "",
				repo: repo || "",
				draft: normalizeDraft(draft),
				readyToCreate: false,
				shouldCreate: false,
				cancelled: true,
			};
		}

		for (let turn = 0; turn < maxTurns; turn++) {
			if (turn === 0) {
				await session.prompt(fullPrompt);
			} else {
				const feedback = `Your previous response was not valid JSON. Error: ${lastError}. Please respond ONLY with valid JSON matching the requested format.`;
				await session.prompt(feedback);
			}

			const lastAssistant = [...session.messages].reverse().find(
				(message) => message.role === "assistant",
			);
			if (lastAssistant && "errorMessage" in lastAssistant && lastAssistant.errorMessage) {
				throw new Error(`LLM request failed: ${lastAssistant.errorMessage}`);
			}

			const text = getLastAssistantText(session);
			try {
				parsed = extractJson(text);
				break;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				if (turn === maxTurns - 1) {
					throw new Error(
						`Could not extract valid JSON from LLM response after ${maxTurns} attempts. Last error: ${lastError}\nRaw output:\n${text}`,
					);
				}
			}
		}
	} catch (error) {
		if (abortSignal?.aborted) {
			return {
				message: "Stopped by user.",
				owner: owner || "",
				repo: repo || "",
				draft: normalizeDraft(draft),
				readyToCreate: false,
				shouldCreate: false,
				cancelled: true,
			};
		}
		logger.logError(error instanceof Error ? error : new Error(String(error)), "Issue chat failed");
		recordSessionLog(key, {
			level: "error",
			message: `Issue chat failed: ${error instanceof Error ? error.message : String(error)}`,
			details: { type: "prompt_error", error: error instanceof Error ? error.message : String(error) },
		});
		throw error;
	} finally {
		abortSignal?.removeEventListener("abort", onAbort);
		unsubscribe();
		session.dispose();
	}

	if (!parsed) {
		throw new Error("Could not extract valid JSON from LLM response.");
	}

	return {
		message: normalizeString(parsed.message),
		owner: normalizeString(parsed.owner ?? owner),
		repo: normalizeString(parsed.repo ?? repo),
		draft: normalizeDraft(parsed.draft),
		readyToCreate: parsed.readyToCreate === true,
		shouldCreate: parsed.shouldCreate === true,
	};
}
