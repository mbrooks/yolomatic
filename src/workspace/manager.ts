import type { WorkspaceConfig } from "./config.js";
import type { WorkspaceService } from "../ports/workspace-service.js";
import { mkdir } from "node:fs/promises";

import { BareRepoManager } from "./bare-repo.js";
import { type CommandRunner, createCommandRunner, GitCommandRunner } from "./git-runner.js";
import { getBareRepoPath, getBranchName, getRepoKey, getWorktreePath } from "./paths.js";
import { WorktreeManager } from "./worktree.js";

export type { CommandRunner } from "./git-runner.js";

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
	): Promise<boolean> {
		await this.git.ensureGitIdentity(worktreePath);
		await this.git.run("git", ["add", "-A"], { cwd: worktreePath });

		const hasStagedChanges = await this.git.hasChanges(worktreePath, true);
		if (hasStagedChanges) {
			await this.git.run("git", ["commit", "-m", message ?? `TARS: Changes for branch ${branchName}`], {
				cwd: worktreePath,
			});
		}

		if (!hasStagedChanges && !(await this.git.branchHasCommitsAhead(worktreePath, baseBranch))) {
			return false;
		}

		await this.git.runAuthenticated(["push", "origin", branchName], { cwd: worktreePath });
		return true;
	}

	async commitAndPush(owner: string, repo: string, issueNumber: number, message?: string): Promise<boolean> {
		const worktreePath = this.getWorktreePath(owner, repo, issueNumber);
		const branchName = this.getBranchName(issueNumber);
		return this.commitAndPushPath(worktreePath, branchName, message ?? `TARS: Changes for issue #${issueNumber}`);
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
