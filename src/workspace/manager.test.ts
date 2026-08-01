import { mkdtemp, mkdir, utimes, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { WorkspaceConfig } from "./config.js";
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
		expect(manager.getBranchName(42)).toBe("yeetomatic/issue-42");
	});

	it("initializes a repo by cloning the bare repository", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-init-repo-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "rev-parse") {
				return { stdout: "abcd1234\n", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		await manager.initializeRepo("mbrooks", "yeetomatic");

		const cloneCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([cmd, args]) => cmd === "git" && args[0] === "clone",
		);
		expect(cloneCalls).toHaveLength(1);
		expect(cloneCalls[0][1]).toContain("--bare");
		expect(cloneCalls[0][1]).toContain(bareRepoPath);
		expect(cloneCalls[0][1].some((arg) => arg.includes("github.com"))).toBe(true);
	});

	it("fetches existing bare repo during initializeRepo instead of cloning", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-init-repo-valid-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
		await mkdir(bareRepoPath, { recursive: true });

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "rev-parse" && args[1] === "--git-dir") {
				return { stdout: ".\n", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		await manager.initializeRepo("mbrooks", "yeetomatic");

		const fetchCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([cmd, args]) => cmd === "git" && args[0] === "fetch" && args[1] === "origin",
		);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.[1]).toEqual(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*", "--prune"]);

		const cloneCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([cmd, args]) => cmd === "git" && args[0] === "clone",
		);
		expect(cloneCalls).toHaveLength(0);
	});

	it("creates worktree by cloning bare repo and adding worktree", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worktree-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
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

		const worktree = await manager.createOrGetWorktree("mbrooks", "yeetomatic", 42);

		expect(worktree.branch).toBe("yeetomatic/issue-42");
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
			["worktree", "add", worktree.path, "-b", "yeetomatic/issue-42", "origin/HEAD"],
			{ cwd: bareRepoPath },
		);
	});

	it("fetches existing bare repo instead of cloning when directory is valid", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-valid-bare-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
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

		const worktree = await manager.createOrGetWorktree("mbrooks", "yeetomatic", 42);

		expect(worktree.branch).toBe("yeetomatic/issue-42");

		const fetchCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([cmd, args]) => cmd === "git" && args[0] === "fetch" && args[1] === "origin",
		);
		expect(fetchCalls).toHaveLength(2);
		expect(fetchCalls[0]?.[1]).toEqual(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*", "--prune"]);

		const cloneCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([cmd, args]) => cmd === "git" && args[0] === "clone",
		);
		expect(cloneCalls).toHaveLength(0);
	});

	it("re-clones when bare repo directory exists but is not a valid git repository", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-corrupted-bare-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
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

		const worktree = await manager.createOrGetWorktree("mbrooks", "yeetomatic", 42);

		expect(worktree.branch).toBe("yeetomatic/issue-42");

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
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worktree-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
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
						? `worktree ${worktreePath}\nHEAD abcd1234\nbranch refs/heads/yeetomatic/issue-42\n`
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
		const worktree1 = await manager.createOrGetWorktree("mbrooks", "yeetomatic", 42);
		expect(worktree1.path).toBe(worktreePath);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["worktree", "add", worktreePath, "-b", "yeetomatic/issue-42", "origin/HEAD"],
			{ cwd: bareRepoPath },
		);

		// Second call returns existing
		const worktree2 = await manager.createOrGetWorktree("mbrooks", "yeetomatic", 42);
		expect(worktree2.path).toBe(worktreePath);
		expect(worktree2.branch).toBe("yeetomatic/issue-42");

		// Should not call worktree add again
		const worktreeAddCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([_cmd, args]) => args[0] === "worktree" && args[1] === "add",
		);
		expect(worktreeAddCalls).toHaveLength(1);
	});

	it("creates worktree from existing branch if branch already exists", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-existing-branch-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "rev-parse") {
				return { stdout: "abcd1234\n", stderr: "" };
			}
			if (args[0] === "show-ref") {
				return { stdout: "abcd1234 refs/heads/yeetomatic/issue-42", stderr: "" };
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

		const worktree = await manager.createOrGetWorktree("mbrooks", "yeetomatic", 42);

		expect(worktree.branch).toBe("yeetomatic/issue-42");
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["branch", "-f", "yeetomatic/issue-42", "origin/HEAD"],
			{ cwd: bareRepoPath },
		);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["worktree", "add", "--force", worktreePath, "yeetomatic/issue-42"],
			{ cwd: bareRepoPath },
		);
	});

	it("delegates syncWorktree to the worktree manager", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-manager-sync-"));
		const runCommand: CommandRunner = vi.fn(async () => ({ stdout: "", stderr: "" }));
		const manager = new WorkspaceManager(createConfig(root), runCommand);
		const syncSpy = vi.fn(async () => undefined);
		vi.spyOn(manager as unknown as { worktrees: { syncWorktree: typeof syncSpy } }, "worktrees", "get").mockReturnValue({ syncWorktree: syncSpy });

		await manager.syncWorktree("mbrooks", "yeetomatic", 42);

		expect(syncSpy).toHaveBeenCalledWith("mbrooks", "yeetomatic", 42);
	});

	it("commits and pushes from worktree", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-commit-"));
		const worktreePath = path.join(root, "mbrooks-yeetomatic", ".worktrees", "issue-42");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
				const error = new Error("changes exist") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		expect(await manager.commitAndPush("mbrooks", "yeetomatic", 42)).toBe(true);

		expect(runCommand).toHaveBeenCalledWith("git", ["config", "user.name", "Yeetomatic"], { cwd: worktreePath });
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["config", "user.email", "mbrooks@users.noreply.github.com"],
			{ cwd: worktreePath },
		);
		expect(runCommand).toHaveBeenCalledWith("git", ["add", "-A"], { cwd: worktreePath });
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["commit", "-m", "Yeetomatic: Changes for issue #42"],
			{ cwd: worktreePath },
		);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["push", "origin", "yeetomatic/issue-42"],
			expect.objectContaining({ cwd: worktreePath, env: expect.any(Object) }),
		);
	});

	it("commits and pushes from a custom worktree path", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-commit-path-"));
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
			await manager.commitAndPushPath(worktreePath, "yeetomatic/custom-test", "chore: Update deps", "main"),
		).toBe(true);

		expect(runCommand).toHaveBeenCalledWith("git", ["config", "user.name", "Yeetomatic"], { cwd: worktreePath });
		expect(runCommand).toHaveBeenCalledWith("git", ["add", "-A"], { cwd: worktreePath });
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["commit", "-m", "chore: Update deps"],
			{ cwd: worktreePath },
		);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["push", "origin", "yeetomatic/custom-test"],
			expect.objectContaining({ cwd: worktreePath, env: expect.any(Object) }),
		);
	});

	it("uses default branch for commitAndPushPath when baseBranch is omitted", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-default-base-"));
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
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-custom-base-"));
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
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-path-no-changes-"));
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
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-no-changes-no-commits-"));
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

		expect(await manager.commitAndPush("mbrooks", "yeetomatic", 42)).toBe(false);
	});

	it("pushes when there are no new changes but commits already exist on branch", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-existing-commits-"));
		const worktreePath = path.join(root, "mbrooks-yeetomatic", ".worktrees", "issue-42");
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

		expect(await manager.commitAndPush("mbrooks", "yeetomatic", 42)).toBe(true);

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["push", "origin", "yeetomatic/issue-42"],
			expect.objectContaining({ cwd: worktreePath, env: expect.any(Object) }),
		);
	});

	it("throws when push fails", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-push-fails-"));
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

		await expect(manager.commitAndPush("mbrooks", "yeetomatic", 42)).rejects.toThrow("Authentication failed");
	});

	it("commits with a custom message when provided", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-commit-msg-"));
		const worktreePath = path.join(root, "mbrooks-yeetomatic", ".worktrees", "issue-42");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
				const error = new Error("changes exist") as Error & { code?: number };
				error.code = 1;
				throw error;
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		expect(await manager.commitAndPush("mbrooks", "yeetomatic", 42, "feat: Add widget support")).toBe(true);

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["commit", "-m", "feat: Add widget support"],
			{ cwd: worktreePath },
		);
	});

	it("removes worktree if it exists", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-remove-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return {
					stdout: `worktree ${worktreePath}\nHEAD abcd1234\nbranch refs/heads/yeetomatic/issue-42\n`,
					stderr: "",
				};
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		await manager.removeWorktree("mbrooks", "yeetomatic", 42);

		expect(runCommand).toHaveBeenCalledWith("git", ["worktree", "remove", worktreePath], {
			cwd: bareRepoPath,
		});
	});

	it("prunes stale worktrees before adding new worktree", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-prune-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
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

		await manager.createOrGetWorktree("mbrooks", "yeetomatic", 42);

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
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-worktree-error-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "rev-parse") {
				return { stdout: "abcd1234\n", stderr: "" };
			}
			if (args[0] === "show-ref") {
				return { stdout: "abcd1234 refs/heads/yeetomatic/issue-42", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "add") {
				throw new Error("fatal: 'yeetomatic/issue-42' is already used by worktree");
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		await expect(manager.createOrGetWorktree("mbrooks", "yeetomatic", 42)).rejects.toThrow(
			"[workspace] ERROR: Cannot create worktree for yeetomatic/issue-42",
		);
		await expect(manager.createOrGetWorktree("mbrooks", "yeetomatic", 42)).rejects.toThrow(
			"git worktree prune",
		);
	});

	it("updates the default branch before creating a new worktree", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-fetch-default-branch-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
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

		await manager.createOrGetWorktree("mbrooks", "yeetomatic", 42);

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*", "--prune"],
			expect.objectContaining({ cwd: bareRepoPath, env: expect.any(Object) }),
		);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["worktree", "add", worktreePath, "-b", "yeetomatic/issue-42", "origin/HEAD"],
			{ cwd: bareRepoPath },
		);
	});

	it("falls back to bare HEAD when remote refs are unavailable", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-bare-head-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
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

		await manager.createOrGetWorktree("mbrooks", "yeetomatic", 42);

		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["worktree", "add", worktreePath, "-b", "yeetomatic/issue-42", "HEAD"],
			{ cwd: bareRepoPath },
		);
	});

	it("throws EmptyRepositoryError when no refs exist at all", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-empty-repo-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
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

		await expect(manager.createOrGetWorktree("mbrooks", "yeetomatic", 42)).rejects.toThrow(EmptyRepositoryError);
		await expect(manager.createOrGetWorktree("mbrooks", "yeetomatic", 42)).rejects.toThrow(
			"The repository appears to be empty",
		);
	});

	it("does nothing when removing a non-existent worktree", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-remove-missing-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-99");

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		await manager.removeWorktree("mbrooks", "yeetomatic", 99);
		// git worktree remove should NOT be called
		const removeCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([_cmd, args]) => args[0] === "worktree" && args[1] === "remove",
		);
		expect(removeCalls).toHaveLength(0);
	});

	it("detects no changes when git diff exits cleanly", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-no-changes-"));
		const runCommand: CommandRunner = vi.fn(async () => ({ stdout: "", stderr: "" }));
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		const hasChanges = await manager.hasChanges(root);
		expect(hasChanges).toBe(false);
		expect(runCommand).toHaveBeenCalledWith("git", ["diff", "--quiet"], { cwd: root });
	});

	it("detects no cached changes when git diff --cached exits cleanly", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-no-cached-"));
		const runCommand: CommandRunner = vi.fn(async () => ({ stdout: "", stderr: "" }));
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		const hasChanges = await manager.hasChanges(root, true);
		expect(hasChanges).toBe(false);
		expect(runCommand).toHaveBeenCalledWith("git", ["diff", "--cached", "--quiet"], { cwd: root });
	});

	it("evicts oldest worktree when limit is reached with FIFO", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-fifo-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
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
						"branch refs/heads/yeetomatic/issue-1",
						"",
						`worktree ${worktree2}`,
						"HEAD abcd1234",
						"branch refs/heads/yeetomatic/issue-2",
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

		await manager.createOrGetWorktree("mbrooks", "yeetomatic", 3);

		const removeCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([_cmd, args]) => args[0] === "worktree" && args[1] === "remove",
		);
		expect(removeCalls).toHaveLength(1);
		expect(removeCalls[0][1]).toContain(worktree1);
		expect(removeCalls[0][1]).not.toContain(worktree2);
	});

	it("evicts least recently used worktree with LRU", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-lru-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
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
						"branch refs/heads/yeetomatic/issue-1",
						"",
						`worktree ${worktree2}`,
						"HEAD abcd1234",
						"branch refs/heads/yeetomatic/issue-2",
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

		await manager.createOrGetWorktree("mbrooks", "yeetomatic", 3);

		const removeCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([_cmd, args]) => args[0] === "worktree" && args[1] === "remove",
		);
		expect(removeCalls).toHaveLength(1);
		expect(removeCalls[0][1]).toContain(worktree1);
		expect(removeCalls[0][1]).not.toContain(worktree2);
	});

	it("updates mtime of existing worktree when returned to track LRU", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-lru-touch-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
		const worktree1 = path.join(bareRepoPath, ".worktrees", "issue-1");

		await mkdir(bareRepoPath, { recursive: true });
		await mkdir(worktree1, { recursive: true });

		const beforeStat = await stat(worktree1);

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
				return {
					stdout: `worktree ${worktree1}\nHEAD abcd1234\nbranch refs/heads/yeetomatic/issue-1\n`,
					stderr: "",
				};
			}
			return { stdout: "", stderr: "" };
		});
		const manager = new WorkspaceManager(
			{ ...createConfig(root), maxWorktrees: 2, evictionStrategy: "lru" },
			runCommand,
		);

		await manager.createOrGetWorktree("mbrooks", "yeetomatic", 1);

		const afterStat = await stat(worktree1);
		expect(afterStat.mtimeMs).toBeGreaterThanOrEqual(beforeStat.mtimeMs);
	});

	it("stashes uncommitted changes before evicting a worktree", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-stash-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
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
						"branch refs/heads/yeetomatic/issue-1",
						"",
						`worktree ${worktree2}`,
						"HEAD abcd1234",
						"branch refs/heads/yeetomatic/issue-2",
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

		await manager.createOrGetWorktree("mbrooks", "yeetomatic", 3);

		const stashCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([_cmd, args]) => args[0] === "stash" && args[1] === "push",
		);
		expect(stashCalls).toHaveLength(1);
		expect(stashCalls[0][1]).toContain("-u");
		expect(stashCalls[0][1]).toContain("Yeetomatic auto-stash before eviction of issue-1");
	});

	it("logs eviction to stdout", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-log-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
		const worktree1 = path.join(bareRepoPath, ".worktrees", "issue-1");

		await mkdir(bareRepoPath, { recursive: true });
		await mkdir(worktree1, { recursive: true });

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
				return {
					stdout: `worktree ${worktree1}\nHEAD abcd1234\nbranch refs/heads/yeetomatic/issue-1\n`,
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

		await manager.createOrGetWorktree("mbrooks", "yeetomatic", 3);

		expect(writeSpy).toHaveBeenCalledWith(
			expect.stringContaining("[workspace] Evicted worktree"),
		);
		expect(writeSpy).toHaveBeenCalledWith(
			expect.stringContaining("mbrooks/yeetomatic"),
		);

		writeSpy.mockRestore();
	});

	it("does not evict when under the worktree limit", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-no-evict-"));
		const bareRepoPath = path.join(root, "mbrooks-yeetomatic");
		const worktree1 = path.join(bareRepoPath, ".worktrees", "issue-1");

		await mkdir(bareRepoPath, { recursive: true });
		await mkdir(worktree1, { recursive: true });

		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
			if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
				return {
					stdout: `worktree ${worktree1}\nHEAD abcd1234\nbranch refs/heads/yeetomatic/issue-1\n`,
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

		await manager.createOrGetWorktree("mbrooks", "yeetomatic", 3);

		const removeCalls = ((runCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>).filter(
			([_cmd, args]) => args[0] === "worktree" && args[1] === "remove",
		);
		expect(removeCalls).toHaveLength(0);
	});
});
