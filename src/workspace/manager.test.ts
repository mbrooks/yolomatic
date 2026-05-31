import { mkdtemp, mkdir, utimes, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { WorkspaceConfig } from "./config.js";
import { generateCommitMessage } from "./commit-message.js";
import type { CommandRunner } from "./manager.js";
import { WorkspaceManager } from "./manager.js";
import { EmptyRepositoryError } from "./errors.js";

function createConfig(workspacesDir: string): WorkspaceConfig {
	return {
		workspacesDir,
		githubUsername: "mbrooks",
		githubToken: "secret",
		defaultBranch: "main",
	};
}

describe("WorkspaceManager", () => {
	it("builds lowercase owner-repo keys and paths", () => {
		const manager = new WorkspaceManager(createConfig("/tmp/workspaces"), vi.fn());

		expect(manager.getRepoKey("MBrooks", "CaseBot")).toBe("mbrooks-casebot");
		expect(manager.getBareRepoPath("MBrooks", "CaseBot")).toBe(path.join("/tmp/workspaces", "mbrooks-casebot"));
		expect(manager.getWorktreePath("MBrooks", "CaseBot", 42)).toBe(
			path.join("/tmp/workspaces", "mbrooks-casebot", ".worktrees", "issue-42"),
		);
		expect(manager.getBranchName(42)).toBe("tars/issue-42");
	});

	it("creates worktree by cloning bare repo and adding worktree", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-worktree-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "rev-parse") {
				return { stdout: "abcd1234\n", stderr: "" };
			}
			if (args[0] === "show-ref") {
				const error = new Error("not found") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		const worktree = await manager.createOrGetWorktree("mbrooks", "tars", 42);

		expect(worktree.branch).toBe("tars/issue-42");
		expect(worktree.path).toBe(path.join(bareRepoPath, ".worktrees", "issue-42"));

		const cloneCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([cmd, args]) => cmd === "git" && args[0] === "clone",
		);
		expect(cloneCalls).toHaveLength(1);
		expect(cloneCalls[0][1]).toContain("--bare");
		expect(cloneCalls[0][1]).toContain(bareRepoPath);
		expect(cloneCalls[0][1].some((arg) => arg.includes("github.com"))).toBe(true);

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["worktree", "add", worktree.path, "-b", "tars/issue-42", "origin/HEAD"],
			{ cwd: bareRepoPath },
		);
	});

	it("fetches existing bare repo instead of cloning when directory is valid", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-valid-bare-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");

		await mkdir(bareRepoPath, { recursive: true });

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "rev-parse" && args[1] === "--git-dir") {
				return { stdout: ".\n", stderr: "" };
			}
			if (args[0] === "rev-parse") {
				return { stdout: "abcd1234\n", stderr: "" };
			}
			if (args[0] === "show-ref") {
				const error = new Error("not found") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		const worktree = await manager.createOrGetWorktree("mbrooks", "tars", 42);

		expect(worktree.branch).toBe("tars/issue-42");

		const fetchCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([cmd, args]) => cmd === "git" && args[0] === "fetch" && args[1] === "--all",
		);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0][1]).toContain("--prune");

		const cloneCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([cmd, args]) => cmd === "git" && args[0] === "clone",
		);
		expect(cloneCalls).toHaveLength(0);
	});

	it("re-clones when bare repo directory exists but is not a valid git repository", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-corrupted-bare-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");

		await mkdir(bareRepoPath, { recursive: true });

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "rev-parse" && args[1] === "--git-dir") {
				throw new Error("fatal: not a git repository");
			}
			if (args[0] === "rev-parse") {
				return { stdout: "abcd1234\n", stderr: "" };
			}
			if (args[0] === "show-ref") {
				const error = new Error("not found") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		const worktree = await manager.createOrGetWorktree("mbrooks", "tars", 42);

		expect(worktree.branch).toBe("tars/issue-42");

		const cloneCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([cmd, args]) => cmd === "git" && args[0] === "clone",
		);
		expect(cloneCalls).toHaveLength(1);
		expect(cloneCalls[0][1]).toContain("--bare");
		expect(cloneCalls[0][1]).toContain(bareRepoPath);

		// Verify the corrupted directory was removed
		await expect(stat(bareRepoPath)).rejects.toThrow();
	});

	it("returns existing worktree if already created", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-worktree-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");

		let worktreeCreated = false;
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "rev-parse") {
				return { stdout: "abcd1234\n", stderr: "" };
			}
			if (args[0] === "show-ref") {
				const error = new Error("not found") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			if (args[0] === "worktree" && args[1] === "list") {
				return {
					stdout: worktreeCreated
						? `worktree ${worktreePath}\nHEAD abcd1234\nbranch refs/heads/tars/issue-42\n`
						: "",
					stderr: "",
				};
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "add") {
				worktreeCreated = true;
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		// First call creates the worktree
		const worktree1 = await manager.createOrGetWorktree("mbrooks", "tars", 42);
		expect(worktree1.path).toBe(worktreePath);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["worktree", "add", worktreePath, "-b", "tars/issue-42", "origin/HEAD"],
			{ cwd: bareRepoPath },
		);

		// Second call returns existing
		const worktree2 = await manager.createOrGetWorktree("mbrooks", "tars", 42);
		expect(worktree2.path).toBe(worktreePath);
		expect(worktree2.branch).toBe("tars/issue-42");

		// Should not call worktree add again
		const worktreeAddCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([_cmd, args]) => args[0] === "worktree" && args[1] === "add",
		);
		expect(worktreeAddCalls).toHaveLength(1);
	});

	it("creates worktree from existing branch if branch already exists", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-existing-branch-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "rev-parse") {
				return { stdout: "abcd1234\n", stderr: "" };
			}
			if (args[0] === "show-ref") {
				return { stdout: "abcd1234 refs/heads/tars/issue-42", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		const worktree = await manager.createOrGetWorktree("mbrooks", "tars", 42);

		expect(worktree.branch).toBe("tars/issue-42");
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["branch", "-f", "tars/issue-42", "origin/HEAD"],
			{ cwd: bareRepoPath },
		);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["worktree", "add", "--force", worktreePath, "tars/issue-42"],
			{ cwd: bareRepoPath },
		);
	});

	it("commits and pushes from worktree", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-commit-"));
		const worktreePath = path.join(root, "mbrooks-tars", ".worktrees", "issue-42");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
				const error = new Error("changes exist") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		expect(await manager.commitAndPush("mbrooks", "tars", 42)).toBe(true);

		expect(runCommand).toHaveBeenCalledWith("git", ["config", "user.name", "TARS"], { cwd: worktreePath });
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["config", "user.email", "mbrooks@users.noreply.github.com"],
			{ cwd: worktreePath },
		);
		expect(runCommand).toHaveBeenCalledWith("git", ["add", "-A"], { cwd: worktreePath });
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["commit", "-m", "TARS: Changes for issue #42"],
			{ cwd: worktreePath },
		);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["push", "origin", "tars/issue-42"],
			{ cwd: worktreePath },
		);
	});

	it("commits and pushes from a custom worktree path", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-commit-path-"));
		const worktreePath = path.join(root, "custom-worktree");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
				const error = new Error("changes exist") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		expect(
			await manager.commitAndPushPath(worktreePath, "tars/cron-test", "chore: Update deps", "main"),
		).toBe(true);

		expect(runCommand).toHaveBeenCalledWith("git", ["config", "user.name", "TARS"], { cwd: worktreePath });
		expect(runCommand).toHaveBeenCalledWith("git", ["add", "-A"], { cwd: worktreePath });
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["commit", "-m", "chore: Update deps"],
			{ cwd: worktreePath },
		);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["push", "origin", "tars/cron-test"],
			{ cwd: worktreePath },
		);
	});

	it("uses default branch for commitAndPushPath when baseBranch is omitted", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-default-base-"));
		const worktreePath = path.join(root, "custom-worktree");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "rev-list" && args[1] === "--count") {
				return { stdout: "2\n", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(
			{ ...createConfig(root), defaultBranch: "develop" },
			runCommand,
		);

		expect(await manager.commitAndPushPath(worktreePath, "branch", "msg")).toBe(true);

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["rev-list", "--count", "origin/develop..HEAD"],
			{ cwd: worktreePath },
		);
	});

	it("uses provided baseBranch for commitAndPushPath", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-custom-base-"));
		const worktreePath = path.join(root, "custom-worktree");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "rev-list" && args[1] === "--count") {
				return { stdout: "1\n", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		expect(await manager.commitAndPushPath(worktreePath, "branch", "msg", "release")).toBe(true);

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["rev-list", "--count", "origin/release..HEAD"],
			{ cwd: worktreePath },
		);
	});

	it("returns false when commitAndPushPath has no changes and no commits ahead", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-path-no-changes-"));
		const worktreePath = path.join(root, "custom-worktree");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "rev-list" && args[1] === "--count") {
				return { stdout: "0\n", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		expect(await manager.commitAndPushPath(worktreePath, "branch")).toBe(false);
	});

	it("returns false when there are no changes and no commits ahead of base", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-no-changes-no-commits-"));
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "rev-list" && args[1] === "--count") {
				return { stdout: "0\n", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		expect(await manager.commitAndPush("mbrooks", "tars", 42)).toBe(false);
	});

	it("pushes when there are no new changes but commits already exist on branch", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-existing-commits-"));
		const worktreePath = path.join(root, "mbrooks-tars", ".worktrees", "issue-42");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "rev-list" && args[1] === "--count") {
				return { stdout: "3\n", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		expect(await manager.commitAndPush("mbrooks", "tars", 42)).toBe(true);

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["push", "origin", "tars/issue-42"],
			{ cwd: worktreePath },
		);
	});

	it("throws when push fails", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-push-fails-"));
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
				const error = new Error("changes exist") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			if (args[0] === "push") {
				throw new Error("fatal: Authentication failed");
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		await expect(manager.commitAndPush("mbrooks", "tars", 42)).rejects.toThrow("Authentication failed");
	});

	it("commits with a custom message when provided", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-commit-msg-"));
		const worktreePath = path.join(root, "mbrooks-tars", ".worktrees", "issue-42");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
				const error = new Error("changes exist") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		expect(await manager.commitAndPush("mbrooks", "tars", 42, "feat: Add widget support")).toBe(true);

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["commit", "-m", "feat: Add widget support"],
			{ cwd: worktreePath },
		);
	});

	it("removes worktree if it exists", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-remove-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return {
					stdout: `worktree ${worktreePath}\nHEAD abcd1234\nbranch refs/heads/tars/issue-42\n`,
					stderr: "",
				};
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		await manager.removeWorktree("mbrooks", "tars", 42);

		expect(runCommand).toHaveBeenCalledWith("git", ["worktree", "remove", worktreePath], {
			cwd: bareRepoPath,
		});
	});

	it("prunes stale worktrees before adding new worktree", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-prune-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "rev-parse") {
				return { stdout: "abcd1234\n", stderr: "" };
			}
			if (args[0] === "show-ref") {
				const error = new Error("not found") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		await manager.createOrGetWorktree("mbrooks", "tars", 42);

		// Verify prune and fetch are called before add
		const calls = (runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>;
		const pruneIndex = calls.findIndex(([cmd, args]) => cmd === "git" && args[0] === "worktree" && args[1] === "prune");
		const fetchIndex = calls.findIndex(([cmd, args]) => cmd === "git" && args[0] === "fetch" && args[1] === "origin");
		const addIndex = calls.findIndex(([cmd, args]) => cmd === "git" && args[0] === "worktree" && args[1] === "add");
		expect(pruneIndex).toBeGreaterThanOrEqual(0);
		expect(fetchIndex).toBeGreaterThanOrEqual(0);
		expect(addIndex).toBeGreaterThanOrEqual(0);
		expect(pruneIndex).toBeLessThan(addIndex);
		expect(fetchIndex).toBeLessThan(addIndex);
	});

	it("throws diagnostic error when worktree add fails", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-worktree-error-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "rev-parse") {
				return { stdout: "abcd1234\n", stderr: "" };
			}
			if (args[0] === "show-ref") {
				return { stdout: "abcd1234 refs/heads/tars/issue-42", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "add") {
				throw new Error("fatal: 'tars/issue-42' is already used by worktree");
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		await expect(manager.createOrGetWorktree("mbrooks", "tars", 42)).rejects.toThrow(
			"[workspace] ERROR: Cannot create worktree for tars/issue-42",
		);
		await expect(manager.createOrGetWorktree("mbrooks", "tars", 42)).rejects.toThrow(
			"git worktree prune",
		);
	});

	it("updates the default branch before creating a new worktree", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-fetch-default-branch-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "show-ref") {
				const error = new Error("not found") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(
			{ workspacesDir: root, githubUsername: "mbrooks", githubToken: "secret", defaultBranch: "master" },
			runCommand,
		);

		await manager.createOrGetWorktree("mbrooks", "tars", 42);

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*", "--prune"],
			{ cwd: bareRepoPath },
		);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["worktree", "add", worktreePath, "-b", "tars/issue-42", "origin/HEAD"],
			{ cwd: bareRepoPath },
		);
	});

	it("falls back to bare HEAD when remote refs are unavailable", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-bare-head-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "rev-parse") {
				const ref = args[2];
				if (ref === "HEAD") {
					return { stdout: "abcd1234\n", stderr: "" };
				}
				const error = new Error(`fatal: Needed a single revision: ${ref}`) as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			if (args[0] === "show-ref") {
				const error = new Error("not found") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "branch" && args[1] === "-r") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		await manager.createOrGetWorktree("mbrooks", "tars", 42);

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["worktree", "add", worktreePath, "-b", "tars/issue-42", "HEAD"],
			{ cwd: bareRepoPath },
		);
	});

	it("throws EmptyRepositoryError when no refs exist at all", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-empty-repo-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "rev-parse") {
				const error = new Error(`fatal: Needed a single revision: ${args[2]}`) as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			if (args[0] === "show-ref") {
				const error = new Error("not found") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "branch" && args[1] === "-r") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		await expect(manager.createOrGetWorktree("mbrooks", "tars", 42)).rejects.toThrow(EmptyRepositoryError);
		await expect(manager.createOrGetWorktree("mbrooks", "tars", 42)).rejects.toThrow(
			"The repository appears to be empty",
		);
	});

	it("does nothing when removing a non-existent worktree", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-remove-missing-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-99");

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		await manager.removeWorktree("mbrooks", "tars", 99);
		// git worktree remove should NOT be called
		const removeCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([_cmd, args]) => args[0] === "worktree" && args[1] === "remove",
		);
		expect(removeCalls).toHaveLength(0);
	});

	it("detects no changes when git diff exits cleanly", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-no-changes-"));
		const runCommand: CommandRunner = vi.fn(async () => ({ stdout: "", stderr: "" }));
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		const hasChanges = await manager.hasChanges(root);
		expect(hasChanges).toBe(false);
		expect(runCommand).toHaveBeenCalledWith("git", ["diff", "--quiet"], { cwd: root });
	});

	it("detects no cached changes when git diff --cached exits cleanly", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-no-cached-"));
		const runCommand: CommandRunner = vi.fn(async () => ({ stdout: "", stderr: "" }));
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		const hasChanges = await manager.hasChanges(root, true);
		expect(hasChanges).toBe(false);
		expect(runCommand).toHaveBeenCalledWith("git", ["diff", "--cached", "--quiet"], { cwd: root });
	});

	it("evicts oldest worktree when limit is reached with FIFO", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-fifo-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktree1 = path.join(bareRepoPath, ".worktrees", "issue-1");
		const worktree2 = path.join(bareRepoPath, ".worktrees", "issue-2");

		await mkdir(bareRepoPath, { recursive: true });
		await mkdir(worktree1, { recursive: true });
		await mkdir(worktree2, { recursive: true });

		const now = Date.now();
		await utimes(worktree1, new Date(now - 2000), new Date(now - 2000));
		await utimes(worktree2, new Date(now - 1000), new Date(now - 1000));

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
				return {
					stdout: [
						`worktree ${worktree1}`,
						"HEAD abcd1234",
						"branch refs/heads/tars/issue-1",
						"",
						`worktree ${worktree2}`,
						"HEAD abcd1234",
						"branch refs/heads/tars/issue-2",
						"",
					].join("\n"),
					stderr: "",
				};
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "fetch") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "rev-parse") {
				return { stdout: "abcd1234\n", stderr: "" };
			}
			if (args[0] === "show-ref") {
				const error = new Error("not found") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			if (args[0] === "worktree" && args[1] === "remove") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "add") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(
			{ ...createConfig(root), maxWorktrees: 2, evictionStrategy: "fifo" },
			runCommand,
		);

		await manager.createOrGetWorktree("mbrooks", "tars", 3);

		const removeCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([_cmd, args]) => args[0] === "worktree" && args[1] === "remove",
		);
		expect(removeCalls).toHaveLength(1);
		expect(removeCalls[0][1]).toContain(worktree1);
		expect(removeCalls[0][1]).not.toContain(worktree2);
	});

	it("evicts least recently used worktree with LRU", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-lru-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktree1 = path.join(bareRepoPath, ".worktrees", "issue-1");
		const worktree2 = path.join(bareRepoPath, ".worktrees", "issue-2");

		await mkdir(bareRepoPath, { recursive: true });
		await mkdir(worktree1, { recursive: true });
		await mkdir(worktree2, { recursive: true });

		const now = Date.now();
		await utimes(worktree1, new Date(now - 2000), new Date(now - 2000));
		await utimes(worktree2, new Date(now - 1000), new Date(now - 1000));

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
				return {
					stdout: [
						`worktree ${worktree1}`,
						"HEAD abcd1234",
						"branch refs/heads/tars/issue-1",
						"",
						`worktree ${worktree2}`,
						"HEAD abcd1234",
						"branch refs/heads/tars/issue-2",
						"",
					].join("\n"),
					stderr: "",
				};
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "fetch") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "rev-parse") {
				return { stdout: "abcd1234\n", stderr: "" };
			}
			if (args[0] === "show-ref") {
				const error = new Error("not found") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			if (args[0] === "worktree" && args[1] === "remove") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "add") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(
			{ ...createConfig(root), maxWorktrees: 2, evictionStrategy: "lru" },
			runCommand,
		);

		await manager.createOrGetWorktree("mbrooks", "tars", 3);

		const removeCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([_cmd, args]) => args[0] === "worktree" && args[1] === "remove",
		);
		expect(removeCalls).toHaveLength(1);
		expect(removeCalls[0][1]).toContain(worktree1);
		expect(removeCalls[0][1]).not.toContain(worktree2);
	});

	it("updates mtime of existing worktree when returned to track LRU", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-lru-touch-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktree1 = path.join(bareRepoPath, ".worktrees", "issue-1");

		await mkdir(bareRepoPath, { recursive: true });
		await mkdir(worktree1, { recursive: true });

		const beforeStat = await stat(worktree1);

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
				return {
					stdout: `worktree ${worktree1}\nHEAD abcd1234\nbranch refs/heads/tars/issue-1\n`,
					stderr: "",
				};
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(
			{ ...createConfig(root), maxWorktrees: 2, evictionStrategy: "lru" },
			runCommand,
		);

		await manager.createOrGetWorktree("mbrooks", "tars", 1);

		const afterStat = await stat(worktree1);
		expect(afterStat.mtimeMs).toBeGreaterThanOrEqual(beforeStat.mtimeMs);
	});

	it("stashes uncommitted changes before evicting a worktree", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-stash-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktree1 = path.join(bareRepoPath, ".worktrees", "issue-1");
		const worktree2 = path.join(bareRepoPath, ".worktrees", "issue-2");

		await mkdir(bareRepoPath, { recursive: true });
		await mkdir(worktree1, { recursive: true });
		await mkdir(worktree2, { recursive: true });

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
				return {
					stdout: [
						`worktree ${worktree1}`,
						"HEAD abcd1234",
						"branch refs/heads/tars/issue-1",
						"",
						`worktree ${worktree2}`,
						"HEAD abcd1234",
						"branch refs/heads/tars/issue-2",
						"",
					].join("\n"),
					stderr: "",
				};
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "fetch") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "rev-parse") {
				return { stdout: "abcd1234\n", stderr: "" };
			}
			if (args[0] === "show-ref") {
				const error = new Error("not found") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			if (args[0] === "status" && args[1] === "--porcelain") {
				return { stdout: "M file.txt\n", stderr: "" };
			}
			if (args[0] === "stash" && args[1] === "push") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "remove") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "add") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "config") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(
			{ ...createConfig(root), maxWorktrees: 2, evictionStrategy: "fifo" },
			runCommand,
		);

		await manager.createOrGetWorktree("mbrooks", "tars", 3);

		const stashCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([_cmd, args]) => args[0] === "stash" && args[1] === "push",
		);
		expect(stashCalls).toHaveLength(1);
		expect(stashCalls[0][1]).toContain("-u");
		expect(stashCalls[0][1]).toContain("TARS auto-stash before eviction of issue-1");
	});

	it("logs eviction to stdout", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-log-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktree1 = path.join(bareRepoPath, ".worktrees", "issue-1");

		await mkdir(bareRepoPath, { recursive: true });
		await mkdir(worktree1, { recursive: true });

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
				return {
					stdout: `worktree ${worktree1}\nHEAD abcd1234\nbranch refs/heads/tars/issue-1\n`,
					stderr: "",
				};
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "fetch") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "rev-parse") {
				return { stdout: "abcd1234\n", stderr: "" };
			}
			if (args[0] === "show-ref") {
				const error = new Error("not found") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			if (args[0] === "worktree" && args[1] === "remove") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "add") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(
			{ ...createConfig(root), maxWorktrees: 1, evictionStrategy: "fifo" },
			runCommand,
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await manager.createOrGetWorktree("mbrooks", "tars", 3);

		expect(writeSpy).toHaveBeenCalledWith(
			expect.stringContaining("[workspace] Evicted worktree"),
		);
		expect(writeSpy).toHaveBeenCalledWith(
			expect.stringContaining("mbrooks/tars"),
		);

		writeSpy.mockRestore();
	});

	it("does not evict when under the worktree limit", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-no-evict-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktree1 = path.join(bareRepoPath, ".worktrees", "issue-1");

		await mkdir(bareRepoPath, { recursive: true });
		await mkdir(worktree1, { recursive: true });

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
				return {
					stdout: `worktree ${worktree1}\nHEAD abcd1234\nbranch refs/heads/tars/issue-1\n`,
					stderr: "",
				};
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "fetch") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "rev-parse") {
				return { stdout: "abcd1234\n", stderr: "" };
			}
			if (args[0] === "show-ref") {
				const error = new Error("not found") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			if (args[0] === "worktree" && args[1] === "add") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(
			{ ...createConfig(root), maxWorktrees: 3, evictionStrategy: "fifo" },
			runCommand,
		);

		await manager.createOrGetWorktree("mbrooks", "tars", 3);

		const removeCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([_cmd, args]) => args[0] === "worktree" && args[1] === "remove",
		);
		expect(removeCalls).toHaveLength(0);
	});
});

