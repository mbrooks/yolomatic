import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { WorkspaceConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface Workspace {
	owner: string;
	repo: string;
	path: string;
	branch: string;
	lastCheckout: Date;
}

export interface CommandRunner {
	(
		command: string,
		args: string[],
		options?: {
			cwd?: string;
		},
	): Promise<void>;
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
	private readonly workspaces = new Map<string, Workspace>();

	public constructor(
		private readonly config: WorkspaceConfig,
		private readonly runCommand: CommandRunner = async (command, args, options) => {
			await execFileAsync(command, args, {
				cwd: options?.cwd,
				env: process.env,
			});
		},
	) {}

	getWorkspaceKey(owner: string, repo: string): string {
		return `${normalizeSegment(owner, "owner")}-${normalizeSegment(repo, "repo")}`.toLowerCase();
	}

	getWorkspacePath(owner: string, repo: string): string {
		return path.join(this.config.workspacesDir, this.getWorkspaceKey(owner, repo));
	}

	async ensureWorkspace(owner: string, repo: string, branch = this.config.defaultBranch): Promise<Workspace> {
		const normalizedOwner = normalizeSegment(owner, "owner");
		const normalizedRepo = normalizeSegment(repo, "repo");
		const key = this.getWorkspaceKey(normalizedOwner, normalizedRepo);
		const workspacePath = this.getWorkspacePath(normalizedOwner, normalizedRepo);

		await mkdir(this.config.workspacesDir, { recursive: true });

		if (await this.pathExists(workspacePath)) {
			await this.fetch(workspacePath);
		} else {
			await this.clone(normalizedOwner, normalizedRepo, workspacePath);
		}

		await this.checkoutBranch(workspacePath, branch);
		await this.pull(workspacePath, branch);

		const workspace: Workspace = {
			owner: normalizedOwner,
			repo: normalizedRepo,
			path: workspacePath,
			branch,
			lastCheckout: new Date(),
		};

		this.workspaces.set(key, workspace);
		return workspace;
	}

	async getOrCreateBranch(owner: string, repo: string, issueNumber: number): Promise<string> {
		if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
			throw new Error(`Invalid issue number: ${issueNumber}`);
		}

		const workspace = await this.ensureWorkspace(owner, repo);
		const branchName = `tars/issue-${issueNumber}`;

		await this.runCommand("git", ["checkout", "-B", branchName], { cwd: workspace.path });

		const updatedWorkspace: Workspace = {
			...workspace,
			branch: branchName,
			lastCheckout: new Date(),
		};

		this.workspaces.set(this.getWorkspaceKey(owner, repo), updatedWorkspace);
		return branchName;
	}

	private async clone(owner: string, repo: string, workspacePath: string): Promise<void> {
		const encodedUsername = encodeURIComponent(this.config.githubUsername);
		const encodedToken = encodeURIComponent(this.config.githubToken);
		const url = `https://${encodedUsername}:${encodedToken}@github.com/${owner}/${repo}.git`;

		await this.runCommand("git", ["clone", url, workspacePath]);
	}

	private async fetch(workspacePath: string): Promise<void> {
		await this.runCommand("git", ["fetch", "--all", "--prune"], { cwd: workspacePath });
	}

	private async checkoutBranch(workspacePath: string, branch: string): Promise<void> {
		await this.runCommand("git", ["checkout", branch], { cwd: workspacePath });
	}

	private async pull(workspacePath: string, branch: string): Promise<void> {
		await this.runCommand("git", ["pull", "--ff-only", "origin", branch], { cwd: workspacePath });
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
