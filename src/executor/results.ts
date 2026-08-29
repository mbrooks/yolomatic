export type ExecutionStatus = "working" | "waiting-feedback" | "complete";

export interface ExecutionResult {
	status: "working" | "waiting-feedback" | "complete" | "cancelled" | "failed";
	summary: string;
	rawResponse: string;
	/**
	 * Aggregated token usage for the run, when the underlying provider reported
	 * it. Omitted when the provider did not return usage; the control plane
	 * treats an omitted value as "unknown" for metrics/dashboard purposes.
	 */
	usage?: import("./usage.js").TokenUsage;
}

const STATUS_MARKER_PATTERN = /^YOLO_STATUS:\s*(working|waiting-feedback|complete)$/u;

/**
 * Strictly detect an explicit `YOLO_STATUS` marker in the response.
 *
 * Returns the recognized status when an exact marker is present, or `null`
 * when the response has no marker or an unsupported marker (for example
 * `YOLO_STATUS: done`). A missing or unsupported marker must not be
 * silently interpreted as `working`; callers use a `null` result to drive the
 * one-shot status-correction protocol.
 */
export function detectStatusMarker(rawResponse: string): ExecutionStatus | null {
	const trimmed = rawResponse.trim();
	if (!trimmed) return null;
	const lines = trimmed.split(/\r?\n/u);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i]?.trim() || "";
		const match = STATUS_MARKER_PATTERN.exec(line);
		if (match) {
			return match[1] as ExecutionStatus;
		}
	}
	return null;
}

export interface RefinementResult {
	proposedTaskBody: string;
	summary: string;
	investigation: string;
	/**
	 * Optional replacement issue title. Omitted when the worker does not
	 * propose a title change (or leaves it empty); a non-empty string signals
	 * that the control plane should update the issue title alongside the body.
	 */
	proposedTitle?: string;
	/**
	 * Aggregated token usage for the refinement run, when the underlying
	 * provider reported it. Omitted when unavailable.
	 */
	usage?: import("./usage.js").TokenUsage;
}

function normalizeRefinementInvestigation(value: unknown): string | null {
	if (typeof value === "string") {
		return value.length > 0 ? value : null;
	}

	if (Array.isArray(value)) {
		if (value.length === 0) return null;
	} else if (value && typeof value === "object") {
		if (Object.keys(value).length === 0) return null;
	} else {
		return null;
	}

	return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function parseRefinementJson(candidate: string): RefinementResult | null {
	const trimmed = candidate.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
		return null;
	}

	try {
		const parsed = JSON.parse(trimmed);
		const investigation = normalizeRefinementInvestigation(parsed.investigation);
		if (
			typeof parsed.proposedTaskBody === "string" &&
			parsed.proposedTaskBody.length > 0 &&
			typeof parsed.summary === "string" &&
			investigation
		) {
			const result: RefinementResult = {
				proposedTaskBody: parsed.proposedTaskBody,
				summary: parsed.summary,
				investigation,
			};
			const proposedTitle =
				typeof parsed.proposedTitle === "string" ? parsed.proposedTitle.trim() : "";
			if (proposedTitle.length > 0) {
				result.proposedTitle = proposedTitle;
			}
			return result;
		}
	} catch {
		return null;
	}

	return null;
}

export function parseRefinementResult(rawResponse: string): RefinementResult | null {
	const trimmed = rawResponse.trim();
	if (!trimmed) return null;

	const fencedJsonMatches = [...trimmed.matchAll(/```json\s*\r?\n([\s\S]*?)\r?\n```/giu)];
	let fencedJsonResult: RefinementResult | null = null;
	for (const match of fencedJsonMatches) {
		const parsed = parseRefinementJson(match[1] ?? "");
		if (!parsed) return null;
		fencedJsonResult ??= parsed;
	}
	if (fencedJsonResult) {
		return fencedJsonResult;
	}

	const parsedJson = parseRefinementJson(trimmed);
	if (parsedJson) {
		return parsedJson;
	}

	const unlabeledJsonFenceMatch = /^```\s*\r?\n([\s\S]*?)\r?\n```\s*$/u.exec(trimmed);
	if (unlabeledJsonFenceMatch) {
		return parseRefinementJson(unlabeledJsonFenceMatch[1] ?? "");
	}

	if (trimmed.startsWith("{") || trimmed.endsWith("}")) {
		return null;
	}

	const markdownMatch = /^##[ \t]+Proposed Task[ \t]*\r?\n([\s\S]*?)\r?\n##[ \t]+Summary[ \t]*\r?\n([\s\S]*?)\r?\n##[ \t]+Investigation[ \t]*\r?\n([\s\S]*)$/u.exec(trimmed);
	if (!markdownMatch) return null;

	const proposedTaskBody = markdownMatch[1]?.trim() ?? "";
	const summary = markdownMatch[2]?.trim() ?? "";
	const investigation = markdownMatch[3]?.trim() ?? "";
	if (!proposedTaskBody || !summary || !investigation) return null;

	return {
		proposedTaskBody,
		summary,
		investigation,
	};
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

	const status = detectStatusMarker(trimmed);
	let statusLineIndex = -1;
	if (status) {
		for (let i = lines.length - 1; i >= 0; i -= 1) {
			const line = lines[i]?.trim() || "";
			if (STATUS_MARKER_PATTERN.exec(line)) {
				statusLineIndex = i;
				break;
			}
		}
	}

	return {
		status: status ?? "working",
		summary: lines.slice(statusLineIndex >= 0 ? statusLineIndex + 1 : 0).join("\n").trim() || trimmed,
		rawResponse: trimmed,
	};
}
