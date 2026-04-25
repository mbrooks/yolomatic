import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
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

		if (await this.worktreeExists(bareRepoPath, worktreePath)) {
			await this.sanitizeNodeModules(worktreePath);
			return {
				owner: normalizedOwner,
				repo: normalizedRepo,
				issueNumber,
				path: worktreePath,
				branch: branchName,
			};
		}

		await this.pruneWorktrees(bareRepoPath);

		const existsBranch = await this.branchExists(bareRepoPath, branchName);
		await this.updateDefaultBranch(bareRepoPath);

		try {
			if (existsBranch) {
				await this.runCommand("git", ["worktree", "add", worktreePath, branchName], {
					cwd: bareRepoPath,
				});
			} else {
				await this.runCommand("git", ["worktree", "add", worktreePath, "-b", branchName, this.config.defaultBranch], {
					cwd: bareRepoPath,
				});
			}
		} catch (error) {
			const originalMessage = error instanceof Error ? error.message : String(error);
			throw new Error(
				`[workspace] ERROR: Cannot create worktree for ${branchName}\n\n` +
					`Possible causes:\n` +
					`1. The branch is already checked out in another worktree that still exists.\n` +
					`2. A previous worktree was deleted outside of git, leaving a stale registry entry.\n\n` +
					`How to recover:\n` +
					`- Check existing worktrees: git worktree list\n` +
					`- Remove stale worktree: git worktree remove <path>\n` +
					`- If directory is already gone: git worktree prune\n` +
					`- Force remove if needed: git worktree remove --force <path>\n\n` +
					`Attempting automatic recovery via 'git worktree prune'...\n\n` +
					`Original error: ${originalMessage}`,
			);
		}

		await this.sanitizeNodeModules(worktreePath);

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

		if (await this.worktreeExists(bareRepoPath, worktreePath)) {
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

	private async getWorktreeList(bareRepoPath: string): Promise<Array<{ path: string; branch?: string }>> {
		try {
			const { stdout } = await this.runCommand("git", ["worktree", "list", "--porcelain"], {
				cwd: bareRepoPath,
			});
			const worktrees: Array<{ path: string; branch?: string }> = [];
			let current: { path: string; branch?: string } | null = null;
			for (const line of stdout.split("\n")) {
				if (line.startsWith("worktree ")) {
					if (current) {
						worktrees.push(current);
					}
					current = { path: line.slice("worktree ".length) };
				} else if (line.startsWith("branch ") && current) {
					current.branch = line.slice("branch ".length);
				} else if (line === "" && current) {
					worktrees.push(current);
					current = null;
				}
			}
			if (current) {
				worktrees.push(current);
			}
			return worktrees;
		} catch {
			return [];
		}
	}

	private async worktreeExists(bareRepoPath: string, expectedPath: string): Promise<boolean> {
		const worktrees = await this.getWorktreeList(bareRepoPath);
		return worktrees.some((w) => w.path === expectedPath);
	}

	private async pruneWorktrees(bareRepoPath: string): Promise<void> {
		await this.runCommand("git", ["worktree", "prune"], { cwd: bareRepoPath });
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

	private async updateDefaultBranch(bareRepoPath: string): Promise<void> {
		await this.runCommand("git", ["fetch", "origin", `+${this.config.defaultBranch}:${this.config.defaultBranch}`], {
			cwd: bareRepoPath,
		});
	}

	private async pathExists(targetPath: string): Promise<boolean> {
		try {
			await stat(targetPath);
			return true;
		} catch {
			return false;
		}
	}

	private async sanitizeNodeModules(worktreePath: string): Promise<void> {
		const nodeModulesPath = path.join(worktreePath, "node_modules");
		try {
			const stats = await stat(nodeModulesPath);
			if (!stats.isDirectory()) {
				return;
			}

			const currentUid = process.getuid?.();
			if (currentUid !== undefined && stats.uid !== currentUid) {
				process.stdout.write(
					`[workspace] Removing foreign-owned node_modules (uid=${stats.uid}, current=${currentUid}) at ${nodeModulesPath}\n`,
				);
				await rm(nodeModulesPath, { recursive: true, force: true });
			}
		} catch {
			// node_modules doesn't exist or is inaccessible; nothing to sanitize
		}
	}
}
