import type { WorkspaceConfig } from "./config.js";
import type { WorkspaceService } from "../ports/workspace-service.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { BareRepoManager } from "./bare-repo.js";
import { type CommandRunner, createCommandRunner, GitCommandRunner } from "./git-runner.js";
import { getBareRepoPath, getBranchName, getRepoKey, getWorktreePath, normalizeSegment } from "./paths.js";
import { WorktreeManager } from "./worktree.js";

export type { CommandRunner } from "./git-runner.js";

function isNonFastForwardPushError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const stderr =
		typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
			? error.stderr
			: "";
	return /(non-fast-forward|fetch first|\[rejected\].*non-fast-forward)/iu.test(`${message}\n${stderr}`);
}

export class WorkspaceManager implements WorkspaceService {
	private readonly git: GitCommandRunner;

	private readonly bareRepos: BareRepoManager;

	private readonly worktrees: WorktreeManager;

	public constructor(
		private readonly config: WorkspaceConfig,
		runCommand: CommandRunner = createCommandRunner(),
	) {
		this.git = new GitCommandRunner(config, runCommand);
		this.bareRepos = new BareRepoManager(config, this.git);
		this.worktrees = new WorktreeManager(config, this.git, this.bareRepos);
	}

	getRepoKey(owner: string, repo: string): string {
		return getRepoKey(owner, repo);
	}

	getBareRepoPath(owner: string, repo: string): string {
		return getBareRepoPath(this.config.workspacesDir, owner, repo);
	}

	getWorktreePath(owner: string, repo: string, issueNumber: number): string {
		return getWorktreePath(this.config.workspacesDir, owner, repo, issueNumber);
	}

	getBranchName(issueNumber: number): string {
		return getBranchName(issueNumber);
	}

	async updateDefaultBranchFromOrigin(
		owner: string,
		repo: string,
	): Promise<{ branch: string; before: string | null; after: string; updated: boolean }> {
		const normalizedOwner = normalizeSegment(owner, "owner");
		const normalizedRepo = normalizeSegment(repo, "repo");
		await mkdir(this.config.workspacesDir, { recursive: true });
		const bareRepoPath = await this.bareRepos.ensureBareRepo(normalizedOwner, normalizedRepo);
		const branch =
			this.config.resolveDefaultBranch?.(normalizedOwner, normalizedRepo) ??
			this.config.defaultBranch ??
			"main";
		return this.bareRepos.updateLocalBranchToOrigin(bareRepoPath, branch);
	}

	async initializeRepo(owner: string, repo: string): Promise<void> {
		await mkdir(this.config.workspacesDir, { recursive: true });
		await this.bareRepos.ensureBareRepo(owner, repo);
	}

	async createOrGetWorktree(owner: string, repo: string, issueNumber: number): Promise<{ path: string; branch: string }> {
		await mkdir(this.config.workspacesDir, { recursive: true });
		const worktree = await this.worktrees.createOrGetWorktree(owner, repo, issueNumber);
		return { path: worktree.path, branch: worktree.branch };
	}

	async syncWorktree(owner: string, repo: string, issueNumber: number): Promise<void> {
		await mkdir(this.config.workspacesDir, { recursive: true });
		await this.worktrees.syncWorktree(owner, repo, issueNumber);
	}

	async removeWorktree(owner: string, repo: string, issueNumber: number): Promise<void> {
		await this.worktrees.removeWorktree(owner, repo, issueNumber);
	}

	async commitAndPushPath(
		worktreePath: string,
		branchName: string,
		message?: string,
		baseBranch?: string,
		expectedRemoteHead?: string,
	): Promise<boolean> {
		await this.git.ensureGitIdentity(worktreePath);
		await this.git.run("git", ["add", "-A"], { cwd: worktreePath });

		const hasStagedChanges = await this.git.hasChanges(worktreePath, true);
		if (hasStagedChanges) {
			await this.git.run("git", ["commit", "-m", message ?? `Yolomatic: Changes for branch ${branchName}`], {
				cwd: worktreePath,
			});
		}

		if (!hasStagedChanges && !(await this.git.branchHasCommitsAhead(worktreePath, baseBranch))) {
			return false;
		}

		try {
			await this.git.runAuthenticated(["push", "origin", branchName], { cwd: worktreePath });
		} catch (error) {
			if (!isNonFastForwardPushError(error)) {
				throw error;
			}
			// The worktree's view of origin/<branch> can lag behind the real remote
			// (e.g. when the worktree was created from a stale bare-repo ref), so a
			// plain push can be rejected as non-fast-forward even for Yolomatic's
			// own branch. Recover by leasing against the live remote head: when the
			// caller captured an expected head, use it; otherwise fetch the current
			// remote head now. The force-with-lease only overwrites the remote when
			// no concurrent push landed since that head was observed.
			const leaseHead = expectedRemoteHead ?? (await this.resolveRemoteHeadForLease(worktreePath, branchName));
			if (!leaseHead || !/^[0-9a-f]{40,64}$/iu.test(leaseHead)) {
				if (expectedRemoteHead) {
					throw new Error(`Cannot safely update ${branchName}: invalid expected remote head '${expectedRemoteHead}'.`);
				}
				throw error;
			}
			await this.git.runAuthenticated(
				[
					"push",
					`--force-with-lease=refs/heads/${branchName}:${leaseHead}`,
					"origin",
					branchName,
				],
				{ cwd: worktreePath },
			);
		}
		return true;
	}

