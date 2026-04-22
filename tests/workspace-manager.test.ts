import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { WorkspaceConfig } from "../src/workspace/config.js";
import type { CommandRunner } from "../src/workspace/manager.js";
import { WorkspaceManager } from "../src/workspace/manager.js";

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

		expect(manager.getWorkspaceKey("MBrooks", "CaseBot")).toBe("mbrooks-casebot");
		expect(manager.getWorkspacePath("MBrooks", "CaseBot")).toBe(path.join("/tmp/workspaces", "mbrooks-casebot"));
	});

	it("creates predictable feature branches per issue", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "tars-branch-"));
		const repoPath = path.join(root, "mbrooks-tars");
		const runCommand: CommandRunner = vi.fn(async () => {});
		const manager = new WorkspaceManager(createConfig(root), runCommand);

		const branch = await manager.getOrCreateBranch("mbrooks", "tars", 42);

		expect(branch).toBe("tars/issue-42");
		expect(runCommand).toHaveBeenCalledWith("git", ["checkout", "-B", "tars/issue-42"], {
			cwd: repoPath,
		});
	});
});
