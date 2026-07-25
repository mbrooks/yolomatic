import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { WorkspaceConfig } from "./config.js";
import { BareRepoManager } from "./bare-repo.js";
import { EmptyRepositoryError } from "./errors.js";
import { type CommandRunner, GitCommandRunner } from "./git-runner.js";

function createConfig(workspacesDir: string): WorkspaceConfig {
	return {
		workspacesDir,
		githubUsername: "mbrooks",
		githubToken: "secret",
		defaultBranch: "main",
	};
}

describe("BareRepoManager", () => {
	it("clones a bare repo when no cached repo exists", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-bare-clone-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "clone") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = new BareRepoManager(createConfig(root), git);

		await expect(bareRepos.ensureBareRepo("mbrooks", "tars")).resolves.toBe(bareRepoPath);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["clone", "--bare", "https://github.com/mbrooks/tars.git", bareRepoPath],
			expect.objectContaining({ env: expect.any(Object) }),
		);
	});

	it("reclones when an existing path is not a valid git repository", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-bare-invalid-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		await mkdir(bareRepoPath, { recursive: true });
		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "rev-parse" && args[1] === "--git-dir") {
				throw new Error("not a git repository");
			}
			if (args[0] === "clone") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = new BareRepoManager(createConfig(root), git);

		await expect(bareRepos.ensureBareRepo("mbrooks", "tars")).resolves.toBe(bareRepoPath);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["clone", "--bare", "https://github.com/mbrooks/tars.git", bareRepoPath],
			expect.objectContaining({ env: expect.any(Object) }),
		);
	});

	it("reclones an existing bare repo when refresh hits a lock-permission error", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-bare-refresh-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		await mkdir(bareRepoPath, { recursive: true });
		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "rev-parse" && args[1] === "--git-dir") {
				return { stdout: `${bareRepoPath}\n`, stderr: "" };
			}
			if (args.includes("fetch")) {
				throw new Error(
					"Command failed: git fetch origin +refs/heads/*:refs/remotes/origin/* --prune\n" +
						"error: cannot lock ref 'refs/remotes/origin/tars/issue-427': Permission denied\n" +
						"error: could not remove reference refs/remotes/origin/tars/issue-427",
				);
			}
			if (args[0] === "clone") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = new BareRepoManager(createConfig(root), git);

		await expect(bareRepos.ensureBareRepo("mbrooks", "tars")).resolves.toBe(bareRepoPath);

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*", "--prune"],
			expect.objectContaining({ cwd: bareRepoPath, env: expect.any(Object) }),
		);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["clone", "--bare", "https://github.com/mbrooks/tars.git", bareRepoPath],
			expect.objectContaining({ env: expect.any(Object) }),
		);
	});

	it("rethrows non-recoverable refresh failures for an existing bare repo", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-bare-refresh-fail-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		await mkdir(bareRepoPath, { recursive: true });
		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "rev-parse" && args[1] === "--git-dir") {
				return { stdout: `${bareRepoPath}\n`, stderr: "" };
			}
			if (args[0] === "fetch") {
				throw new Error("fatal: repository 'origin' not found");
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = new BareRepoManager(createConfig(root), git);

		await expect(bareRepos.ensureBareRepo("mbrooks", "tars")).rejects.toThrow("repository 'origin' not found");
		expect(runCommand).not.toHaveBeenCalledWith(
			"git",
			expect.arrayContaining(["clone"]),
			expect.anything(),
		);
	});

	it("replaces legacy credential-bearing remotes before fetching", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-bare-sanitize-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		await mkdir(bareRepoPath, { recursive: true });
		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "rev-parse" && args[1] === "--git-dir") {
				return { stdout: `${bareRepoPath}\n`, stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = new BareRepoManager(createConfig(root), git);

		await bareRepos.ensureBareRepo("mbrooks", "tars");

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["remote", "set-url", "origin", "https://github.com/mbrooks/tars.git"],
			{ cwd: bareRepoPath },
		);
		const remoteUpdateIndex = (runCommand as ReturnType<typeof vi.fn>).mock.calls.findIndex(
			(call) => call[1][0] === "remote" && call[1][1] === "set-url",
		);
		const fetchIndex = (runCommand as ReturnType<typeof vi.fn>).mock.calls.findIndex((call) => call[1][0] === "fetch");
		expect(remoteUpdateIndex).toBeLessThan(fetchIndex);
	});

	it("ignores remote set-head errors while updating the default branch", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-bare-set-head-"));
		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "fetch") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "remote") {
				throw new Error("set-head failed");
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = new BareRepoManager(createConfig(root), git);

		await expect(bareRepos.updateDefaultBranch("/tmp/bare")).resolves.toBeUndefined();
	});

	it("resolves a single remote branch when origin HEAD is unavailable", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-bare-repo-"));
		const git = new GitCommandRunner(
			createConfig(root),
			vi.fn(async (_command, args) => {
				if (args[0] === "rev-parse") {
					const ref = args[2];
					if (ref === "origin/release") {
						return { stdout: "abcd1234\n", stderr: "" };
					}
					throw new Error(`missing ref ${ref}`);
				}
				if (args[0] === "branch" && args[1] === "-r") {
					return { stdout: "origin/HEAD\norigin/release\n", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			}) as CommandRunner,
		);
		const bareRepos = new BareRepoManager(createConfig(root), git);

		await expect(bareRepos.resolveBaseRef("/tmp/bare")).resolves.toBe("origin/release");
	});

	it("throws EmptyRepositoryError when no refs are available", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-bare-empty-"));
		const git = new GitCommandRunner(
			createConfig(root),
			vi.fn(async (_command, args) => {
				if (args[0] === "rev-parse") {
					throw new Error(`missing ref ${args[2]}`);
				}
				if (args[0] === "branch" && args[1] === "-r") {
					return { stdout: "", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			}) as CommandRunner,
		);
		const bareRepos = new BareRepoManager(createConfig(root), git);

		await expect(bareRepos.resolveBaseRef("/tmp/bare")).rejects.toThrow(EmptyRepositoryError);
	});
});