	/**
	 * Resolve the live remote head for `origin/<branch>` from within a worktree
	 * so a non-fast-forward push can be retried with a safe `--force-with-lease`.
	 * Fetches the single branch ref from origin first, then reads the updated
	 * remote-tracking ref. Returns `null` when the head cannot be determined so
	 * callers can surface the original push error instead of blind-force-pushing.
	 */
	private async resolveRemoteHeadForLease(worktreePath: string, branchName: string): Promise<string | null> {
		try {
			await this.git.runAuthenticated(["fetch", "origin", branchName], { cwd: worktreePath });
		} catch {
			// Fall through to the remote-tracking ref, which may still be usable
			// even if the network fetch failed.
		}
		try {
			const { stdout } = await this.git.run("git", ["rev-parse", `origin/${branchName}`], { cwd: worktreePath });
			const sha = stdout.trim();
			return sha.length > 0 ? sha : null;
		} catch {
			return null;
		}
	}

	async createRefinementWorktree(owner: string, repo: string, issueNumber: number): Promise<string> {
		const normalizedOwner = normalizeSegment(owner, "owner");
		const normalizedRepo = normalizeSegment(repo, "repo");
		await mkdir(this.config.workspacesDir, { recursive: true });
		const bareRepoPath = await this.bareRepos.ensureBareRepo(normalizedOwner, normalizedRepo);
		const basePath = this.worktrees.getWorktreePath(normalizedOwner, normalizedRepo, issueNumber);
		const refinementPath = path.join(path.dirname(basePath), "refinement", `issue-${issueNumber}`);
		const branchName = `yolomatic/refinement-issue-${issueNumber}`;
		const defaultBranch = this.config.resolveDefaultBranch?.(normalizedOwner, normalizedRepo) ?? this.config.defaultBranch ?? "main";

		if (await this.worktrees.worktreeExists(bareRepoPath, refinementPath)) {
			await this.worktrees.removeWorktreeByPath(bareRepoPath, refinementPath);
		}

		await this.bareRepos.fetchOrigin(bareRepoPath);
		const baseRef = `origin/${defaultBranch}`;
		await this.git.run("git", ["worktree", "add", "-B", branchName, refinementPath, baseRef], { cwd: bareRepoPath }).catch(async () => {
			await this.git.run("git", ["worktree", "add", "-B", branchName, refinementPath, defaultBranch], { cwd: bareRepoPath }).catch(async () => {
				await this.git.run("git", ["worktree", "add", refinementPath, defaultBranch], { cwd: bareRepoPath });
			});
		});

		const sanitizedUrl = `https://github.com/${normalizedOwner}/${normalizedRepo}.git`;
		await this.git.run("git", ["remote", "set-url", "origin", sanitizedUrl], { cwd: refinementPath }).catch(() => undefined);
		return refinementPath;
	}

	async removeRefinementWorktree(worktreePath: string): Promise<void> {
		const bareRepoPath = path.dirname(path.dirname(path.dirname(worktreePath)));
		await this.worktrees.removeWorktreeByPath(bareRepoPath, worktreePath);
	}

	async commitAndPush(owner: string, repo: string, issueNumber: number, message?: string): Promise<boolean> {
		const worktreePath = this.getWorktreePath(owner, repo, issueNumber);
		const branchName = this.getBranchName(issueNumber);
		return this.commitAndPushPath(worktreePath, branchName, message ?? `Yolomatic: Changes for issue #${issueNumber}`);
	}

	async hasChanges(workspacePath: string, cached = false): Promise<boolean> {
		return this.git.hasChanges(workspacePath, cached);
	}

	async getGitStatus(owner: string, repo: string, issueNumber: number): Promise<string> {
		const worktreePath = this.getWorktreePath(owner, repo, issueNumber);
		return this.git.getGitStatus(worktreePath);
	}

	async getGitDiff(owner: string, repo: string, issueNumber: number): Promise<string> {
		const worktreePath = this.getWorktreePath(owner, repo, issueNumber);
		return this.git.getGitDiff(worktreePath);
	}
}
