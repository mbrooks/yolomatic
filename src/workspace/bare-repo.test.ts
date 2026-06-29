import { mkdtemp } from "node:fs/promises";
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
