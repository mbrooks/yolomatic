import { FatalSystemError } from "../self-monitor/index.js";
import type { FatalErrorDetails, Evidence } from "../self-monitor/types.js";
import type { RootCauseAnalysis, RootCauseLevel } from "./types.js";

function isCodeLevelStack(stack: string, repoPath: string): boolean {
	if (!stack) return false;
	const lines = stack.split("\n");
	for (const line of lines) {
		const match = /at .* \((.*):\d+:\d+\)|at (.*):\d+:\d+/.exec(line);
		const p = match?.[1] || match?.[2];
		if (
			p &&
			p.startsWith(repoPath) &&
			p.includes("/src/") &&
			!p.includes("node_modules") &&
			!p.endsWith(".test.ts") &&
			!p.endsWith(".test.tsx")
		) {
			return true;
		}
	}
	return false;
}

function extractAffectedFilesFromStack(stack: string, repoPath: string): string[] {
	const files = new Set<string>();
	const lines = stack.split("\n");
	for (const line of lines) {
		const match = /at .* \((.*):\d+:\d+\)|at (.*):\d+:\d+/.exec(line);
		const p = match?.[1] || match?.[2];
		if (
			p &&
			p.startsWith(repoPath) &&
			p.includes("/src/") &&
			!p.includes("node_modules") &&
			!p.endsWith(".test.ts") &&
			!p.endsWith(".test.tsx")
		) {
			files.add(p);
		}
	}
	return [...files];
}

function extractFilesFromMessage(message: string): string[] {
	const matches = message.match(/(src\/[^\s:]+)/g);
	return matches ? [...new Set(matches)] : [];
}

export function classifyFatalErrorCategory(category: FatalErrorDetails["category"]): RootCauseLevel {
	switch (category) {
		case "missing_binary_after_install":
		case "missing_toolchain_binary":
		case "disk_full":
		case "git_worktree_failure":
		case "permission_denied":
		case "github_pat_scope_missing":
			return "config-level";
		default:
			return "code-level";
	}
}

export function analyzeError(error: Error, repoPath: string = process.cwd()): RootCauseAnalysis {
	if (error instanceof FatalSystemError) {
		const { fatalError } = error.evidence;
		const level = classifyFatalErrorCategory(fatalError.category);
		return {
			level,
			description: fatalError.message,
			affectedFiles: extractFilesFromMessage(fatalError.message),
		};
	}

	if (error.stack && isCodeLevelStack(error.stack, repoPath)) {
		return {
			level: "code-level",
			description: `Runtime error in Yolomatic source: ${error.message}`,
			affectedFiles: extractAffectedFilesFromStack(error.stack, repoPath),
		};
	}

	const msg = error.message.toLowerCase();
	if (
		msg.includes("json") ||
		msg.includes("parse") ||
		msg.includes("unexpected token") ||
		msg.includes("yolomatic_status") ||
		msg.includes("status protocol")
	) {
		return {
			level: "prompt-level",
			description: `Prompt or parsing failure: ${error.message}`,
			affectedFiles: [],
		};
	}

	if (
		msg.includes("config") ||
		msg.includes(".env") ||
		msg.includes("econnrefused") ||
		msg.includes("enotfound")
	) {
		return {
			level: "config-level",
			description: `Configuration or connectivity issue: ${error.message}`,
			affectedFiles: [],
		};
	}

	return {
		level: "code-level",
		description: `Uncaught error: ${error.message}`,
		affectedFiles: [],
	};
}
