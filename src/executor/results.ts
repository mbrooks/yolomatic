export interface ExecutionResult {
	status: "working" | "waiting-feedback" | "complete" | "cancelled" | "failed";
	summary: string;
	rawResponse: string;
}

export function isRateLimitError(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		lower.includes("429") &&
		(lower.includes("usage limit") || lower.includes("rate limit") || lower.includes("rate-limit") || lower.includes("too many requests"))
	);
}

export function isExecutionEnvironmentBlocker(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		(lower.includes("configured working directory") && lower.includes("doesn't exist on this filesystem")) ||
		(lower.includes("the bash tool won't execute") && lower.includes("valid cwd")) ||
		(lower.includes("without a valid cwd") && lower.includes("can't run any bash commands"))
	);
}

export function extractText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (item && typeof item === "object" && "type" in item) {
					if (item.type === "text" && "text" in item) {
						return typeof item.text === "string" ? item.text : "";
					}
					if (item.type === "thinking" && "thinking" in item) {
						return typeof item.thinking === "string" ? item.thinking : "";
					}
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
			if (Array.isArray(message.content)) {
				const visibleText = message.content
					.map((item) => {
						if (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item) {
							return typeof item.text === "string" ? item.text : "";
						}
						return "";
					})
					.filter(Boolean)
					.join("\n")
					.trim();
				if (visibleText) {
					return visibleText;
				}
			}
			return extractText(message.content).trim();
		}
	}
	return "";
}

export function parseExecutionResult(rawResponse: string): ExecutionResult {
	const trimmed = rawResponse.trim();
	const lines = trimmed.split(/\r?\n/u);

	let statusLineIndex = -1;
	let status: ExecutionResult["status"] | undefined;

	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i]?.trim() || "";
		const match = /^YEETOMATIC_STATUS:\s*(working|waiting-feedback|complete)$/u.exec(line);
		if (match) {
			statusLineIndex = i;
			status = match[1] as ExecutionResult["status"];
			break;
		}
	}

	return {
		status: status ?? "working",
		summary: lines.slice(statusLineIndex >= 0 ? statusLineIndex + 1 : 0).join("\n").trim() || trimmed,
		rawResponse: trimmed,
	};
}
