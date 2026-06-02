import type { SessionState } from "../session/store.js";

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
