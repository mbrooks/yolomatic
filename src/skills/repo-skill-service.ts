import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import type { RepoSkill, SkillFormData } from "./model.js";

const execFileAsync = promisify(execFile);

export type CommandRunner = (
	command: string,
	args: string[],
	options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export interface RepoSkillServiceConfig {
	workspacesDir: string;
	githubUsername: string;
	githubToken: string;
	defaultBranch: string;
}

function normalizeSegment(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`${label} is required`);
	}
	if (!/^[a-zA-Z0-9._-]+$/u.test(trimmed)) {
		throw new Error(`Invalid ${label}: ${value}`);
	}
	return trimmed;
}

function getCommonIndent(lines: string[]): number {
	let min = Infinity;
	for (const line of lines) {
		if (line === "") continue;
		const match = line.match(/^(\s*)/);
		const len = match ? match[1].length : 0;
		if (len < min) min = len;
	}
	return min === Infinity ? 0 : min;
}

function stripIndent(lines: string[]): string {
	const indent = getCommonIndent(lines);
	return lines.map((l) => l.slice(indent)).join("\n");
}

function parseBlockScalar(raw: string, indicator: string): string {
	const lines = raw.split("\n");
	const isFolded = indicator.startsWith(">");
	if (isFolded) {
		const paragraphs: string[] = [];
		let current: string[] = [];
		for (const line of lines) {
			if (line === "") {
				if (current.length > 0) {
					paragraphs.push(current.join(" "));
					current = [];
				}
			} else {
				current.push(line);
			}
		}
		if (current.length > 0) {
			paragraphs.push(current.join(" "));
		}
		const text = paragraphs.join("\n\n");
		if (indicator.endsWith("+")) return text + "\n";
		if (indicator.endsWith("-")) return text.trimEnd();
		return text;
	}
	const text = lines.join("\n");
	if (indicator.endsWith("+")) return text + "\n";
	if (indicator.endsWith("-")) return text.trimEnd();
	return text;
}

export function parseSkillFile(content: string): { name: string; description: string; body: string } {
	const trimmed = content.trimStart();
	if (!trimmed.startsWith("---")) {
		return { name: "", description: "", body: content };
	}
	const endIndex = trimmed.indexOf("---", 3);
	if (endIndex === -1) {
		return { name: "", description: "", body: content };
	}
	const frontmatter = trimmed.slice(3, endIndex).trimEnd();
	const body = trimmed.slice(endIndex + 3).trimStart();

	let name = "";
	let description = "";
	const lines = frontmatter.split("\n");
	const blockScalarPattern = /^[>|]([+-])?$/u;

	function collectBlockLines(startIndex: number): { lines: string[]; nextIndex: number } {
		const blockLines: string[] = [];
		let i = startIndex;
		while (i < lines.length) {
			const line = lines[i];
			if (/^([a-zA-Z0-9_-]+):\s*/.test(line)) {
				break;
			}
			if (line === "") {
				blockLines.push("");
				i++;
				continue;
			}
			if (/^\s/.test(line)) {
				blockLines.push(line);
				i++;
			} else {
				break;
			}
		}
		return { lines: blockLines, nextIndex: i };
	}

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/u);
		if (match) {
			const key = match[1];
			const value = match[2].trim();
			if (blockScalarPattern.test(value)) {
				const { lines: blockLines, nextIndex } = collectBlockLines(i + 1);
				const raw = stripIndent(blockLines);
				const parsedValue = parseBlockScalar(raw, value);
				if (key === "name") name = parsedValue;
				if (key === "description") description = parsedValue;
				i = nextIndex;
			} else {
				if (key === "name") name = value;
				if (key === "description") description = value;
				i++;
			}
		} else {
			i++;
		}
	}
	return { name, description, body };
}

export function buildSkillFile(name: string, description: string, body: string): string {
	let descYaml: string;
	if (description.includes("\n")) {
		const lines = description.split("\n");
		descYaml = "|\n" + lines.map((l) => "  " + l).join("\n");
	} else {
		descYaml = description;
	}
	return `---\nname: ${name}\ndescription: ${descYaml}\n---\n\n${body}`;
}

export class RepoSkillService {
	private readonly runCommand: CommandRunner;

	public constructor(
		private readonly config: RepoSkillServiceConfig,
		runCommand?: CommandRunner,
	) {
		this.runCommand = runCommand ?? (async (command, args, options) =>
			execFileAsync(command, args, { cwd: options?.cwd, env: process.env })
		);
	}

