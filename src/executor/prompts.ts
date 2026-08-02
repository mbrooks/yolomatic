import type { SessionState } from "../session/store.js";

export function buildIssuePrompt(state: SessionState): string {
	return [
		`You are working on GitHub issue #${state.issueNumber} in ${state.owner}/${state.repo}.`,
		`Workspace: ${state.workspacePath}`,
		"",
		"Status protocol:",
		"- First line must be exactly one of:",
		"  YEETOMATIC_STATUS: working",
		"  YEETOMATIC_STATUS: waiting-feedback",
		"  YEETOMATIC_STATUS: complete",
		"- If you need human clarification, ask the question immediately after the status line.",
		"- If complete, summarize what code was generated after the status line. Write a concise imperative subject line (under 50 characters, no markdown) that captures the most important change, followed by a blank line and additional details if needed.",
		"",
		"When you mark YEETOMATIC_STATUS: complete, do not commit, push, or open a Pull Request yourself.",
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
		"  YEETOMATIC_STATUS: working",
		"  YEETOMATIC_STATUS: waiting-feedback",
		"  YEETOMATIC_STATUS: complete",
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

function buildSteeringSection(steeringPrompt?: string): string[] {
	if (!steeringPrompt || steeringPrompt.trim().length === 0) {
		return [];
	}
	return [
		"Steering prompt from the requesting maintainer (authoritative for this pass):",
		"---",
		steeringPrompt.trim(),
		"---",
		"Treat the steering prompt as authoritative guidance for this refinement pass (focus areas, requested changes, constraints). Still investigate the issue independently and produce a self-contained Proposed Task.",
		"",
	];
}

export function buildIssueRefinementPrompt(state: SessionState, skillContent?: string, steeringPrompt?: string): string {
	const skillSection = skillContent
		? [
				"Repository skill instructions (follow these):",
				"---",
				skillContent.trim(),
				"---",
				"",
		  ]
		: [
				"No repository `issue-refinement` skill was found. Use Yeetomatic's built-in defaults below.",
				"",
		  ];

	return [
		`You are refining GitHub issue #${state.issueNumber} in ${state.owner}/${state.repo}.`,
		`Workspace: ${state.workspacePath}`,
		"",
		"Your goal is to investigate the issue and produce a more complete Proposed Task body.",
		"You may inspect repository files, make temporary experimental edits, run the application and tests, and use the network to validate your conclusions.",
		"Do NOT commit, push, create a pull request, or modify any GitHub state. Discard all experimental changes when you finish.",
		"",
		"Return your result as a JSON object with exactly these fields:",
		'- "proposedTaskBody": the complete Markdown body to replace the issue body',
		'- "summary": a concise explanation of what you clarified',
		'- "investigation": relevant files, commands, tests, and observations',
		"",
		"The proposed task body should be self-contained and use sections such as Summary, Requirements, Acceptance criteria, and Out of scope when appropriate.",
		"",
		...skillSection,
		...buildSteeringSection(steeringPrompt),
		"Original issue title:",
		state.title,
		"",
		"Original issue body:",
		state.body.trim() || "(no description provided)",
	].join("\n");
}

export function buildPRReviewPrompt(state: SessionState, comments: PRReviewComment[], reviewBody?: string): string {
	const lines = [
		`PR review feedback received for PR associated with issue #${state.issueNumber} in ${state.owner}/${state.repo}.`,
		`Workspace: ${state.workspacePath}`,
		`Branch: yeetomatic/issue-${state.issueNumber}`,
		"",
		"Status protocol:",
		"- First line must be exactly one of:",
		"  YEETOMATIC_STATUS: working",
		"  YEETOMATIC_STATUS: waiting-feedback",
		"  YEETOMATIC_STATUS: complete",
		"- When complete, stage and commit changes locally only:",
		`- git add -A && git commit -m "Yeetomatic: Address PR review feedback"`,
		"- Do NOT push, force-push, or run any credential-bearing git command.",
		"- The control plane owns delivery and will publish the branch after the run.",
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
