import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { WorkspaceConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface CommandRunner {
	(
		command: string,
		args: string[],
		options?: {
			cwd?: string;
		},
	): Promise<{ stdout: string; stderr: string }>;
}

export function createCommandRunner(): CommandRunner {
	return async (command, args, options) => {
		return execFileAsync(command, args, {
			cwd: options?.cwd,
			env: process.env,
		});
	};
}

export class GitCommandRunner {
	public constructor(
		private readonly config: WorkspaceConfig,
		private readonly runCommand: CommandRunner = createCommandRunner(),
	) {}

	run(command: string, args: string[], options?: { cwd?: string }): Promise<{ stdout: string; stderr: string }> {
		return this.runCommand(command, args, options);
	}

	async branchHasCommitsAhead(worktreePath: string, baseBranch?: string): Promise<boolean> {
		try {
			const { stdout } = await this.run(
				"git",
				["rev-list", "--count", `origin/${baseBranch ?? this.config.defaultBranch}..HEAD`],
				{ cwd: worktreePath },
			);
			return parseInt(stdout.trim(), 10) > 0;
		} catch {
			return false;
		}
	}

	async ensureGitIdentity(worktreePath: string): Promise<void> {
		const name = "TARS";
		const email = `${this.config.githubUsername}@users.noreply.github.com`;

		await this.run("git", ["config", "user.name", name], { cwd: worktreePath });
		await this.run("git", ["config", "user.email", email], { cwd: worktreePath });
	}

	async hasChanges(workspacePath: string, cached = false): Promise<boolean> {
		try {
			const args = cached ? ["diff", "--cached", "--quiet"] : ["diff", "--quiet"];
			await this.run("git", args, { cwd: workspacePath });
			return false;
		} catch {
			return true;
		}
	}

	async hasAnyChanges(workspacePath: string): Promise<boolean> {
		try {
			const { stdout } = await this.run("git", ["status", "--porcelain"], {
				cwd: workspacePath,
			});
			return stdout.trim().length > 0;
		} catch {
			return true;
		}
	}

	async getGitStatus(worktreePath: string): Promise<string> {
		try {
			const { stdout } = await this.run("git", ["status", "--porcelain"], { cwd: worktreePath });
			return stdout;
		} catch {
			return "(failed to get git status)";
		}
	}

	async getGitDiff(worktreePath: string): Promise<string> {
		try {
			const { stdout } = await this.run("git", ["diff"], { cwd: worktreePath });
			return stdout;
		} catch {
			return "(failed to get git diff)";
		}
	}
}