	private getRepoKey(owner: string, repo: string): string {
		return `${normalizeSegment(owner, "owner")}-${normalizeSegment(repo, "repo")}`.toLowerCase();
	}

	private getBareRepoPath(owner: string, repo: string): string {
		return path.join(this.config.workspacesDir, this.getRepoKey(owner, repo));
	}

	private async ensureBareRepo(owner: string, repo: string): Promise<void> {
		const bareRepoPath = this.getBareRepoPath(owner, repo);
		if (this.pathExists(bareRepoPath)) {
			try {
				await this.runCommand("git", ["fetch", "origin", "--prune"], { cwd: bareRepoPath });
			} catch {
				// ignore fetch errors
			}
			return;
		}
		mkdirSync(this.config.workspacesDir, { recursive: true });
		const encodedUsername = encodeURIComponent(this.config.githubUsername);
		const encodedToken = encodeURIComponent(this.config.githubToken);
		const url = `https://${encodedUsername}:${encodedToken}@github.com/${owner}/${repo}.git`;
		await this.runCommand("git", ["clone", "--bare", url, bareRepoPath]);
	}

	private async createTempWorktree(bareRepoPath: string, branch: string): Promise<string> {
		const tempPath = path.join(bareRepoPath, ".skill-worktree");
		try {
			await this.runCommand("git", ["worktree", "remove", "--force", tempPath], { cwd: bareRepoPath });
		} catch {
			// ignore
		}
		await this.runCommand("git", ["worktree", "add", "-B", branch, tempPath, `origin/${branch}`], { cwd: bareRepoPath }).catch(async () => {
			await this.runCommand("git", ["worktree", "add", "-B", branch, tempPath, branch], { cwd: bareRepoPath }).catch(async () => {
				await this.runCommand("git", ["worktree", "add", tempPath, branch], { cwd: bareRepoPath });
			});
		});
		return tempPath;
	}

	private async removeTempWorktree(bareRepoPath: string): Promise<void> {
		const tempPath = path.join(bareRepoPath, ".skill-worktree");
		try {
			await this.runCommand("git", ["worktree", "remove", "--force", tempPath], { cwd: bareRepoPath });
		} catch {
			// ignore
		}
	}

	private async ensureGitIdentity(worktreePath: string): Promise<void> {
		await this.runCommand("git", ["config", "user.name", "TARS"], { cwd: worktreePath });
		await this.runCommand("git", ["config", "user.email", `${this.config.githubUsername}@users.noreply.github.com`], { cwd: worktreePath });
	}

	private pathExists(targetPath: string): boolean {
		try {
			statSync(targetPath);
			return true;
		} catch {
			return false;
		}
	}

	async listRepoSkills(owner: string, repo: string): Promise<RepoSkill[]> {
		await this.ensureBareRepo(owner, repo);
		const bareRepoPath = this.getBareRepoPath(owner, repo);
		const worktreePath = await this.createTempWorktree(bareRepoPath, this.config.defaultBranch);
		try {
			return this.readSkillsFromWorktree(worktreePath);
		} finally {
			await this.removeTempWorktree(bareRepoPath);
		}
	}

	async getRepoSkill(owner: string, repo: string, name: string): Promise<RepoSkill | null> {
		await this.ensureBareRepo(owner, repo);
		const bareRepoPath = this.getBareRepoPath(owner, repo);
		const worktreePath = await this.createTempWorktree(bareRepoPath, this.config.defaultBranch);
		try {
			const settingsSkills = this.readEnabledSkills(worktreePath);
			const skillFile = path.join(worktreePath, ".pi/skills", name, "SKILL.md");
			if (!this.pathExists(skillFile)) return null;
			const content = readFileSync(skillFile, "utf-8");
			const parsed = parseSkillFile(content);
			const skillName = parsed.name || name;
			return {
				name: skillName,
				description: parsed.description,
				content: parsed.body,
				enabled: settingsSkills.has(skillName),
				updatedAt: "",
				source: "repo",
			};
		} catch {
			return null;
		} finally {
			await this.removeTempWorktree(bareRepoPath);
		}
	}

