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

export function buildSystemPrompt(): string {
	return (
		"You are a helpful assistant that generates well-structured GitHub issues. " +
		"Given a repository and a user description, produce a JSON object with the issue fields. " +
		"Respond ONLY with valid JSON, no markdown fences, no commentary."
	);
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
		'  "body": "string (detailed description with any relevant sections)",\n' +
		'  "labels": ["string array of relevant labels, or empty"],\n' +
		'  "assignees": ["string array of GitHub usernames, or empty"]\n' +
		"}";

	return prompt;
}
