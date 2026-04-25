import type { FatalErrorCategory, FatalErrorDetails } from "./types.js";

export interface ToolExecutionResult {
	toolName: string;
	result: unknown;
	isError: boolean;
}

export function normalizeOutput(result: unknown): { output: string; exitCode?: number } {
	if (typeof result === "string") {
		return { output: result };
	}
	if (result && typeof result === "object") {
		const obj = result as Record<string, unknown>;
		const output =
			typeof obj.output === "string"
				? obj.output
				: typeof obj.stdout === "string"
					? obj.stdout
					: typeof obj.result === "string"
						? obj.result
						: "";
		const exitCode =
			typeof obj.exitCode === "number"
				? obj.exitCode
				: typeof obj.code === "number"
					? obj.code
					: undefined;
		return { output, exitCode };
	}
	return { output: "" };
}

export function classifyFatalError(event: ToolExecutionResult): FatalErrorDetails | null {
	const { output, exitCode } = normalizeOutput(event.result);
	const text = output.toLowerCase();

	// 1. Permission denied on node_modules or .bin/ after npm install
	// 2. EACCES / EPERM on npm install, mkdir, writeFile, or any file mutation.
	if (
		text.includes("eacces") ||
		text.includes("eperm") ||
		text.includes("permission denied")
	) {
		return {
			category: "permission_denied",
			message: `Permission denied during ${event.toolName}: ${output.slice(0, 200)}`,
			toolName: event.toolName,
		};
	}

	// 3. Disk full (ENOSPC)
	if (text.includes("enospc") || text.includes("no space left on device")) {
		return {
			category: "disk_full",
			message: `Disk full during ${event.toolName}: ${output.slice(0, 200)}`,
			toolName: event.toolName,
		};
	}

	// 4. Git command failures in worktrees
	if (
		text.includes("fatal:") &&
		(text.includes("worktree") ||
			text.includes("unable to checkout") ||
			text.includes("untracked files") ||
			text.includes("merge conflict"))
	) {
		return {
			category: "git_worktree_failure",
			message: `Git worktree failure during ${event.toolName}: ${output.slice(0, 200)}`,
			toolName: event.toolName,
		};
	}

	// 5. Missing toolchain binary even after successful-looking install.
	// Symptom: exit code 2 and "No such file or directory" in node_modules/.bin/
	if (exitCode === 2 && text.includes("no such file or directory")) {
		const pathMatch = /(node_modules\/[^'"\s]*)/i.exec(output);
		if (pathMatch?.[1]?.includes("node_modules/.bin/")) {
			return {
				category: "missing_binary_after_install",
				message: `Missing binary after install: ${pathMatch[1]}`,
				toolName: event.toolName,
			};
		}
		if (pathMatch?.[1]?.includes("node_modules")) {
			return {
				category: "missing_toolchain_binary",
				message: `Missing toolchain binary: ${pathMatch[1]}`,
				toolName: event.toolName,
			};
		}
	}

	// Catch-all for missing binaries in .bin after install-like commands
	if (
		exitCode !== 0 &&
		(text.includes("not found") || text.includes("no such file or directory"))
	) {
		return {
			category: "missing_toolchain_binary",
			message: `Missing toolchain during ${event.toolName}: ${output.slice(0, 200)}`,
			toolName: event.toolName,
		};
	}

	return null;
}
