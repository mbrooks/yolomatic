import { mkdir, rename, stat, utimes } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceConfig } from "./config.js";
import { BareRepoManager } from "./bare-repo.js";
import { WorktreeBranchDivergedError } from "./errors.js";
import { GitCommandRunner } from "./git-runner.js";
import { getBranchName, getWorktreePath, normalizeSegment } from "./paths.js";

export interface WorktreeInfo {
	owner: string;
	repo: string;
	issueNumber: number;
	path: string;
	branch: string;
}

export class WorktreeManager {
	public constructor(
		private readonly config: WorkspaceConfig,
		private readonly git: GitCommandRunner,
		private readonly bareRepos: BareRepoManager,
	) {}

	getWorktreePath(owner: string, repo: string, issueNumber: number): string {
		return getWorktreePath(this.config.workspacesDir, owner, repo, issueNumber);
	}

	getBranchName(issueNumber: number): string {
		return getBranchName(issueNumber);
	}

	async createOrGetWorktree(owner: string, repo: string, issueNumber: number): Promise<WorktreeInfo> {
		const normalizedOwner = normalizeSegment(owner, "owner");
		const normalizedRepo = normalizeSegment(repo, "repo");
		const bareRepoPath = await this.bareRepos.ensureBareRepo(normalizedOwner, normalizedRepo);
		const worktreePath = this.getWorktreePath(normalizedOwner, normalizedRepo, issueNumber);
		const branchName = this.getBranchName(issueNumber);

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

		const existsBranch = await this.bareRepos.branchExists(bareRepoPath, branchName);
		await this.bareRepos.updateDefaultBranch(bareRepoPath);
		const baseRef = await this.bareRepos.resolveBaseRef(bareRepoPath);

		try {
			if (existsBranch) {
				await this.git.run("git", ["branch", "-f", branchName, baseRef], { cwd: bareRepoPath });
				await this.git.run("git", ["worktree", "add", "--force", worktreePath, branchName], {
					cwd: bareRepoPath,
				});
			} else {
				await this.git.run("git", ["worktree", "add", worktreePath, "-b", branchName, baseRef], {
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

		return {
			owner: normalizedOwner,
			repo: normalizedRepo,
			issueNumber,
			path: worktreePath,
			branch: branchName,
		};
	}

	/**
	 * Refresh a worktree from origin so a worker starts on a fresh,
	 * conflict-free, credential-free workspace.
	 *
	 * 1. Fetch origin in the bare repo (updates origin/main and origin/<branch>).
	 * 2. Fast-forward the worktree branch to origin/<branch> without discarding
	 *    un-pushed local commits. If the branch has not been pushed yet, leave
	 *    the locally-created branch in place. If the branch has diverged from
	 *    origin, raise WorktreeBranchDivergedError so the control plane can
	 *    resolve it via the GitHub update-branch API.
	 * 3. Sanitize remote.origin.url so no token is ever visible to the worker.
	 *
	 * Stashes and restores a dirty worktree from a previous session; if the
	 * stash pop conflicts, the session must fail.
	 */
	async syncWorktree(owner: string, repo: string, issueNumber: number): Promise<void> {
		const normalizedOwner = normalizeSegment(owner, "owner");
		const normalizedRepo = normalizeSegment(repo, "repo");
		const bareRepoPath = this.bareRepos.getBareRepoPath(normalizedOwner, normalizedRepo);
		const worktreePath = this.getWorktreePath(normalizedOwner, normalizedRepo, issueNumber);
		const branchName = this.getBranchName(issueNumber);
		const remoteRef = `origin/${branchName}`;
		const sanitizedUrl = `https://github.com/${normalizedOwner}/${normalizedRepo}.git`;

		if (!(await this.worktreeExists(bareRepoPath, worktreePath))) {
			throw new Error(
				`[workspace] syncWorktree called before createOrGetWorktree for ${normalizedOwner}/${normalizedRepo}#${issueNumber}`,
			);
		}

		await this.bareRepos.fetchOrigin(bareRepoPath);

		const stashed = await this.stashIfDirty(worktreePath, `Yeetomatic auto-stash before sync of issue-${issueNumber}`);

		const remoteExists = await this.bareRepos.remoteBranchExists(bareRepoPath, branchName);
		if (remoteExists) {
			try {
				await this.git.run("git", ["merge", "--ff-only", remoteRef], { cwd: worktreePath });
			} catch (error) {
				await this.popStashSafely(worktreePath, stashed);
				throw new WorktreeBranchDivergedError(branchName, remoteRef);
			}
		}

		await this.popStashSafely(worktreePath, stashed);

		try {
			await this.git.run("git", ["remote", "set-url", "origin", sanitizedUrl], { cwd: worktreePath });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`[workspace] Failed to sanitize remote.origin.url for ${normalizedOwner}/${normalizedRepo}#${issueNumber}: ${message}`,
			);
		}
	}

	private async stashIfDirty(worktreePath: string, message: string): Promise<boolean> {
		const dirty = await this.git.hasAnyChanges(worktreePath);
		if (!dirty) {
			return false;
		}
		await this.git.ensureGitIdentity(worktreePath);
		await this.git.run("git", ["stash", "push", "-m", message, "-u"], { cwd: worktreePath });
		return true;
	}

	private async popStashSafely(worktreePath: string, stashed: boolean): Promise<void> {
		if (!stashed) {
			return;
		}
		try {
			await this.git.run("git", ["stash", "pop"], { cwd: worktreePath });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`[workspace] Could not restore stashed changes after sync in ${worktreePath}: ${message}. ` +
					`The stash is preserved; resolve the conflict manually before relaunching.`,
			);
		}
	}

	async removeWorktree(owner: string, repo: string, issueNumber: number): Promise<void> {
		const bareRepoPath = this.bareRepos.getBareRepoPath(owner, repo);
		const worktreePath = this.getWorktreePath(owner, repo, issueNumber);

		if (!(await this.worktreeExists(bareRepoPath, worktreePath))) {
			return;
		}

		const { stashed, forced } = await this.performSafeRemoval(
			worktreePath,
			bareRepoPath,
			`Yeetomatic auto-stash before cleanup of issue-${issueNumber}`,
		);

		const changeSummary = stashed ? "stashed" : "none";
		process.stdout.write(
			`[workspace] Removed worktree ${worktreePath} for ${owner}/${repo}#${issueNumber}. ` +
				`Uncommitted changes: ${changeSummary}${forced ? " (force-removed)" : ""}\n`,
		);
	}

	private async performSafeRemoval(
		worktreePath: string,
		bareRepoPath: string,
		stashMessage: string,
	): Promise<{ stashed: boolean; forced: boolean }> {
		const hasUncommitted = await this.git.hasAnyChanges(worktreePath);
		if (hasUncommitted) {
			await this.git.ensureGitIdentity(worktreePath);
			await this.git.run("git", ["stash", "push", "-m", stashMessage, "-u"], {
				cwd: worktreePath,
			});
		}

		let forced = false;
		try {
			await this.git.run("git", ["worktree", "remove", worktreePath], {
				cwd: bareRepoPath,
			});
		} catch (removeError) {
			try {
				await this.git.run("git", ["worktree", "remove", "--force", worktreePath], {
					cwd: bareRepoPath,
				});
				forced = true;
			} catch (forceError) {
				const recovered = await this.recoverBlockedWorktreeRemoval(worktreePath, bareRepoPath, forceError);
				if (!recovered) {
					throw forceError instanceof Error ? forceError : removeError;
				}
				forced = true;
			}
		}

		return { stashed: hasUncommitted, forced };
	}

	private async getWorktreeList(bareRepoPath: string): Promise<Array<{ path: string; branch?: string }>> {
		try {
			const { stdout } = await this.git.run("git", ["worktree", "list", "--porcelain"], {
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
		return worktrees.some((worktree) => worktree.path === expectedPath);
	}

	private async pruneWorktrees(bareRepoPath: string): Promise<void> {
		await this.git.run("git", ["worktree", "prune"], { cwd: bareRepoPath });
	}

	private async touchWorktree(worktreePath: string): Promise<void> {
		try {
			const now = new Date(Date.now() + 1000);
			await utimes(worktreePath, now, now);
		} catch {
			// ignore
		}
	}

	private async enforceWorktreeLimit(bareRepoPath: string, owner: string, repo: string): Promise<void> {
		const maxWorktrees = this.config.maxWorktrees ?? 10;
		const allWorktrees = await this.getWorktreeList(bareRepoPath);
		const worktreeCount = allWorktrees.filter((worktree) => worktree.path !== bareRepoPath).length;
		if (worktreeCount < maxWorktrees) {
			return;
		}

		const sorted = await this.sortWorktreesForEviction(allWorktrees, bareRepoPath);
		const failures: string[] = [];
		for (const victim of sorted) {
			const victimInfo = allWorktrees.find((worktree) => worktree.path === victim.path);
			try {
				await this.safeEvictWorktree(victim.path, victimInfo?.branch, bareRepoPath, owner, repo);
				return;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(`${victim.path}: ${message}`);
				process.stdout.write(
					`[workspace] Skipped eviction of ${victim.path} for ${owner}/${repo}: ${message}\n`,
				);
			}
		}

		throw new Error(
			`[workspace] ERROR: Cannot evict any worktree for ${owner}/${repo}\n\n` +
				`Tried ${sorted.length} candidate(s) but each cleanup failed.\n` +
				failures.map((failure) => `- ${failure}`).join("\n"),
		);
	}

	private async sortWorktreesForEviction(
		candidates: Array<{ path: string; branch?: string }>,
		bareRepoPath: string,
	): Promise<Array<{ path: string; branch?: string }>> {
		const filtered = candidates.filter((worktree) => worktree.path !== bareRepoPath);
		const withTimestamps = await Promise.all(
			filtered.map(async (worktree) => {
				try {
					const stats = await stat(worktree.path);
					return {
						path: worktree.path,
						branch: worktree.branch,
						birthtimeMs: stats.birthtimeMs || stats.ctimeMs,
						mtimeMs: stats.mtimeMs,
					};
				} catch {
					return {
						path: worktree.path,
						branch: worktree.branch,
						birthtimeMs: Number.POSITIVE_INFINITY,
						mtimeMs: Number.POSITIVE_INFINITY,
					};
				}
			}),
		);

		const strategy = this.config.evictionStrategy ?? "lru";
		if (strategy === "fifo") {
			return withTimestamps.sort((left, right) => left.birthtimeMs - right.birthtimeMs);
		}
		return withTimestamps.sort((left, right) => left.mtimeMs - right.mtimeMs);
	}

	private async safeEvictWorktree(
		worktreePath: string,
		branch: string | undefined,
		bareRepoPath: string,
		owner: string,
		repo: string,
	): Promise<void> {
		const stashMessage = `Yeetomatic auto-stash before eviction of ${path.basename(worktreePath)}`;
		const { stashed: hasUncommitted } = await this.performSafeRemoval(worktreePath, bareRepoPath, stashMessage);

		const strategy = this.config.evictionStrategy ?? "lru";
		const maxWorktrees = this.config.maxWorktrees ?? 10;
		process.stdout.write(
			`[workspace] Evicted worktree ${worktreePath}${branch ? ` (${branch})` : ""} for ${owner}/${repo}. ` +
				`Strategy: ${strategy}, limit: ${maxWorktrees}. ` +
				`Uncommitted changes: ${hasUncommitted ? "stashed" : "none"}\n`,
		);
	}

	private async recoverBlockedWorktreeRemoval(
		worktreePath: string,
		bareRepoPath: string,
		error: unknown,
	): Promise<boolean> {
		if (!this.isPermissionCleanupError(error)) {
			return false;
		}

		const quarantineRoot = path.join(bareRepoPath, ".quarantined-worktrees");
		const quarantinePath = path.join(
			quarantineRoot,
			`${path.basename(worktreePath)}-${Date.now()}`,
		);
		await mkdir(quarantineRoot, { recursive: true });
		await rename(worktreePath, quarantinePath);
		await this.pruneWorktrees(bareRepoPath);
		process.stdout.write(
			`[workspace] Quarantined blocked worktree ${worktreePath} to ${quarantinePath} after permission-denied cleanup.\n`,
		);
		return true;
	}

	private isPermissionCleanupError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		return (
			message.includes("EACCES") ||
			message.includes("EPERM") ||
			message.includes("permission denied") ||
			message.includes("Permission denied")
		);
	}
}
