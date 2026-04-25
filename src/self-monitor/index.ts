import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { classifyFatalError } from "./classifier.js";
import type { Evidence, FatalErrorDetails, ToolCallRecord } from "./types.js";

const execFileAsync = promisify(execFile);

const MAX_TOOL_HISTORY = 20;

export class FatalSystemError extends Error {
	public readonly evidence: Evidence;

	constructor(evidence: Evidence) {
		const summary = evidence.fatalError.message;
		super(`Fatal system error: ${evidence.fatalError.category} — ${summary}`);
		this.name = "FatalSystemError";
		this.evidence = evidence;
	}
}

function sanitizeEnv(str: string): string {
	return str
		.replace(/[A-Z_]*TOKEN[A-Z_]*=[^\s"]*/gi, "[REDACTED]")
		.replace(/[A-Z_]*SECRET[A-Z_]*=[^\s"]*/gi, "[REDACTED]")
		.replace(/[A-Z_]*KEY[A-Z_]*=[^\s"]*/gi, "[REDACTED]")
		.replace(/ghp_[a-zA-Z0-9]+/g, "[REDACTED]")
		.replace(/ghs_[a-zA-Z0-9]+/g, "[REDACTED]")
		.replace(/github_pat_[a-zA-Z0-9_]+/g, "[REDACTED]");
}

function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return `${str.slice(0, max)}… (truncated)`;
}

export class SelfMonitor {
	private readonly toolHistory: ToolCallRecord[] = [];
	private fatalError: FatalErrorDetails | null = null;
	private readonly workspacePath: string;

	constructor(workspacePath: string) {
		this.workspacePath = workspacePath;
	}

	recordToolEnd(toolName: string, result: unknown, isError: boolean): void {
		this.toolHistory.push({
			toolName,
			args: undefined, // omitted to avoid leaking secrets
			result: sanitizeEnv(truncate(JSON.stringify(result), 2000)),
			isError,
			timestamp: new Date().toISOString(),
		});
		if (this.toolHistory.length > MAX_TOOL_HISTORY) {
			this.toolHistory.shift();
		}

		if (!this.fatalError) {
			const details = classifyFatalError({ toolName, result, isError });
			if (details) {
				this.fatalError = details;
			}
		}
	}

	hasFatalError(): boolean {
		return this.fatalError !== null;
	}

	async createFatalSystemError(): Promise<FatalSystemError> {
		if (!this.fatalError) {
			throw new Error("No fatal error recorded");
		}
		const systemEvidence = await this.gatherSystemEvidence();
		return new FatalSystemError({
			toolHistory: [...this.toolHistory],
			fatalError: this.fatalError,
			systemEvidence,
		});
	}

	private async runCommand(command: string, args: string[]): Promise<string> {
		try {
			const { stdout } = await execFileAsync(command, args, {
				cwd: this.workspacePath,
				timeout: 10000,
			});
			return sanitizeEnv(stdout.trim());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return `(failed: ${sanitizeEnv(message)})`;
		}
	}

	private async gatherSystemEvidence(): Promise<Evidence["systemEvidence"]> {
		const timestamp = new Date().toISOString();
		const [whoami, pwd, lsWorkspace, gitStatus, gitBranch, nodeVersion] = await Promise.all([
			this.runCommand("whoami", []),
			this.runCommand("pwd", []),
			this.runCommand("ls", ["-la", this.workspacePath]),
			this.runCommand("git", ["status", "--short"]),
			this.runCommand("git", ["branch", "--show-current"]),
			this.runCommand("node", ["--version"]),
		]);

		return {
			whoami,
			pwd,
			workspacePath: this.workspacePath,
			lsWorkspace,
			gitStatus,
			gitBranch,
			nodeVersion,
			timestamp,
		};
	}

	static formatBugReportBody(evidence: Evidence): string {
		const { fatalError, systemEvidence, toolHistory } = evidence;
		return [
			`**Timestamp:** ${systemEvidence.timestamp}`,
			`**Branch / worktree path:** ${systemEvidence.workspacePath} (${systemEvidence.gitBranch})`,
			`**Error category:** \`${fatalError.category}\``,
			``,
			`## Steps that led to the failure`,
			`- Tool: \`${fatalError.toolName}\``,
			`- Message: ${fatalError.message}`,
			``,
			`## System diagnostics`,
			`- **User:** ${systemEvidence.whoami}`,
			`- **PWD:** ${systemEvidence.pwd}`,
			`- **Node:** ${systemEvidence.nodeVersion}`,
			`- **Git status:**`,
			``,
			"```",
			systemEvidence.gitStatus || "(clean)",
			"```",
			`- **Workspace listing:**`,
			`<details>`,
			`<summary>ls -la</summary>`,
			``,
			"```",
			systemEvidence.lsWorkspace,
			"```",
			`</details>`,
			``,
			`## Recent tool history`,
			`<details>`,
			`<summary>Last ${toolHistory.length} tool calls</summary>`,
			``,
			"```json",
			JSON.stringify(toolHistory, null, 2),
			"```",
			`</details>`,
			``,
			`## Suggested remediation`,
			SelfMonitor.getRemediation(fatalError.category),
		].join("\n");
	}

	static getRemediation(category: string): string {
		switch (category) {
			case "missing_binary_after_install":
			case "permission_denied":
				return "Check directory ownership (`ls -la node_modules`) and ensure the runtime user matches the install user. Remove `node_modules` and reinstall if necessary.";
			case "disk_full":
				return "Free up disk space on the host. Check `df -h` and clean up old worktrees, logs, or temporary files.";
			case "git_worktree_failure":
				return "Run `git worktree list` and `git worktree prune` to clean up stale entries. Check for untracked files that block checkout.";
			case "missing_toolchain_binary":
				return "Verify the toolchain installation and PATH. Re-install missing packages or binaries.";
			default:
				return "Investigate the underlying system state and retry after resolving the root cause.";
		}
	}

	static getIssueTitle(evidence: Evidence): string {
		const short = evidence.fatalError.message.slice(0, 80);
		return `TARS self-report: ${short}`;
	}

	static getTargetRepo(): { owner: string; repo: string } {
		return { owner: "mbrooks", repo: "tars" };
	}
}