describe("generateCommitMessage", () => {
	it("uses TARS: prefix when no labels match", () => {
		const msg = generateCommitMessage(undefined, 42, "Add widget support");
		expect(msg).toBe("TARS: Add widget support");
	});

	it("infers feat: from enhancement label", () => {
		const msg = generateCommitMessage(["enhancement"], 42, "Add dark mode");
		expect(msg).toBe("feat: Add dark mode");
	});

	it("infers fix: from bug label", () => {
		const msg = generateCommitMessage(["bug"], 42, "Resolve race condition");
		expect(msg).toBe("fix: Resolve race condition");
	});

	it("infers test: from test label", () => {
		const msg = generateCommitMessage(["test"], 42, "Cover edge cases");
		expect(msg).toBe("test: Cover edge cases");
	});

	it("falls back to generic message without summary", () => {
		const msg = generateCommitMessage(["chore"], 7, undefined);
		expect(msg).toBe("chore: Changes for issue #7");
	});

	it("truncates at word boundary to stay under 50 chars", () => {
		const long =
			"This is an extraordinarily long summary that definitely exceeds the fifty character soft limit";
		const msg = generateCommitMessage(["bug"], 99, long);
		expect(msg.length).toBeLessThanOrEqual(50);
		expect(msg.startsWith("fix: ")).toBe(true);
	});

	it("hard truncates at 72 chars when word boundary not found", () => {
		const long = "A".repeat(100);
		const msg = generateCommitMessage(undefined, 1, long);
		expect(msg.length).toBeLessThanOrEqual(72);
		expect(msg.startsWith("TARS: ")).toBe(true);
	});

	it("uses first line as subject and rest as body", () => {
		const msg = generateCommitMessage(["docs"], 5, "Update README\n\nMore details here");
		expect(msg).toBe("docs: Update README\n\nMore details here");
	});

	it("is case-insensitive for label matching", () => {
		const msg = generateCommitMessage(["BUG", "Enhancement"], 3, "Something");
		expect(msg).toBe("fix: Something");
	});

	it("prefers first matching prefix", () => {
		const msg = generateCommitMessage(["bug", "enhancement"], 2, "Something");
		expect(msg).toBe("fix: Something");
	});

	it("converts past tense to imperative mood", () => {
		const msg = generateCommitMessage(["enhancement"], 1, "Implemented the silent flag");
		expect(msg).toBe("feat: Implement the silent flag");
	});

	it("preserves case when converting to imperative", () => {
		const msg = generateCommitMessage(["enhancement"], 1, "implemented the silent flag");
		expect(msg).toBe("feat: implement the silent flag");
	});

	it("strips trailing period from subject", () => {
		const msg = generateCommitMessage(["bug"], 1, "Fixed a bug.");
		expect(msg).toBe("fix: Fix a bug");
	});

	it("wraps body at 72 characters", () => {
		const body = Array.from({ length: 50 }, () => "word").join(" ");
		const summary = `Subject\n\n${body}`;
		const msg = generateCommitMessage(["feat"], 1, summary);
		const lines = msg.split("\n");
		for (const line of lines) {
			expect(line.length).toBeLessThanOrEqual(72);
		}
	});

	it("preserves list items when wrapping body", () => {
		const summary =
			"Subject\n\n- First item that is very long and should definitely be wrapped correctly because it exceeds seventy-two characters\n- Second item";
		const msg = generateCommitMessage(["feat"], 1, summary);
		expect(msg).toContain("- First item");
		expect(msg).toContain("- Second item");
	});
});
