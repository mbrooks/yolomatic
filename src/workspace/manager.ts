import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { WorkspaceConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
	owner: string;
	repo: string;
	issueNumber: number;
	path: string;
	branch: string;
}

export interface CommandRunner {
	(
		command: string,
		args: string[],
		options?: {
			cwd?: string;
		},
	): Promise<{ stdout: string; stderr: string }>;
}

function normalizeSegment(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`${label} is required`);
	}
	if (!/^[a-zA-Z0-9._-]+$/u.test(trimmed)) {
		throw new Error(`Invalid ${label}: ${value}`);
	}
	return trimmed;
}

export class WorkspaceManager {
	public constructor(
		private readonly config: WorkspaceConfig,
		private readonly runCommand: CommandRunner = async (command, args, options) => {
			return execFileAsync(command, args, {
				cwd: options?.cwd,
				env: process.env,
			});
		},
	) {}

	getRepoKey(owner: string, repo: string): string {
		return `${normalizeSegment(owner, "owner")}-${normalizeSegment(repo, "repo")}`.toLowerCase();
	}

	getBareRepoPath(owner: string, repo: string): string {
		return path.join(this.config.workspacesDir, this.getRepoKey(owner, repo));
	}

	getWorktreePath(owner: string, repo: string, issueNumber: number): string {
		return path.join(this.getBareRepoPath(owner, repo), ".worktrees", `issue-${issueNumber}`);
	}

	getBranchName(issueNumber: number): string {
		return `tars/issue-${issueNumber}`;
	}

	async createOrGetWorktree(owner: string, repo: string, issueNumber: number): Promise<WorktreeInfo> {
		const normalizedOwner = normalizeSegment(owner, "owner");
		const normalizedRepo = normalizeSegment(repo, "repo");
		const bareRepoPath = this.getBareRepoPath(normalizedOwner, normalizedRepo);
		const worktreePath = this.getWorktreePath(normalizedOwner, normalizedRepo, issueNumber);
		const branchName = this.getBranchName(issueNumber);

		await mkdir(this.config.workspacesDir, { recursive: true });
		await this.ensureBareRepo(normalizedOwner, normalizedRepo);

		if (await this.worktreeExists(bareRepoPath, issueNumber)) {
			return {
				owner: normalizedOwner,
				repo: normalizedRepo,
				issueNumber,
				path: worktreePath,
				branch: branchName,
			};
		}

		const existsBranch = await this.branchExists(bareRepoPath, branchName);

		if (existsBranch) {
			await this.runCommand("git", ["worktree", "add", worktreePath, branchName], {
				cwd: bareRepoPath,
			});
		} else {
			await this.runCommand("git", ["worktree", "add", worktreePath, "-b", branchName], {
				cwd: bareRepoPath,
			});
		}

		return {
			owner: normalizedOwner,
			repo: normalizedRepo,
			issueNumber,
			path: worktreePath,
			branch: branchName,
		};
	}

	async removeWorktree(owner: string, repo: string, issueNumber: number): Promise<void> {
		const bareRepoPath = this.getBareRepoPath(owner, repo);
		const worktreePath = this.getWorktreePath(owner, repo, issueNumber);

		if (await this.worktreeExists(bareRepoPath, issueNumber)) {
			await this.runCommand("git", ["worktree", "remove", worktreePath], {
				cwd: bareRepoPath,
			});
		}
	}

	async commitAndPush(owner: string, repo: string, issueNumber: number): Promise<void> {
		const worktreePath = this.getWorktreePath(owner, repo, issueNumber);
		const branchName = this.getBranchName(issueNumber);

		await this.runCommand("git", ["add", "-A"], { cwd: worktreePath });

		if (await this.hasChanges(worktreePath, true)) {
			await this.runCommand(
				"git",
				["commit", "-m", `TARS: Changes for issue #${issueNumber}`],
				{ cwd: worktreePath },
			);
		}

		try {
			await this.runCommand("git", ["push", "origin", branchName], { cwd: worktreePath });
		} catch {
			// Push may fail for benign reasons (already up to date, etc.).
		}
	}

	private async ensureBareRepo(owner: string, repo: string): Promise<void> {
		const bareRepoPath = this.getBareRepoPath(owner, repo);

		if (await this.pathExists(bareRepoPath)) {
			await this.runCommand("git", ["fetch", "--all", "--prune"], { cwd: bareRepoPath });
			return;
		}

		const encodedUsername = encodeURIComponent(this.config.githubUsername);
		const encodedToken = encodeURIComponent(this.config.githubToken);
		const url = `https://${encodedUsername}:${encodedToken}@github.com/${owner}/${repo}.git`;

		await this.runCommand("git", ["clone", "--bare", url, bareRepoPath]);
	}

	private async worktreeExists(bareRepoPath: string, issueNumber: number): Promise<boolean> {
		try {
			const { stdout } = await this.runCommand("git", ["worktree", "list"], { cwd: bareRepoPath });
			return stdout.includes(`.worktrees/issue-${issueNumber}`);
		} catch {
			return false;
		}
	}

	private async branchExists(bareRepoPath: string, branchName: string): Promise<boolean> {
		try {
			await this.runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
				cwd: bareRepoPath,
			});
			return true;
		} catch {
			return false;
		}
	}

	async hasChanges(workspacePath: string, cached = false): Promise<boolean> {
		try {
			const args = cached ? ["diff", "--cached", "--quiet"] : ["diff", "--quiet"];
			await this.runCommand("git", args, { cwd: workspacePath });
			return false;
		} catch {
			return true;
		}
	}

	private async pathExists(targetPath: string): Promise<boolean> {
		try {
			await stat(targetPath);
			return true;
		} catch {
			return false;
		}
	}
}
