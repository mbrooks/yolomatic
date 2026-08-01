import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { WorkspaceConfig } from "./config.js";
import { BareRepoManager } from "./bare-repo.js";
import { WorktreeBranchDivergedError } from "./errors.js";
import { type CommandRunner, GitCommandRunner } from "./git-runner.js";
import { WorktreeManager } from "./worktree.js";

function createConfig(workspacesDir: string, overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
	return {
		workspacesDir,
		githubUsername: "mbrooks",
		githubToken: "secret",
		defaultBranch: "main",
		maxWorktrees: 1,
		evictionStrategy: "fifo",
		...overrides,
	};
}

function makeBareRepos(bareRepoPath: string, overrides: Partial<{
	ensureBareRepo: () => Promise<string>;
	branchExists: () => Promise<boolean>;
	updateDefaultBranch: () => Promise<void>;
	resolveBaseRef: () => Promise<string>;
	getBareRepoPath: () => string;
	fetchOrigin: () => Promise<void>;
	remoteBranchExists: () => Promise<boolean>;
}> = {}): BareRepoManager {
	return {
		ensureBareRepo: vi.fn(async () => bareRepoPath),
		branchExists: vi.fn(async () => false),
		updateDefaultBranch: vi.fn(async () => {}),
		resolveBaseRef: vi.fn(async () => "origin/HEAD"),
		getBareRepoPath: vi.fn(() => bareRepoPath),
		fetchOrigin: vi.fn(async () => {}),
		remoteBranchExists: vi.fn(async () => false),
		...overrides,
	} as unknown as BareRepoManager;
}

