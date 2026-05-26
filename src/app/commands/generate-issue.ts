import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { AuthStorage, createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { createTarsModelRegistry } from "../../executor/model-registry.js";
import { resolveConfiguredModel, getLastAssistantText } from "../../executor/index.js";
import { buildSystemPrompt, buildUserPrompt, type RepoContext, type GenerateOptions } from "./issue-prompts.js";

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

export interface GeneratedIssue {
	title: string;
	body: string;
	labels: string[];
	assignees: string[];
}

function stripMarkdownFences(text: string): string {
	const match = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
	return match ? match[1].trim() : text.trim();
}

export function extractJson(text: string): Record<string, unknown> {
	// Try raw parse first
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {}

	// Try after stripping fences
	const noFences = stripMarkdownFences(text);
	try {
		return JSON.parse(noFences) as Record<string, unknown>;
	} catch {}

	// Try extracting content between first { and last }
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
		} catch {}
	}

	throw new Error(
		`Could not extract valid JSON from LLM response. Raw output:\n${text}`,
	);
}

export async function generateIssueViaLLM(
	owner: string,
	repo: string,
	userPrompt: string,
	context?: RepoContext,
	options?: GenerateOptions,
): Promise<GeneratedIssue> {
	const authStorage = AuthStorage.create();
	const modelRegistry = createTarsModelRegistry(authStorage);
	const configuredModel = resolveConfiguredModel(modelRegistry);

	if (!configuredModel) {
		throw new Error(
			"No LLM model configured. Set PI_AGENT_MODEL and optionally PI_AGENT_PROVIDER.",
		);
	}

	const systemPrompt = buildSystemPrompt();
	const fullPrompt = buildUserPrompt(owner, repo, userPrompt, context, options);

	const { session } = await createAgentSession({
		cwd: AGENT_CWD,
		sessionManager: SessionManager.inMemory(),
		authStorage,
		modelRegistry,
		model: configuredModel,
		tools: ISSUE_AGENT_TOOLS,
	});

	// Override the harness system prompt for this single-purpose call
	session.agent.state.systemPrompt = systemPrompt;

	let parsed: Record<string, unknown> | undefined;
	let lastError: string | undefined;
	const maxTurns = 3;

	try {
		for (let turn = 0; turn < maxTurns; turn++) {
			if (turn === 0) {
				await session.prompt(fullPrompt);
			} else {
				const feedback = `Your previous response was not valid JSON. Error: ${lastError}. Please respond ONLY with valid JSON matching the requested format.`;
				await session.prompt(feedback);
			}

			const lastAssistant = [...session.messages].reverse().find(
				(m) => m.role === "assistant",
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
	} finally {
		session.dispose();
	}

	if (!parsed) {
		throw new Error("Could not extract valid JSON from LLM response.");
	}

	return {
		title: typeof parsed.title === "string" ? parsed.title : "Untitled",
		body: typeof parsed.body === "string" ? parsed.body : "",
		labels: Array.isArray(parsed.labels)
			? parsed.labels.filter((l): l is string => typeof l === "string")
			: [],
		assignees: Array.isArray(parsed.assignees)
			? parsed.assignees.filter((a): a is string => typeof a === "string")
			: [],
	};
}
