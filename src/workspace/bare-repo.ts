import { rm, stat } from "node:fs/promises";

import type { WorkspaceConfig } from "./config.js";
import { EmptyRepositoryError } from "./errors.js";
import { GitCommandRunner } from "./git-runner.js";
import { getBareRepoPath } from "./paths.js";

export class BareRepoManager {
	public constructor(
		private readonly config: WorkspaceConfig,
		private readonly git: GitCommandRunner,
	) {}

	getBareRepoPath(owner: string, repo: string): string {
		return getBareRepoPath(this.config.workspacesDir, owner, repo);
	}

	async ensureBareRepo(owner: string, repo: string): Promise<string> {
		const bareRepoPath = this.getBareRepoPath(owner, repo);
		const remoteUrl = this.buildRemoteUrl(owner, repo);

		if (await this.pathExists(bareRepoPath)) {
			const isValid = await this.isValidGitRepo(bareRepoPath);
			if (isValid) {
				try {
					await this.git.run("git", ["remote", "set-url", "origin", remoteUrl], { cwd: bareRepoPath });
					await this.updateDefaultBranch(bareRepoPath);
					return bareRepoPath;
				} catch (error) {
					if (!this.isRecoverableRefreshError(error)) {
						throw error;
					}
					await rm(bareRepoPath, { recursive: true, force: true });
				}
			}
			else {
				await rm(bareRepoPath, { recursive: true, force: true });
			}
		}

		await this.git.runAuthenticated(["clone", "--bare", remoteUrl, bareRepoPath]);
		return bareRepoPath;
	}

	async branchExists(bareRepoPath: string, branchName: string): Promise<boolean> {
		try {
			await this.git.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
				cwd: bareRepoPath,
			});
			return true;
		} catch {
			return false;
		}
	}

	async updateDefaultBranch(bareRepoPath: string): Promise<void> {
		await this.git.runAuthenticated(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*", "--prune"], {
			cwd: bareRepoPath,
		});

		try {
			await this.git.runAuthenticated(["remote", "set-head", "origin", "-a"], { cwd: bareRepoPath });
		} catch {
			// Some repositories or older bare clones may not have enough remote
			// metadata for origin/HEAD. resolveBaseRef() has fallbacks.
		}
	}

	async resolveBaseRef(bareRepoPath: string): Promise<string> {
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
			const { stdout } = await this.git.run("git", ["branch", "-r", "--format=%(refname:short)"], {
				cwd: bareRepoPath,
			});
			const remoteBranches = stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "" && line !== "origin/HEAD");

			if (remoteBranches.length === 1 && (await this.refExists(bareRepoPath, remoteBranches[0]))) {
				return remoteBranches[0];
			}
		} catch {
			// Fall through to diagnostic error below.
		}

		throw new EmptyRepositoryError(bareRepoPath);
	}

	private async isValidGitRepo(bareRepoPath: string): Promise<boolean> {
		try {
			await this.git.run("git", ["rev-parse", "--git-dir"], { cwd: bareRepoPath });
			return true;
		} catch {
			return false;
		}
	}

	private async refExists(bareRepoPath: string, ref: string): Promise<boolean> {
		try {
			await this.git.run("git", ["rev-parse", "--verify", ref], { cwd: bareRepoPath });
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

	private isRecoverableRefreshError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		return (
			message.includes("cannot lock ref") ||
			message.includes("could not remove reference") ||
			message.includes("Permission denied")
		);
	}

	private buildRemoteUrl(owner: string, repo: string): string {
		return `https://github.com/${owner}/${repo}.git`;
	}
}
