import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { WorkspaceConfig } from "./config.js";
import { BareRepoManager } from "./bare-repo.js";
import { type CommandRunner, GitCommandRunner } from "./git-runner.js";
import { WorktreeManager } from "./worktree.js";

function createConfig(workspacesDir: string): WorkspaceConfig {
	return {
		workspacesDir,
		githubUsername: "mbrooks",
		githubToken: "secret",
		defaultBranch: "main",
		maxWorktrees: 1,
		evictionStrategy: "fifo",
	};
}

describe("WorktreeManager", () => {
	it("force-removes an evicted worktree when normal removal fails", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-worktree-force-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const existingWorktreePath = path.join(bareRepoPath, ".worktrees", "issue-1");
		const newWorktreePath = path.join(bareRepoPath, ".worktrees", "issue-2");

		await mkdir(existingWorktreePath, { recursive: true });

		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return {
					stdout: `worktree ${existingWorktreePath}\nHEAD abcd1234\n`,
					stderr: "",
				};
			}
			if (args[0] === "status" && args[1] === "--porcelain") {
				return { stdout: "M file.txt\n", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "remove" && args[2] !== "--force") {
				throw new Error("remove failed");
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = {
			ensureBareRepo: vi.fn(async () => bareRepoPath),
			branchExists: vi.fn(async () => false),
			updateDefaultBranch: vi.fn(async () => {}),
			resolveBaseRef: vi.fn(async () => "origin/HEAD"),
			getBareRepoPath: vi.fn(() => bareRepoPath),
		} as unknown as BareRepoManager;
		const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const worktree = await worktrees.createOrGetWorktree("mbrooks", "tars", 2);

		expect(worktree.path).toBe(newWorktreePath);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["worktree", "remove", "--force", existingWorktreePath],
			{ cwd: bareRepoPath },
		);
		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Uncommitted changes: stashed"));

		writeSpy.mockRestore();
	});

	it("skips removal when the requested worktree is not registered", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-worktree-missing-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				throw new Error("list failed");
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = {
			getBareRepoPath: vi.fn(() => bareRepoPath),
		} as unknown as BareRepoManager;
		const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

		await worktrees.removeWorktree("mbrooks", "tars", 42);

		const removeCalls = (runCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
			([command, args]) => command === "git" && args[0] === "worktree" && args[1] === "remove",
		);
		expect(removeCalls).toHaveLength(0);
	});
});
