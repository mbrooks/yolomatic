export interface RepoContext {
	labels: string[];
	templates: Array<{ name: string; body: string }>;
	recentCommits: string[];
	relatedIssues: Array<{ number: number; title: string; state: string }>;
}

export interface GenerateOptions {
	privacyMode: boolean;
	selectedTemplate?: string;
}

export interface ConversationPromptOptions {
	owner?: string;
	repo?: string;
	messages: Array<{ role: "assistant" | "user"; text: string }>;
	draft?: Partial<{
		title: string;
		body: string;
		labels: string[];
		assignees: string[];
	}>;
	context?: RepoContext;
	options?: GenerateOptions;
}

export function buildSystemPrompt(): string {
	return (
		"You are a helpful assistant that generates well-structured GitHub issues. " +
		"Before drafting an issue, use the available file tools (ls, find, read, grep) to review the target repository's code on the main branch: list key source files, read relevant code, check recent commits, and understand the project structure. " +
		"Be thorough and detailed when drafting the issue title, body, and any acceptance criteria. Include enough context, reproduction steps, and expected behavior so a maintainer can understand and act on the issue without additional back-and-forth. " +
		"Given a repository and a user description, produce a JSON object with the issue fields. " +
		"Respond ONLY with valid JSON, no markdown fences, no commentary."
	);
}

export function buildConversationSystemPrompt(): string {
	return [
		"You are a conversational GitHub issue drafting assistant.",
		"Before drafting an issue, use the available file tools (ls, find, read, grep) to review the target repository's code on the main branch: list key source files, read relevant code, check recent commits, and understand the project structure.",
		"You do exactly one job: help the user create a GitHub issue.",
		"When the user describes an issue, use that understanding to infer the title, body, labels, assignees, and repository from their natural-language description.",
		"Be thorough and detailed when drafting the issue title, body, and acceptance criteria. Include enough context, reproduction steps, and expected behavior so a maintainer can act on it without additional back-and-forth.",
		"Only ask follow-up questions when critical information (like the repository or a clear issue description) is missing and cannot be inferred.",
		"Set shouldCreate to true only when the user has clearly asked you to create/publish/open the issue now.",
		"Set readyToCreate to true only when repository owner, repository name, and a usable issue title are present.",
		"Respond ONLY with valid JSON and no markdown fences or commentary.",
		"Additional skills are available in the read-only context under .pi/skills/. Use `ls` and `read` to discover and consult them when they would improve the issue draft.",
	].join(" ");
}

export function buildUserPrompt(
	owner: string,
	repo: string,
	userPrompt: string,
	context?: RepoContext,
	options?: GenerateOptions,
): string {
	let prompt = `Repository: ${owner}/${repo}\n\nUser request: ${userPrompt}\n\n`;

	if (options?.privacyMode) {
		prompt +=
			"IMPORTANT: Privacy mode is enabled. Do NOT include any code snippets, stack traces, or other potentially sensitive content in the issue. " +
			"Describe problems in general terms and ask the user to provide sensitive details separately.\n\n";
	}

	if (context && !options?.privacyMode) {
		if (context.labels.length > 0) {
			prompt += `Available labels in this repository: ${context.labels.join(", ")}\n`;
			prompt += `Choose only from this label set. If none fit, return an empty array.\n\n`;
		}

		if (context.templates.length > 0) {
			prompt += `Available issue templates:\n`;
			for (const t of context.templates) {
				prompt += `- ${t.name}\n`;
			}
			if (options?.selectedTemplate) {
				const selected = context.templates.find((t) => t.name === options.selectedTemplate);
				if (selected) {
					prompt += `\nSelected template "${selected.name}". Use this structure:\n${selected.body}\n\n`;
				}
			} else {
				prompt += `If one of these templates fits the issue type, structure the body accordingly.\n\n`;
			}
		}

		if (context.recentCommits.length > 0) {
			prompt += `Recent commits (for context):\n`;
			for (const c of context.recentCommits.slice(0, 5)) {
				prompt += `- ${c}\n`;
			}
			prompt += `\n`;
		}

		if (context.relatedIssues.length > 0) {
			prompt += `Potentially related issues:\n`;
			for (const i of context.relatedIssues.slice(0, 5)) {
				prompt += `- #${i.number} (${i.state}): ${i.title}\n`;
			}
			prompt += `\n`;
		}
	}

	prompt +=
		"Generate a GitHub issue with these fields in JSON format:\n" +
		'{\n' +
		'  "title": "string (concise, descriptive title)",\n' +
		'  "body": "string (thorough, detailed description with reproduction steps, expected behavior, and any relevant sections; do not be terse)",\n' +
		'  "labels": ["string array of relevant labels, or empty"],\n' +
		'  "assignees": ["string array of GitHub usernames, or empty"]\n' +
		"}";

	return prompt;
}

