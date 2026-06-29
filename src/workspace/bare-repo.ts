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

		if (await this.pathExists(bareRepoPath)) {
			const isValid = await this.isValidGitRepo(bareRepoPath);
			if (isValid) {
				await this.git.run("git", ["fetch", "--all", "--prune"], { cwd: bareRepoPath });
				return bareRepoPath;
			}
			await rm(bareRepoPath, { recursive: true, force: true });
		}

		const encodedUsername = encodeURIComponent(this.config.githubUsername);
		const encodedToken = encodeURIComponent(this.config.githubToken);
		const url = `https://${encodedUsername}:${encodedToken}@github.com/${owner}/${repo}.git`;

		await this.git.run("git", ["clone", "--bare", url, bareRepoPath]);
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
		await this.git.run("git", ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*", "--prune"], {
			cwd: bareRepoPath,
		});

		try {
			await this.git.run("git", ["remote", "set-head", "origin", "-a"], { cwd: bareRepoPath });
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
}