describe("WorktreeManager", () => {
	it("force-removes an evicted worktree when normal removal fails", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worktree-force-"));
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
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worktree-missing-"));
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

	it("removes a clean worktree without stashing", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worktree-clean-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");

		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: `worktree ${worktreePath}\nHEAD abcd1234\n`, stderr: "" };
			}
			if (args[0] === "status" && args[1] === "--porcelain") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = { getBareRepoPath: vi.fn(() => bareRepoPath) } as unknown as BareRepoManager;
		const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await worktrees.removeWorktree("mbrooks", "tars", 42);

		expect(runCommand).toHaveBeenCalledWith("git", ["worktree", "remove", worktreePath], { cwd: bareRepoPath });

		const stashCalls = (runCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
			([command, args]) => command === "git" && args[0] === "stash",
		);
		expect(stashCalls).toHaveLength(0);

		const forceCalls = (runCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
			([command, args]) => command === "git" && args[0] === "worktree" && args[1] === "remove" && args[2] === "--force",
		);
		expect(forceCalls).toHaveLength(0);

		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Uncommitted changes: none"));
		writeSpy.mockRestore();
	});

	it("stashes changes before removing a dirty worktree", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worktree-dirty-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");

		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: `worktree ${worktreePath}\nHEAD abcd1234\n`, stderr: "" };
			}
			if (args[0] === "status" && args[1] === "--porcelain") {
				return { stdout: "M file.txt\n", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = { getBareRepoPath: vi.fn(() => bareRepoPath) } as unknown as BareRepoManager;
		const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await worktrees.removeWorktree("mbrooks", "tars", 42);

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["stash", "push", "-m", "Yeetomatic auto-stash before cleanup of issue-42", "-u"],
			{ cwd: worktreePath },
		);
		expect(runCommand).toHaveBeenCalledWith("git", ["worktree", "remove", worktreePath], { cwd: bareRepoPath });
		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Uncommitted changes: stashed"));
		writeSpy.mockRestore();
	});

	it("force-removes a worktree when normal removal fails during cleanup", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worktree-cleanup-force-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");

		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: `worktree ${worktreePath}\nHEAD abcd1234\n`, stderr: "" };
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
		const bareRepos = { getBareRepoPath: vi.fn(() => bareRepoPath) } as unknown as BareRepoManager;
		const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await worktrees.removeWorktree("mbrooks", "tars", 42);

		expect(runCommand).toHaveBeenCalledWith("git", ["worktree", "remove", "--force", worktreePath], {
			cwd: bareRepoPath,
		});
		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("force-removed"));
		writeSpy.mockRestore();
	});

	it("quarantines a worktree when force removal fails with permission denied", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worktree-quarantine-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");
		await mkdir(worktreePath, { recursive: true });

		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: `worktree ${worktreePath}\nHEAD abcd1234\n`, stderr: "" };
			}
			if (args[0] === "status" && args[1] === "--porcelain") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "remove") {
				throw new Error("EACCES: permission denied, unlink '/app/workspaces/mbrooks-tars/.worktrees/issue-42/coverage/base.css'");
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = { getBareRepoPath: vi.fn(() => bareRepoPath) } as unknown as BareRepoManager;
		const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await worktrees.removeWorktree("mbrooks", "tars", 42);

		expect(runCommand).toHaveBeenCalledWith("git", ["worktree", "remove", "--force", worktreePath], {
			cwd: bareRepoPath,
		});
		expect(runCommand).toHaveBeenCalledWith("git", ["worktree", "prune"], { cwd: bareRepoPath });
		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[workspace] Quarantined blocked worktree"));
		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("force-removed"));
		writeSpy.mockRestore();
	});

	it("returns the existing worktree without creating a new one", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worktree-exists-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");
		await mkdir(worktreePath, { recursive: true });

		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: `worktree ${worktreePath}\nHEAD abcd1234\n`, stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = makeBareRepos(bareRepoPath);
		const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

		const result = await worktrees.createOrGetWorktree("mbrooks", "tars", 42);

		expect(result.path).toBe(worktreePath);
		const addCalls = (runCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
			([command, args]) => command === "git" && args[0] === "worktree" && args[1] === "add",
		);
		expect(addCalls).toHaveLength(0);
	});

	it("reuses an existing branch when creating a worktree", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worktree-reuse-branch-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");

		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = makeBareRepos(bareRepoPath, {
			branchExists: vi.fn(async () => true),
		});
		const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

		await worktrees.createOrGetWorktree("mbrooks", "tars", 42);

		expect(runCommand).toHaveBeenCalledWith("git", ["branch", "-f", "yeetomatic/issue-42", "origin/HEAD"], {
			cwd: bareRepoPath,
		});
		expect(runCommand).toHaveBeenCalledWith("git", ["worktree", "add", "--force", worktreePath, "yeetomatic/issue-42"], {
			cwd: bareRepoPath,
		});
	});

	it("wraps worktree add failures with recovery guidance", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worktree-add-error-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");

		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "add") {
				throw new Error("already checked out");
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = makeBareRepos(bareRepoPath);
		const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

		await expect(worktrees.createOrGetWorktree("mbrooks", "tars", 42)).rejects.toThrow(/Cannot create worktree/);
	});

	it("evicts the least-recently-used worktree under lru eviction", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worktree-lru-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const olderPath = path.join(bareRepoPath, ".worktrees", "issue-1");
		const newerPath = path.join(bareRepoPath, ".worktrees", "issue-2");
		const targetPath = path.join(bareRepoPath, ".worktrees", "issue-3");
		await mkdir(olderPath, { recursive: true });
		await mkdir(newerPath, { recursive: true });

		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return {
					stdout:
						`worktree ${olderPath}\nbranch refs/heads/yeetomatic/issue-1\n` +
						`worktree ${newerPath}\nbranch refs/heads/yeetomatic/issue-2\n`,
					stderr: "",
				};
			}
			if (args[0] === "status" && args[1] === "--porcelain") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root, { evictionStrategy: "lru" }), runCommand);
		const bareRepos = makeBareRepos(bareRepoPath);
		const worktrees = new WorktreeManager(
			createConfig(root, { evictionStrategy: "lru" }),
			git,
			bareRepos,
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const worktree = await worktrees.createOrGetWorktree("mbrooks", "tars", 3);

		expect(worktree.path).toBe(targetPath);
		expect(runCommand).toHaveBeenCalledWith("git", ["worktree", "remove", olderPath], { cwd: bareRepoPath });
		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Strategy: lru"));
		writeSpy.mockRestore();
	});

	it("quarantines a permission-blocked eviction candidate and still creates the new worktree", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worktree-skip-blocked-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const blockedPath = path.join(bareRepoPath, ".worktrees", "issue-1");
		const removablePath = path.join(bareRepoPath, ".worktrees", "issue-2");
		const targetPath = path.join(bareRepoPath, ".worktrees", "issue-3");
		await mkdir(blockedPath, { recursive: true });
		await mkdir(removablePath, { recursive: true });

		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return {
					stdout:
						`worktree ${blockedPath}\nbranch refs/heads/yeetomatic/issue-1\n` +
						`worktree ${removablePath}\nbranch refs/heads/yeetomatic/issue-2\n`,
					stderr: "",
				};
			}
			if (args[0] === "status" && args[1] === "--porcelain") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "remove" && args[args.length - 1] === blockedPath) {
				throw new Error("EACCES: permission denied, unlink '/app/workspaces/mbrooks-tars/.worktrees/issue-1/coverage/base.css'");
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root, { maxWorktrees: 2, evictionStrategy: "fifo" }), runCommand);
		const bareRepos = makeBareRepos(bareRepoPath);
		const worktrees = new WorktreeManager(
			createConfig(root, { maxWorktrees: 2, evictionStrategy: "fifo" }),
			git,
			bareRepos,
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const worktree = await worktrees.createOrGetWorktree("mbrooks", "tars", 3);

		expect(worktree.path).toBe(targetPath);
		expect(runCommand).toHaveBeenCalledWith("git", ["worktree", "remove", blockedPath], { cwd: bareRepoPath });
		expect(runCommand).not.toHaveBeenCalledWith("git", ["worktree", "remove", removablePath], { cwd: bareRepoPath });
		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[workspace] Quarantined blocked worktree"));
		writeSpy.mockRestore();
	});

	it("uses default eviction strategy when config omits it", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worktree-defaults-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const existingPath = path.join(bareRepoPath, ".worktrees", "issue-1");
		await mkdir(existingPath, { recursive: true });

		const runCommand: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: `worktree ${existingPath}\nHEAD abcd\n`, stderr: "" };
			}
			if (args[0] === "status" && args[1] === "--porcelain") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const git = new GitCommandRunner(createConfig(root), runCommand);
		const bareRepos = makeBareRepos(bareRepoPath);
		const config = createConfig(root, { maxWorktrees: 1, evictionStrategy: undefined });
		delete (config as Partial<WorkspaceConfig>).evictionStrategy;
		const worktrees = new WorktreeManager(config, git, bareRepos);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await worktrees.createOrGetWorktree("mbrooks", "tars", 2);

		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Strategy: lru"));
		writeSpy.mockRestore();
	});

	describe("syncWorktree", () => {
		it("throws when the worktree has not been created yet", async () => {
			const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-sync-missing-"));
			const bareRepoPath = path.join(root, "mbrooks-tars");

			const runCommand: CommandRunner = vi.fn(async (_command, args) => {
				if (args[0] === "worktree" && args[1] === "list") {
					return { stdout: "", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			});
			const git = new GitCommandRunner(createConfig(root), runCommand);
			const bareRepos = makeBareRepos(bareRepoPath, {
				fetchOrigin: vi.fn(async () => {}),
				remoteBranchExists: vi.fn(async () => false),
			});
			const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

			await expect(worktrees.syncWorktree("mbrooks", "tars", 42)).rejects.toThrow("syncWorktree called before createOrGetWorktree");
			expect(bareRepos.fetchOrigin).not.toHaveBeenCalled();
		});

		it("fast-forwards the worktree branch to origin and sanitizes the remote URL", async () => {
			const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-sync-ff-"));
			const bareRepoPath = path.join(root, "mbrooks-tars");
			const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");
			await mkdir(worktreePath, { recursive: true });

			const calls: Array<{ cmd: string; args: string[] }> = [];
			const runCommand: CommandRunner = vi.fn(async (_command, args) => {
				calls.push({ cmd: _command, args });
				if (args[0] === "worktree" && args[1] === "list") {
					return { stdout: `worktree ${worktreePath}\nHEAD abcd1234\nbranch refs/heads/yeetomatic/issue-42\n`, stderr: "" };
				}
				if (args[0] === "status" && args[1] === "--porcelain") {
					return { stdout: "", stderr: "" };
				}
				if (args[0] === "merge" && args[1] === "--ff-only") {
					return { stdout: "Updating abcd1234..efgh5678\nFast-forward\n", stderr: "" };
				}
				if (args[0] === "remote" && args[1] === "set-url") {
					return { stdout: "", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			});
			const git = new GitCommandRunner(createConfig(root), runCommand);
			const bareRepos = makeBareRepos(bareRepoPath, {
				fetchOrigin: vi.fn(async () => {}),
				remoteBranchExists: vi.fn(async () => true),
			});
			const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

			await worktrees.syncWorktree("mbrooks", "tars", 42);

			expect(bareRepos.fetchOrigin).toHaveBeenCalledWith(bareRepoPath);
			expect(bareRepos.remoteBranchExists).toHaveBeenCalledWith(bareRepoPath, "yeetomatic/issue-42");
			expect(runCommand).toHaveBeenCalledWith("git", ["merge", "--ff-only", "origin/yeetomatic/issue-42"], { cwd: worktreePath });
			expect(runCommand).toHaveBeenCalledWith(
				"git",
				["remote", "set-url", "origin", "https://github.com/mbrooks/tars.git"],
				{ cwd: worktreePath },
			);
		});

		it("leaves a not-yet-pushed branch in place without merging", async () => {
			const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-sync-nopush-"));
			const bareRepoPath = path.join(root, "mbrooks-tars");
			const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");
			await mkdir(worktreePath, { recursive: true });

			const runCommand: CommandRunner = vi.fn(async (_command, args) => {
				if (args[0] === "worktree" && args[1] === "list") {
					return { stdout: `worktree ${worktreePath}\nHEAD abcd1234\n`, stderr: "" };
				}
				if (args[0] === "status" && args[1] === "--porcelain") {
					return { stdout: "", stderr: "" };
				}
				if (args[0] === "remote" && args[1] === "set-url") {
					return { stdout: "", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			});
			const git = new GitCommandRunner(createConfig(root), runCommand);
			const bareRepos = makeBareRepos(bareRepoPath, {
				fetchOrigin: vi.fn(async () => {}),
				remoteBranchExists: vi.fn(async () => false),
			});
			const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

			await worktrees.syncWorktree("mbrooks", "tars", 42);

			const mergeCalls = (runCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
				([, args]) => args[0] === "merge",
			);
			expect(mergeCalls).toHaveLength(0);
			expect(runCommand).toHaveBeenCalledWith(
				"git",
				["remote", "set-url", "origin", "https://github.com/mbrooks/tars.git"],
				{ cwd: worktreePath },
			);
		});

		it("raises WorktreeBranchDivergedError when ff-only merge fails", async () => {
			const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-sync-diverged-"));
			const bareRepoPath = path.join(root, "mbrooks-tars");
			const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");
			await mkdir(worktreePath, { recursive: true });

			const runCommand: CommandRunner = vi.fn(async (_command, args) => {
				if (args[0] === "worktree" && args[1] === "list") {
					return { stdout: `worktree ${worktreePath}\nHEAD abcd1234\n`, stderr: "" };
				}
				if (args[0] === "status" && args[1] === "--porcelain") {
					return { stdout: "", stderr: "" };
				}
				if (args[0] === "merge" && args[1] === "--ff-only") {
					throw new Error("Not possible to fast-forward, aborting.");
				}
				return { stdout: "", stderr: "" };
			});
			const git = new GitCommandRunner(createConfig(root), runCommand);
			const bareRepos = makeBareRepos(bareRepoPath, {
				fetchOrigin: vi.fn(async () => {}),
				remoteBranchExists: vi.fn(async () => true),
			});
			const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

			await expect(worktrees.syncWorktree("mbrooks", "tars", 42)).rejects.toBeInstanceOf(WorktreeBranchDivergedError);

			// Remote must NOT be sanitized when the worktree is diverged and un-launched.
			const setUrlCalls = (runCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
				([, args]) => args[0] === "remote" && args[1] === "set-url",
			);
			expect(setUrlCalls).toHaveLength(0);
		});

		it("stashes and restores a dirty worktree across sync", async () => {
			const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-sync-stash-"));
			const bareRepoPath = path.join(root, "mbrooks-tars");
			const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");
			await mkdir(worktreePath, { recursive: true });

			const runCommand: CommandRunner = vi.fn(async (_command, args) => {
				if (args[0] === "worktree" && args[1] === "list") {
					return { stdout: `worktree ${worktreePath}\nHEAD abcd1234\n`, stderr: "" };
				}
				if (args[0] === "status" && args[1] === "--porcelain") {
					return { stdout: "M file.txt\n", stderr: "" };
				}
				if (args[0] === "config") {
					return { stdout: "", stderr: "" };
				}
				if (args[0] === "stash" && args[1] === "push") {
					return { stdout: "", stderr: "" };
				}
				if (args[0] === "stash" && args[1] === "pop") {
					return { stdout: "", stderr: "" };
				}
				if (args[0] === "merge" && args[1] === "--ff-only") {
					return { stdout: "", stderr: "" };
				}
				if (args[0] === "remote" && args[1] === "set-url") {
					return { stdout: "", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			});
			const git = new GitCommandRunner(createConfig(root), runCommand);
			const bareRepos = makeBareRepos(bareRepoPath, {
				fetchOrigin: vi.fn(async () => {}),
				remoteBranchExists: vi.fn(async () => true),
			});
			const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

			await worktrees.syncWorktree("mbrooks", "tars", 42);

			expect(runCommand).toHaveBeenCalledWith(
				"git",
				["stash", "push", "-m", "Yeetomatic auto-stash before sync of issue-42", "-u"],
				{ cwd: worktreePath },
			);
			expect(runCommand).toHaveBeenCalledWith("git", ["stash", "pop"], { cwd: worktreePath });
		});

		it("fails when stash pop conflicts", async () => {
			const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-sync-stash-conflict-"));
			const bareRepoPath = path.join(root, "mbrooks-tars");
			const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");
			await mkdir(worktreePath, { recursive: true });

			const runCommand: CommandRunner = vi.fn(async (_command, args) => {
				if (args[0] === "worktree" && args[1] === "list") {
					return { stdout: `worktree ${worktreePath}\nHEAD abcd1234\n`, stderr: "" };
				}
				if (args[0] === "status" && args[1] === "--porcelain") {
					return { stdout: "M file.txt\n", stderr: "" };
				}
				if (args[0] === "config") {
					return { stdout: "", stderr: "" };
				}
				if (args[0] === "stash" && args[1] === "push") {
					return { stdout: "", stderr: "" };
				}
				if (args[0] === "stash" && args[1] === "pop") {
					throw new Error("CONFLICT (content): Merge conflict in file.txt");
				}
				if (args[0] === "merge" && args[1] === "--ff-only") {
					return { stdout: "", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			});
			const git = new GitCommandRunner(createConfig(root), runCommand);
			const bareRepos = makeBareRepos(bareRepoPath, {
				fetchOrigin: vi.fn(async () => {}),
				remoteBranchExists: vi.fn(async () => true),
			});
			const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

			await expect(worktrees.syncWorktree("mbrooks", "tars", 42)).rejects.toThrow("Could not restore stashed changes after sync");
		});

		it("fails when sanitizing the remote URL fails", async () => {
			const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-sync-sanitize-fail-"));
			const bareRepoPath = path.join(root, "mbrooks-tars");
			const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");
			await mkdir(worktreePath, { recursive: true });

			const runCommand: CommandRunner = vi.fn(async (_command, args) => {
				if (args[0] === "worktree" && args[1] === "list") {
					return { stdout: `worktree ${worktreePath}\nHEAD abcd1234\n`, stderr: "" };
				}
				if (args[0] === "status" && args[1] === "--porcelain") {
					return { stdout: "", stderr: "" };
				}
				if (args[0] === "remote" && args[1] === "set-url") {
					throw new Error("permission denied");
				}
				return { stdout: "", stderr: "" };
			});
			const git = new GitCommandRunner(createConfig(root), runCommand);
			const bareRepos = makeBareRepos(bareRepoPath, {
				fetchOrigin: vi.fn(async () => {}),
				remoteBranchExists: vi.fn(async () => false),
			});
			const worktrees = new WorktreeManager(createConfig(root), git, bareRepos);

			await expect(worktrees.syncWorktree("mbrooks", "tars", 42)).rejects.toThrow("Failed to sanitize remote.origin.url");
		});
	});
});
