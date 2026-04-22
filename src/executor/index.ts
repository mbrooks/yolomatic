import { createAgentSession, SessionManager as PiSessionManager } from "@mariozechner/pi-coding-agent";

import type { SessionState } from "../session/store.js";

export interface ExecutionResult {
	status: "working" | "waiting-feedback" | "complete";
	summary: string;
	rawResponse: string;
}

function extractText(content: unknown): string {
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

function getLastAssistantText(session: { messages: Array<{ role?: string; content?: unknown }> }): string {
	for (let index = session.messages.length - 1; index >= 0; index -= 1) {
		const message = session.messages[index];
		if (message.role === "assistant") {
			return extractText(message.content).trim();
		}
	}
	return "";
}

function parseExecutionResult(rawResponse: string): ExecutionResult {
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

function buildIssuePrompt(state: SessionState): string {
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
		`Title: ${state.title}`,
		"Description:",
		state.body.trim() || "(no description provided)",
	].join("\n");
}

function buildFeedbackPrompt(comment: string): string {
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

export class PiAgentExecutor {
	async execute(state: SessionState, newComment?: string): Promise<ExecutionResult> {
		const piSessionManager = PiSessionManager.open(state.sessionPath, undefined, state.workspacePath);
		const { session } = await createAgentSession({
			cwd: state.workspacePath,
			sessionManager: piSessionManager,
		});

		await session.prompt(newComment ? buildFeedbackPrompt(newComment) : buildIssuePrompt(state));
		return parseExecutionResult(getLastAssistantText(session));
	}
}
