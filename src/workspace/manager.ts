import { execFile } from "node:child_process";
import { mkdir, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { WorkspaceConfig } from "./config.js";
import type { WorkspaceService } from "../ports/workspace-service.js";
import { EmptyRepositoryError } from "./errors.js";

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

export class WorkspaceManager implements WorkspaceService {
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

	async initializeRepo(owner: string, repo: string): Promise<void> {
		const normalizedOwner = normalizeSegment(owner, "owner");
		const normalizedRepo = normalizeSegment(repo, "repo");
		await mkdir(this.config.workspacesDir, { recursive: true });
		await this.ensureBareRepo(normalizedOwner, normalizedRepo);
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
			await this.touchWorktree(worktreePath);
			return {
				owner: normalizedOwner,
				repo: normalizedRepo,
				issueNumber,
				path: worktreePath,
				branch: branchName,
			};
		}

		await this.pruneWorktrees(bareRepoPath);
		await this.enforceWorktreeLimit(bareRepoPath, normalizedOwner, normalizedRepo);

		const existsBranch = await this.branchExists(bareRepoPath, branchName);
		await this.updateDefaultBranch(bareRepoPath);
		const baseRef = await this.resolveBaseRef(bareRepoPath);

		try {
			if (existsBranch) {
				await this.runCommand("git", ["branch", "-f", branchName, baseRef], { cwd: bareRepoPath });
				await this.runCommand("git", ["worktree", "add", "--force", worktreePath, branchName], {
					cwd: bareRepoPath,
				});
			} else {
				await this.runCommand(
					"git",
					["worktree", "add", worktreePath, "-b", branchName, baseRef],
					{
						cwd: bareRepoPath,
					},
				);
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

	async commitAndPushPath(
		worktreePath: string,
		branchName: string,
		message?: string,
		baseBranch?: string,
	): Promise<boolean> {
		await this.ensureGitIdentity(worktreePath);
		await this.runCommand("git", ["add", "-A"], { cwd: worktreePath });

		const hasStagedChanges = await this.hasChanges(worktreePath, true);
		if (hasStagedChanges) {
			await this.runCommand(
				"git",
				["commit", "-m", message ?? `TARS: Changes for branch ${branchName}`],
				{ cwd: worktreePath },
			);
		}

		// If there are no staged changes and the branch has no commits ahead of the
		// base branch, there's nothing to deliver. Pushing would create an empty branch
		// that causes GitHub to reject PR creation with "No commits between ...".
		if (!hasStagedChanges && !(await this.branchHasCommitsAhead(worktreePath, baseBranch))) {
			return false;
		}

		await this.runCommand("git", ["push", "origin", branchName], { cwd: worktreePath });
		return true;
	}

	async commitAndPush(owner: string, repo: string, issueNumber: number, message?: string): Promise<boolean> {
		const worktreePath = this.getWorktreePath(owner, repo, issueNumber);
		const branchName = this.getBranchName(issueNumber);
		return this.commitAndPushPath(worktreePath, branchName, message ?? `TARS: Changes for issue #${issueNumber}`);
	}

	private async branchHasCommitsAhead(worktreePath: string, baseBranch?: string): Promise<boolean> {
		try {
			const { stdout } = await this.runCommand(
				"git",
				["rev-list", "--count", `origin/${baseBranch ?? this.config.defaultBranch}..HEAD`],
				{ cwd: worktreePath },
			);
			return parseInt(stdout.trim(), 10) > 0;
		} catch {
			return false;
		}
	}

	private async ensureGitIdentity(worktreePath: string): Promise<void> {
		const name = "TARS";
		const email = `${this.config.githubUsername}@users.noreply.github.com`;

		await this.runCommand("git", ["config", "user.name", name], { cwd: worktreePath });
		await this.runCommand("git", ["config", "user.email", email], { cwd: worktreePath });
	}

	private async ensureBareRepo(owner: string, repo: string): Promise<void> {
		const bareRepoPath = this.getBareRepoPath(owner, repo);

		if (await this.pathExists(bareRepoPath)) {
			const isValid = await this.isValidGitRepo(bareRepoPath);
			if (isValid) {
				await this.runCommand("git", ["fetch", "--all", "--prune"], { cwd: bareRepoPath });
				return;
			}
			await rm(bareRepoPath, { recursive: true, force: true });
		}

		const encodedUsername = encodeURIComponent(this.config.githubUsername);
		const encodedToken = encodeURIComponent(this.config.githubToken);
		const url = `https://${encodedUsername}:${encodedToken}@github.com/${owner}/${repo}.git`;

		await this.runCommand("git", ["clone", "--bare", url, bareRepoPath]);
	}

	private async isValidGitRepo(bareRepoPath: string): Promise<boolean> {
		try {
			await this.runCommand("git", ["rev-parse", "--git-dir"], { cwd: bareRepoPath });
			return true;
		} catch {
			return false;
		}
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
		await this.runCommand("git", ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*", "--prune"], {
			cwd: bareRepoPath,
		});

		try {
			await this.runCommand("git", ["remote", "set-head", "origin", "-a"], { cwd: bareRepoPath });
		} catch {
			// Some repositories or older bare clones may not have enough remote
			// metadata for origin/HEAD. resolveBaseRef() has fallbacks.
		}
	}

	private async resolveBaseRef(bareRepoPath: string): Promise<string> {
		const candidates = [
			"origin/HEAD",
			`origin/${this.config.defaultBranch}`,
			`refs/remotes/origin/${this.config.defaultBranch}`,
			this.config.defaultBranch,
			`refs/heads/${this.config.defaultBranch}`,
			"HEAD",
		];

		for (const candidate of candidates) {
			if (await this.refExists(bareRepoPath, candidate)) {
				return candidate;
			}
		}

		try {
			const { stdout } = await this.runCommand("git", ["branch", "-r", "--format=%(refname:short)"], {
				cwd: bareRepoPath,
			});
			const remoteBranches = stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "" && line !== "origin/HEAD");

			if (remoteBranches.length === 1 && await this.refExists(bareRepoPath, remoteBranches[0])) {
				return remoteBranches[0];
			}
		} catch {
			// Fall through to diagnostic error below.
		}

		throw new EmptyRepositoryError(bareRepoPath);
	}

	private async refExists(bareRepoPath: string, ref: string): Promise<boolean> {
		try {
			await this.runCommand("git", ["rev-parse", "--verify", ref], { cwd: bareRepoPath });
			return true;
		} catch {
			return false;
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

	private async touchWorktree(worktreePath: string): Promise<void> {
		try {
			// Bias forward slightly so coarse filesystem timestamp resolution still records access.
			const now = new Date(Date.now() + 1000);
			await utimes(worktreePath, now, now);
		} catch {
			// ignore
		}
	}

	private async enforceWorktreeLimit(bareRepoPath: string, owner: string, repo: string): Promise<void> {
		const maxWorktrees = this.config.maxWorktrees ?? 10;
		const allWorktrees = await this.getWorktreeList(bareRepoPath);
		const worktreeCount = allWorktrees.filter((w) => w.path !== bareRepoPath).length;
		if (worktreeCount < maxWorktrees) {
			return;
		}

		const sorted = await this.sortWorktreesForEviction(allWorktrees, bareRepoPath);
		const victim = sorted[0];
		if (!victim) {
			return;
		}

		const victimInfo = allWorktrees.find((w) => w.path === victim.path);
		await this.safeEvictWorktree(victim.path, victimInfo?.branch, bareRepoPath, owner, repo);
	}

	private async sortWorktreesForEviction(
		candidates: Array<{ path: string; branch?: string }>,
		bareRepoPath: string,
	): Promise<Array<{ path: string; branch?: string }>> {
		const filtered = candidates.filter((w) => w.path !== bareRepoPath);
		const withTimestamps = await Promise.all(
			filtered.map(async (w) => {
				try {
					const stats = await stat(w.path);
					return {
						path: w.path,
						branch: w.branch,
						birthtimeMs: stats.birthtimeMs || stats.ctimeMs,
						mtimeMs: stats.mtimeMs,
					};
				} catch {
					return {
						path: w.path,
						branch: w.branch,
						birthtimeMs: Number.POSITIVE_INFINITY,
						mtimeMs: Number.POSITIVE_INFINITY,
					};
				}
			}),
		);

		const strategy = this.config.evictionStrategy ?? "lru";
		if (strategy === "fifo") {
			return withTimestamps.sort((a, b) => a.birthtimeMs - b.birthtimeMs);
		}
		return withTimestamps.sort((a, b) => a.mtimeMs - b.mtimeMs);
	}

	private async safeEvictWorktree(
		worktreePath: string,
		branch: string | undefined,
		bareRepoPath: string,
		owner: string,
		repo: string,
	): Promise<void> {
		const hasUncommitted = await this.hasAnyChanges(worktreePath);
		if (hasUncommitted) {
			await this.ensureGitIdentity(worktreePath);
			const stashMessage = `TARS auto-stash before eviction of ${path.basename(worktreePath)}`;
			await this.runCommand("git", ["stash", "push", "-m", stashMessage, "-u"], {
				cwd: worktreePath,
			});
		}

		try {
			await this.runCommand("git", ["worktree", "remove", worktreePath], {
				cwd: bareRepoPath,
			});
		} catch {
			await this.runCommand("git", ["worktree", "remove", "--force", worktreePath], {
				cwd: bareRepoPath,
			});
		}

		const strategy = this.config.evictionStrategy ?? "lru";
		const maxWorktrees = this.config.maxWorktrees ?? 10;
		process.stdout.write(
			`[workspace] Evicted worktree ${worktreePath}${branch ? ` (${branch})` : ""} for ${owner}/${repo}. ` +
				`Strategy: ${strategy}, limit: ${maxWorktrees}. ` +
				`Uncommitted changes: ${hasUncommitted ? "stashed" : "none"}\n`,
		);
	}

	private async hasAnyChanges(workspacePath: string): Promise<boolean> {
		try {
			const { stdout } = await this.runCommand("git", ["status", "--porcelain"], {
				cwd: workspacePath,
			});
			return stdout.trim().length > 0;
		} catch {
			return true;
		}
	}

	async getGitStatus(owner: string, repo: string, issueNumber: number): Promise<string> {
		const worktreePath = this.getWorktreePath(owner, repo, issueNumber);
		try {
			const { stdout } = await this.runCommand("git", ["status", "--porcelain"], { cwd: worktreePath });
			return stdout;
		} catch {
			return "(failed to get git status)";
		}
	}

	async getGitDiff(owner: string, repo: string, issueNumber: number): Promise<string> {
		const worktreePath = this.getWorktreePath(owner, repo, issueNumber);
		try {
			const { stdout } = await this.runCommand("git", ["diff"], { cwd: worktreePath });
			return stdout;
		} catch {
			return "(failed to get git diff)";
		}
	}
}
