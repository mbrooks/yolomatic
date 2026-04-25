import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceConfig } from "./config.js";
import type { CommandRunner } from "./manager.js";
import { WorkspaceManager } from "./manager.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		stat: vi.fn((...args: Parameters<typeof actual.stat>) => actual.stat(...args)),
		rm: vi.fn((...args: Parameters<typeof actual.rm>) => actual.rm(...args)),
	};
});

function createConfig(workspacesDir: string): WorkspaceConfig {
	return {
		workspacesDir,
		githubUsername: "mbrooks",
		githubToken: "secret",
		defaultBranch: "main",
	};
}

describe("WorkspaceManager", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});
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
			["worktree", "add", worktree.path, "-b", "tars/issue-42", "main"],
			{ cwd: bareRepoPath },
		);
	});

	it("returns existing worktree if already created", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-worktree-"));
		const bareRepoPath = path.join(root, "mbrooks-tars");
		const worktreePath = path.join(bareRepoPath, ".worktrees", "issue-42");

		let worktreeCreated = false;
		const runCommand: CommandRunner = vi.fn(async (_cmd, args) => {
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
			["worktree", "add", worktreePath, "-b", "tars/issue-42", "main"],
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
			["worktree", "add", worktreePath, "tars/issue-42"],
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

		await manager.commitAndPush("mbrooks", "tars", 42);

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
			["fetch", "origin", "+master:master"],
			{ cwd: bareRepoPath },
		);
		expect(runCommand).toHaveBeenCalledWith(
			"git",
			["worktree", "add", worktreePath, "-b", "tars/issue-42", "master"],
			{ cwd: bareRepoPath },
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

	it("removes foreign-owned node_modules during sanitization", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-foreign-node-modules-"));
		const worktreePath = path.join(root, "worktree");
		await mkdir(path.join(worktreePath, "node_modules"), { recursive: true });

		vi.spyOn(process, "getuid").mockReturnValue(1000);
		vi.mocked(stat).mockResolvedValueOnce({
			isDirectory: () => true,
			uid: 0,
		} as unknown as Awaited<ReturnType<typeof stat>>);

		const manager = new WorkspaceManager(createConfig(root), vi.fn());
		await (manager as unknown as { sanitizeNodeModules: (p: string) => Promise<void> }).sanitizeNodeModules(
			worktreePath,
		);

		expect(rm).toHaveBeenCalledTimes(1);
		expect(rm).toHaveBeenCalledWith(path.join(worktreePath, "node_modules"), { recursive: true, force: true });
	});

	it("preserves user-owned node_modules during sanitization", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-user-node-modules-"));
		const worktreePath = path.join(root, "worktree");
		const nodeModulesPath = path.join(worktreePath, "node_modules");
		await mkdir(nodeModulesPath, { recursive: true });

		vi.spyOn(process, "getuid").mockReturnValue(process.getuid?.() ?? 1000);

		const manager = new WorkspaceManager(createConfig(root), vi.fn());
		await (manager as unknown as { sanitizeNodeModules: (p: string) => Promise<void> }).sanitizeNodeModules(
			worktreePath,
		);

		expect(rm).not.toHaveBeenCalled();
		// Verify directory still exists
		const stats = await stat(nodeModulesPath);
		expect(stats.isDirectory()).toBe(true);
	});

	it("handles missing node_modules gracefully during sanitization", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-missing-node-modules-"));
		const worktreePath = path.join(root, "worktree");

		const manager = new WorkspaceManager(createConfig(root), vi.fn());
		await expect(
			(manager as unknown as { sanitizeNodeModules: (p: string) => Promise<void> }).sanitizeNodeModules(worktreePath),
		).resolves.toBeUndefined();
		expect(rm).not.toHaveBeenCalled();
	});
});
