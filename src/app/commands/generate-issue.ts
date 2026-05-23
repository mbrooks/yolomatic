import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { resolveConfiguredModel } from "../../executor/index.js";

export interface GeneratedIssue {
	title: string;
	body: string;
	labels: string[];
	assignees: string[];
}

function extractTextFromMessage(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
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
	const modelRegistry = ModelRegistry.create(authStorage);
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

	const context = {
		systemPrompt,
		messages: [
			{
				role: "user" as const,
				content: fullPrompt,
				timestamp: Date.now(),
			},
		],
	};

	const result = await completeSimple(configuredModel, context, { maxTokens: 4096 });
	const text = extractTextFromMessage(result);
	const parsed = extractJson(text);

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
