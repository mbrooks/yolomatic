import { AuthStorage, createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { createTarsModelRegistry } from "../../executor/model-registry.js";
import { resolveConfiguredModel, getLastAssistantText } from "../../executor/index.js";

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
): Promise<GeneratedIssue> {
	const authStorage = AuthStorage.create();
	const modelRegistry = createTarsModelRegistry(authStorage);
	const configuredModel = resolveConfiguredModel(modelRegistry);

	if (!configuredModel) {
		throw new Error(
			"No LLM model configured. Set PI_AGENT_MODEL and optionally PI_AGENT_PROVIDER.",
		);
	}

	const systemPrompt =
		"You are a helpful assistant that generates well-structured GitHub issues. " +
		"Given a repository and a user description, produce a JSON object with the issue fields. " +
		'Respond ONLY with valid JSON, no markdown fences, no commentary.';

	const fullPrompt = `Repository: ${owner}/${repo}\n\nUser request: ${userPrompt}\n\n` +
		"Generate a GitHub issue with these fields in JSON format:\n" +
		'{\n' +
		'  "title": "string (concise, descriptive title)",\n' +
		'  "body": "string (detailed description with any relevant sections)",\n' +
		'  "labels": ["string array of relevant labels, or empty"],\n' +
		'  "assignees": ["string array of GitHub usernames, or empty"]\n' +
		"}";

	const { session } = await createAgentSession({
		sessionManager: SessionManager.inMemory(),
		authStorage,
		modelRegistry,
		model: configuredModel,
		noTools: "all",
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
