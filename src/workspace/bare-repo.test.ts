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
		const root = await mkdtemp(path.join(os.tmpdir(), "yolomatic-bare-clone-"));
		const bareRepoPath = path.join(root, "mbrooks-yolomatic");
		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "clone") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = new BareRepoManager(createConfig(root), git);

		await expect(bareRepos.ensureBareRepo("mbrooks", "yolomatic")).resolves.toBe(bareRepoPath);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["clone", "--bare", "https://github.com/mbrooks/yolomatic.git", bareRepoPath],
			expect.objectContaining({ env: expect.any(Object) }),
		);
	});

	it("reclones when an existing path is not a valid git repository", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yolomatic-bare-invalid-"));
		const bareRepoPath = path.join(root, "mbrooks-yolomatic");
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

		await expect(bareRepos.ensureBareRepo("mbrooks", "yolomatic")).resolves.toBe(bareRepoPath);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["clone", "--bare", "https://github.com/mbrooks/yolomatic.git", bareRepoPath],
			expect.objectContaining({ env: expect.any(Object) }),
		);
	});

	it("reclones an existing bare repo when refresh hits a lock-permission error", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yolomatic-bare-refresh-"));
		const bareRepoPath = path.join(root, "mbrooks-yolomatic");
		await mkdir(bareRepoPath, { recursive: true });
		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "rev-parse" && args[1] === "--git-dir") {
				return { stdout: `${bareRepoPath}\n`, stderr: "" };
			}
			if (args.includes("fetch")) {
				throw new Error(
					"Command failed: git fetch origin +refs/heads/*:refs/remotes/origin/* --prune\n" +
						"error: cannot lock ref 'refs/remotes/origin/yolomatic/issue-427': Permission denied\n" +
						"error: could not remove reference refs/remotes/origin/yolomatic/issue-427",
				);
			}
			if (args[0] === "clone") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = new BareRepoManager(createConfig(root), git);

		await expect(bareRepos.ensureBareRepo("mbrooks", "yolomatic")).resolves.toBe(bareRepoPath);

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*", "--prune"],
			expect.objectContaining({ cwd: bareRepoPath, env: expect.any(Object) }),
		);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["clone", "--bare", "https://github.com/mbrooks/yolomatic.git", bareRepoPath],
			expect.objectContaining({ env: expect.any(Object) }),
		);
	});

	it("rethrows non-recoverable refresh failures for an existing bare repo", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yolomatic-bare-refresh-fail-"));
		const bareRepoPath = path.join(root, "mbrooks-yolomatic");
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

		await expect(bareRepos.ensureBareRepo("mbrooks", "yolomatic")).rejects.toThrow("repository 'origin' not found");
		expect(runCommand).not.toHaveBeenCalledWith(
			"git",
			expect.arrayContaining(["clone"]),
			expect.anything(),
		);
	});

	it("replaces legacy credential-bearing remotes before fetching", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yolomatic-bare-sanitize-"));
		const bareRepoPath = path.join(root, "mbrooks-yolomatic");
		await mkdir(bareRepoPath, { recursive: true });
		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "rev-parse" && args[1] === "--git-dir") {
				return { stdout: `${bareRepoPath}\n`, stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = new BareRepoManager(createConfig(root), git);

		await bareRepos.ensureBareRepo("mbrooks", "yolomatic");

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["remote", "set-url", "origin", "https://github.com/mbrooks/yolomatic.git"],
			{ cwd: bareRepoPath },
		);
		const remoteUpdateIndex = (runCommand as ReturnType<typeof vi.fn>).mock.calls.findIndex(
			(call) => call[1][0] === "remote" && call[1][1] === "set-url",
		);
		const fetchIndex = (runCommand as ReturnType<typeof vi.fn>).mock.calls.findIndex((call) => call[1][0] === "fetch");
		expect(remoteUpdateIndex).toBeLessThan(fetchIndex);
	});

	it("ignores remote set-head errors while updating the default branch", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yolomatic-bare-set-head-"));
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
		const root = await mkdtemp(path.join(os.tmpdir(), "yolomatic-bare-repo-"));
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
		const root = await mkdtemp(path.join(os.tmpdir(), "yolomatic-bare-empty-"));
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

	describe("updateLocalBranchToOrigin", () => {
		it("creates the local ref when it does not exist and reports updated=true", async () => {
			const root = await mkdtemp(path.join(os.tmpdir(), "yolomatic-bare-create-ref-"));
			const calls: Array<[string, string[]]> = [];
			const runCommand: CommandRunner = vi.fn(async (_command, args, options) => {
				calls.push(["git", args]);
				if (args[0] === "rev-parse" && args.includes("--verify")) {
					const ref = args[args.length - 1];
					if (ref === "refs/heads/main") {
						throw new Error("missing ref refs/heads/main");
					}
					if (ref === "origin/main") {
						return { stdout: "after1234\n", stderr: "" };
					}
				}
				if (args[0] === "rev-parse") {
					const ref = args[args.length - 1];
					if (ref === "origin/main") return { stdout: "after1234\n", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			});
			const git = new GitCommandRunner(createConfig(root), runCommand);
			const bareRepos = new BareRepoManager(createConfig(root), git);

			const result = await bareRepos.updateLocalBranchToOrigin("/tmp/bare", "main");

			expect(result).toEqual({
				branch: "main",
				before: null,
				after: "after1234",
				updated: true,
			});
			expect(runCommand).toHaveBeenCalledWith(
				"git",
				["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*", "--prune"],
				expect.objectContaining({ cwd: "/tmp/bare", env: expect.any(Object) }),
			);
			expect(runCommand).toHaveBeenCalledWith(
				"git",
				["branch", "-f", "main", "origin/main"],
				{ cwd: "/tmp/bare" },
			);
		});

		it("fast-forwards an existing local ref and reports updated=true", async () => {
			const root = await mkdtemp(path.join(os.tmpdir(), "yolomatic-bare-ff-"));
			const runCommand: CommandRunner = vi.fn(async (_command, args) => {
				if (args[0] === "rev-parse" && args.includes("--verify")) {
					return { stdout: "before5678\n", stderr: "" };
				}
				if (args[0] === "rev-parse") {
					return { stdout: "after1234\n", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			});
			const git = new GitCommandRunner(createConfig(root), runCommand);
			const bareRepos = new BareRepoManager(createConfig(root), git);

			const result = await bareRepos.updateLocalBranchToOrigin("/tmp/bare", "main");

			expect(result).toEqual({
				branch: "main",
				before: "before5678",
				after: "after1234",
				updated: true,
			});
			expect(runCommand).toHaveBeenCalledWith(
				"git",
				["branch", "-f", "main", "origin/main"],
				{ cwd: "/tmp/bare" },
			);
		});

		it("reports updated=false and skips the branch update when already up to date", async () => {
			const root = await mkdtemp(path.join(os.tmpdir(), "yolomatic-bare-noop-"));
			const runCommand: CommandRunner = vi.fn(async (_command, args) => {
				if (args[0] === "rev-parse") {
					return { stdout: "same1234\n", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			});
			const git = new GitCommandRunner(createConfig(root), runCommand);
			const bareRepos = new BareRepoManager(createConfig(root), git);

			const result = await bareRepos.updateLocalBranchToOrigin("/tmp/bare", "main");

			expect(result).toEqual({
				branch: "main",
				before: "same1234",
				after: "same1234",
				updated: false,
			});
			const branchCalls = (runCommand as ReturnType<typeof vi.fn>).mock.calls
				.filter(([cmd, args]) => cmd === "git" && args[0] === "branch")
				.filter(([_cmd, args]) => args[1] === "-f");
			expect(branchCalls).toHaveLength(0);
		});

		it("throws when origin branch does not exist and performs no ref mutation", async () => {
			const root = await mkdtemp(path.join(os.tmpdir(), "yolomatic-bare-missing-origin-"));
			const runCommand: CommandRunner = vi.fn(async (_command, args) => {
				if (args[0] === "rev-parse" && args.includes("--verify")) {
					const ref = args[args.length - 1];
					if (ref === "origin/main") {
						throw new Error("missing ref origin/main");
					}
					return { stdout: "before5678\n", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			});
			const git = new GitCommandRunner(createConfig(root), runCommand);
			const bareRepos = new BareRepoManager(createConfig(root), git);

			await expect(bareRepos.updateLocalBranchToOrigin("/tmp/bare", "main")).rejects.toThrow(
				"origin/main does not exist",
			);
			const branchCalls = (runCommand as ReturnType<typeof vi.fn>).mock.calls
				.filter(([cmd, args]) => cmd === "git" && args[0] === "branch")
				.filter(([_cmd, args]) => args[1] === "-f");
			expect(branchCalls).toHaveLength(0);
		});

		it("surfaces fetch failures as errors", async () => {
			const root = await mkdtemp(path.join(os.tmpdir(), "yolomatic-bare-fetch-fail-"));
			const runCommand: CommandRunner = vi.fn(async (_command, args) => {
				if (args[0] === "fetch") {
					throw new Error("fatal: could not read from remote");
				}
				return { stdout: "", stderr: "" };
			});
			const git = new GitCommandRunner(createConfig(root), runCommand);
			const bareRepos = new BareRepoManager(createConfig(root), git);

			await expect(bareRepos.updateLocalBranchToOrigin("/tmp/bare", "main")).rejects.toThrow(
				"could not read from remote",
			);
		});
	});
});