	async saveRepoSkill(
		owner: string,
		repo: string,
		data: SkillFormData,
	): Promise<{ success: boolean; error?: string }> {
		try {
			await this.ensureBareRepo(owner, repo);
			const bareRepoPath = this.getBareRepoPath(owner, repo);
			const worktreePath = await this.createTempWorktree(bareRepoPath, this.config.defaultBranch);
			const skillDir = path.join(worktreePath, ".pi/skills", data.name);
			mkdirSync(skillDir, { recursive: true });
			const skillFile = path.join(skillDir, "SKILL.md");
			const fileContent = buildSkillFile(data.name, data.description, data.content);
			writeFileSync(skillFile, fileContent);

			// Update settings.json
			await this.updateSettingsJson(worktreePath, data.name, data.enabled);

			await this.ensureGitIdentity(worktreePath);
			await this.runCommand("git", ["add", "-A"], { cwd: worktreePath });
			await this.runCommand("git", ["commit", "-m", `tars: update skill ${data.name}`], { cwd: worktreePath });
			await this.runCommand("git", ["push", "origin", this.config.defaultBranch], { cwd: worktreePath });
			return { success: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { success: false, error: message };
		} finally {
			try {
				const bareRepoPath = this.getBareRepoPath(owner, repo);
				await this.removeTempWorktree(bareRepoPath);
			} catch {
				// ignore cleanup errors
			}
		}
	}

	async deleteRepoSkill(owner: string, repo: string, name: string): Promise<{ success: boolean; error?: string }> {
		try {
			await this.ensureBareRepo(owner, repo);
			const bareRepoPath = this.getBareRepoPath(owner, repo);
			const worktreePath = await this.createTempWorktree(bareRepoPath, this.config.defaultBranch);
			const skillDir = path.join(worktreePath, ".pi/skills", name);
			if (this.pathExists(skillDir)) {
				rmSync(skillDir, { recursive: true, force: true });
			}
			await this.removeSkillFromSettingsJson(worktreePath, name);

			await this.ensureGitIdentity(worktreePath);
			await this.runCommand("git", ["add", "-A"], { cwd: worktreePath });
			await this.runCommand("git", ["commit", "-m", `tars: delete skill ${name}`], { cwd: worktreePath });
			await this.runCommand("git", ["push", "origin", this.config.defaultBranch], { cwd: worktreePath });
			return { success: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { success: false, error: message };
		} finally {
			try {
				const bareRepoPath = this.getBareRepoPath(owner, repo);
				await this.removeTempWorktree(bareRepoPath);
			} catch {
				// ignore cleanup errors
			}
		}
	}

	private async updateSettingsJson(worktreePath: string, skillName: string, enabled: boolean): Promise<void> {
		const settingsPath = path.join(worktreePath, ".pi/settings.json");
		let settings: Record<string, unknown> = {};
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			// file doesn't exist or invalid
		}
		let skills: string[] = [];
		if (Array.isArray(settings.skills)) {
			skills = settings.skills.filter((s): s is string => typeof s === "string");
		}
		if (enabled && !skills.includes(skillName)) {
			skills.push(skillName);
		} else if (!enabled) {
			skills = skills.filter((s) => s !== skillName);
		}
		settings.skills = skills;
		mkdirSync(path.dirname(settingsPath), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
	}

	private async removeSkillFromSettingsJson(worktreePath: string, skillName: string): Promise<void> {
		const settingsPath = path.join(worktreePath, ".pi/settings.json");
		let settings: Record<string, unknown> = {};
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			return;
		}
		if (Array.isArray(settings.skills)) {
			settings.skills = settings.skills.filter((s: unknown) => s !== skillName);
			writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
		}
	}

	private readEnabledSkills(worktreePath: string): Set<string> {
		const settingsPath = path.join(worktreePath, ".pi/settings.json");
		try {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { skills?: unknown };
			if (Array.isArray(settings.skills)) {
				return new Set(settings.skills.filter((skill): skill is string => typeof skill === "string"));
			}
		} catch {
			// ignore missing or invalid settings
		}
		return new Set();
	}

	private readSkillsFromWorktree(worktreePath: string): RepoSkill[] {
		const skillsDir = path.join(worktreePath, ".pi/skills");
		if (!this.pathExists(skillsDir)) {
			return [];
		}

		const enabledSkills = this.readEnabledSkills(worktreePath);
		const skills: RepoSkill[] = [];
		for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
			if (!this.pathExists(skillFile)) continue;
			try {
				const content = readFileSync(skillFile, "utf-8");
				const parsed = parseSkillFile(content);
				const skillName = parsed.name || entry.name;
				skills.push({
					name: skillName,
					description: parsed.description,
					content: parsed.body,
					enabled: enabledSkills.has(skillName),
					updatedAt: "",
					source: "repo",
				});
			} catch {
				// ignore unreadable files
			}
		}
		return skills;
	}
}
