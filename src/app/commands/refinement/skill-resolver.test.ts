import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FilesystemSkillResolver } from "./skill-resolver.js";

describe("FilesystemSkillResolver", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "skill-resolver-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("reads the repository SKILL.md and reports the repository-skill source", async () => {
		const worktree = path.join(tmpDir, "worktree");
		const skillDir = path.join(worktree, ".pi", "skills", "issue-refinement");
		await mkdir(skillDir, { recursive: true });
		await writeFile(path.join(skillDir, "SKILL.md"), "Skill instructions", "utf-8");

		const resolver = new FilesystemSkillResolver();
		const info = await resolver.resolveSkill(worktree);
		expect(info.source).toBe("repository-skill");
		expect(info.content).toBe("Skill instructions");
	});

	it("falls back to prompt-defaults when no skill file exists", async () => {
		const worktree = path.join(tmpDir, "empty-worktree");
		await mkdir(worktree, { recursive: true });

		const resolver = new FilesystemSkillResolver();
		const info = await resolver.resolveSkill(worktree);
		expect(info.source).toBe("prompt-defaults");
		expect(info.content).toBeUndefined();
	});

	it("resolves the current commit when the worktree is a git repo", async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const exec = promisify(execFile);
		const worktree = path.join(tmpDir, "git-worktree");
		await mkdir(worktree, { recursive: true });
		await exec("git", ["init"], { cwd: worktree });
		await exec("git", ["config", "user.email", "test@example.com"], { cwd: worktree });
		await exec("git", ["config", "user.name", "Test"], { cwd: worktree });
		await writeFile(path.join(worktree, "README.md"), "hello", "utf-8");
		await exec("git", ["add", "."], { cwd: worktree });
		await exec("git", ["commit", "-m", "init"], { cwd: worktree });

		const resolver = new FilesystemSkillResolver();
		const info = await resolver.resolveSkill(worktree);
		expect(typeof info.commit).toBe("string");
		expect(info.commit!.length).toBe(40);
	});

	it("returns an undefined commit when git rev-parse fails", async () => {
		const worktree = path.join(tmpDir, "non-git-worktree");
		await mkdir(worktree, { recursive: true });

		const resolver = new FilesystemSkillResolver();
		const info = await resolver.resolveSkill(worktree);
		expect(info.commit).toBeUndefined();
	});

	it("uses an injected git runner for commit resolution", async () => {
		const worktree = path.join(tmpDir, "injected");
		await mkdir(worktree, { recursive: true });
		const git = vi.fn(async () => "deadbeef");
		const resolver = new FilesystemSkillResolver(git);
		const info = await resolver.resolveSkill(worktree);
		expect(info.commit).toBe("deadbeef");
		expect(git).toHaveBeenCalledWith(worktree);
	});
});