function appendRepoContext(prompt: string, context?: RepoContext, options?: GenerateOptions): string {
	if (!context || options?.privacyMode) {
		return prompt;
	}

	if (context.labels.length > 0) {
		prompt += `Available labels in this repository: ${context.labels.join(", ")}\n`;
		prompt += "Choose only from this label set. If none fit, return an empty array.\n\n";
	}

	if (context.templates.length > 0) {
		prompt += "Available issue templates:\n";
		for (const template of context.templates) {
			prompt += `- ${template.name}\n`;
		}
		if (options?.selectedTemplate) {
			const selected = context.templates.find((template) => template.name === options.selectedTemplate);
			if (selected) {
				prompt += `\nSelected template "${selected.name}". Use this structure:\n${selected.body}\n\n`;
			}
		} else {
			prompt += "If one of these templates fits the issue type, structure the body accordingly.\n\n";
		}
	}

	if (context.recentCommits.length > 0) {
		prompt += "Recent commits (for context):\n";
		for (const commit of context.recentCommits.slice(0, 5)) {
			prompt += `- ${commit}\n`;
		}
		prompt += "\n";
	}

	if (context.relatedIssues.length > 0) {
		prompt += "Potentially related issues:\n";
		for (const issue of context.relatedIssues.slice(0, 5)) {
			prompt += `- #${issue.number} (${issue.state}): ${issue.title}\n`;
		}
		prompt += "\n";
	}

	return prompt;
}

export function buildConversationPrompt({
	owner,
	repo,
	messages,
	draft,
	context,
	options,
}: ConversationPromptOptions): string {
	let prompt = "Help the user draft and, if explicitly requested, create a GitHub issue.\n\n";
	prompt += `Current repository owner: ${owner ?? "(unknown)"}\n`;
	prompt += `Current repository name: ${repo ?? "(unknown)"}\n\n`;

	if (options?.privacyMode) {
		prompt +=
			"IMPORTANT: Privacy mode is enabled. Do NOT include code snippets, stack traces, secrets, or other sensitive details in the draft. Use generalized descriptions instead.\n\n";
	}

	prompt += "Current draft:\n";
	prompt += `${JSON.stringify({
		title: draft?.title ?? "",
		body: draft?.body ?? "",
		labels: draft?.labels ?? [],
		assignees: draft?.assignees ?? [],
	}, null, 2)}\n\n`;

	prompt += "Conversation so far:\n";
	for (const message of messages) {
		prompt += `${message.role === "assistant" ? "Assistant" : "User"}: ${message.text}\n`;
	}
	prompt += "\n";

	prompt = appendRepoContext(prompt, context, options);

	prompt +=
		"Return JSON with this exact shape:\n" +
		'{\n' +
		'  "message": "string assistant reply to show in the chat",\n' +
		'  "owner": "string repository owner, or empty string if still unknown",\n' +
		'  "repo": "string repository name, or empty string if still unknown",\n' +
		'  "draft": {\n' +
		'    "title": "string",\n' +
		'    "body": "string (thorough and detailed; include reproduction steps, expected behavior, and enough context for a maintainer to act without follow-up)",\n' +
		'    "labels": ["string"],\n' +
		'    "assignees": ["string"]\n' +
		"  },\n" +
		'  "readyToCreate": true,\n' +
		'  "shouldCreate": false\n' +
		"}\n\n" +
		"Rules:\n" +
		"- Before drafting, use the available file tools to review the target repository's main branch code so the draft references existing files and aligns with the current architecture.\n" +
		"- Be thorough and detailed in the draft body. Include reproduction steps, expected behavior, and any other context a maintainer would need.\n" +
		"- Infer repository owner, name, title, body, labels, and assignees from the user's natural-language description whenever possible.\n" +
		"- If the user supplied an owner/repo anywhere in the conversation, extract it.\n" +
		"- If repository information is missing and cannot be inferred, ask for it.\n" +
		"- If the draft is weak, ask the next highest-value clarifying question.\n" +
		"- If the user asked to create the issue and the draft is ready, set shouldCreate to true.\n" +
		"- If the user has not clearly asked to create it yet, keep shouldCreate false.";

	return prompt;
}
