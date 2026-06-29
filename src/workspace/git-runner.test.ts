import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { WorkspaceConfig } from "./config.js";
import { type CommandRunner, GitCommandRunner } from "./git-runner.js";

function createConfig(workspacesDir: string): WorkspaceConfig {
	return {
		workspacesDir,
		githubUsername: "mbrooks",
		githubToken: "secret",
		defaultBranch: "main",
	};
}

describe("GitCommandRunner", () => {
	it("configures git identity from workspace config", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-git-runner-"));
		const runCommand: CommandRunner = vi.fn(async () => ({ stdout: "", stderr: "" }));
		const git = new GitCommandRunner(createConfig(root), runCommand);

		await git.ensureGitIdentity("/tmp/worktree");

		expect(runCommand).toHaveBeenCalledWith("git", ["config", "user.name", "TARS"], { cwd: "/tmp/worktree" });
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["config", "user.email", "mbrooks@users.noreply.github.com"],
			{ cwd: "/tmp/worktree" },
		);
	});

	it("checks commit distance against the configured default branch", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-git-ahead-"));
		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "rev-list") {
				return { stdout: "2\n", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner({ ...createConfig(root), defaultBranch: "develop" }, runCommand);

		await expect(git.branchHasCommitsAhead("/tmp/worktree")).resolves.toBe(true);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["rev-list", "--count", "origin/develop..HEAD"],
			{ cwd: "/tmp/worktree" },
		);
	});

	it("detects staged changes and falls back safely for status helpers", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-git-status-"));
		let diffCalls = 0;
		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "diff" && args[1] === "--quiet") {
				diffCalls += 1;
				if (diffCalls === 1) {
					throw new Error("dirty");
				}
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "diff") {
				return { stdout: "patch", stderr: "" };
			}
			if (args[0] === "status") {
				if (args.includes("--porcelain")) {
					throw new Error("status failed");
				}
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);

		await expect(git.hasChanges("/tmp/worktree")).resolves.toBe(true);
		await expect(git.hasAnyChanges("/tmp/worktree")).resolves.toBe(true);
		await expect(git.getGitStatus("/tmp/worktree")).resolves.toBe("(failed to get git status)");
		await expect(git.getGitDiff("/tmp/worktree")).resolves.toBe("patch");
	});

	it("returns clean results when workspace state commands succeed", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-git-clean-"));
		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "status") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "diff" && args[1]) {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "diff") {
				return { stdout: "diff --git a/file b/file\n", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);

		await expect(git.hasChanges("/tmp/worktree", true)).resolves.toBe(false);
		await expect(git.hasAnyChanges("/tmp/worktree")).resolves.toBe(false);
		await expect(git.getGitDiff("/tmp/worktree")).resolves.toBe("diff --git a/file b/file\n");
	});
});
