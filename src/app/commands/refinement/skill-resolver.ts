import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface RefinementSkillInfo {
	source: "repository-skill" | "prompt-defaults";
	content?: string;
	commit?: string;
}

/**
 * Boundary for resolving the repository issue-refinement skill and the worktree
 * commit. The default {@link FilesystemSkillResolver} reads the skill file from
 * disk and shells out to `git rev-parse`; tests and alternate compositions can
 * inject a fake to avoid filesystem/Git dependencies.
 */
export interface RefinementSkillResolver {
	resolveSkill(worktreePath: string): Promise<RefinementSkillInfo>;
}

export type GitRevRunner = (worktreePath: string) => Promise<string | undefined>;

/**
 * Default skill resolver backed by the filesystem and `git rev-parse`. Reads
 * `<worktree>/.pi/skills/issue-refinement/SKILL.md` when present, otherwise
 * falls back to `prompt-defaults`. The current commit is resolved via the
 * injected git runner (defaults to a `git rev-parse HEAD` child process) so
 * tests can stub it.
 */
export class FilesystemSkillResolver implements RefinementSkillResolver {
	private readonly git: GitRevRunner;

	constructor(git: GitRevRunner = defaultGitRevParse) {
		this.git = git;
	}

	async resolveSkill(worktreePath: string): Promise<RefinementSkillInfo> {
		const skillPath = path.join(worktreePath, ".pi", "skills", "issue-refinement", "SKILL.md");
		const commit = await this.git(worktreePath);
		try {
			statSync(skillPath);
			const content = readFileSync(skillPath, "utf-8");
			return { source: "repository-skill", content, commit };
		} catch {
			return { source: "prompt-defaults", commit };
		}
	}
}

/** Default `git rev-parse HEAD` runner used when no runner is injected. */
export async function defaultGitRevParse(worktreePath: string): Promise<string | undefined> {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const execFileAsync = promisify(execFile);
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
		return stdout.trim();
	} catch {
		return undefined;
	}
}