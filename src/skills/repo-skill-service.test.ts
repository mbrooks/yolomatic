import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { RepoSkillService, parseSkillFile, buildSkillFile } from "./repo-skill-service.js";
import type { CommandRunner } from "./repo-skill-service.js";

const TEST_DIR = "/tmp/yolomatic-repo-skill-test";

function makeMockRunner(): { runner: CommandRunner; calls: Array<{ command: string; args: string[]; cwd?: string }>; setFiles: Set<string> } {
	const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	const setFiles = new Set<string>();
	const runner: CommandRunner = async (command, args, options) => {
		calls.push({ command, args, cwd: options?.cwd });
		const cwd = options?.cwd ?? "";
		if (command === "git" && args[0] === "worktree" && args[1] === "add") {
			const worktreePath = args[args.length - 2] || args[args.length - 1];
			if (worktreePath) {
				const bareRepoPath = options?.cwd;
				if (bareRepoPath) {
					const sourceSkillsDir = path.join(bareRepoPath, ".mock-source", ".pi", "skills");
					const sourceSettingsPath = path.join(bareRepoPath, ".mock-source", ".pi", "settings.json");
					if (existsSync(sourceSkillsDir)) {
						mkdirSync(path.join(worktreePath, ".pi", "skills"), { recursive: true });
						for (const skillName of readdirSync(sourceSkillsDir)) {
							const sourceFile = path.join(sourceSkillsDir, skillName, "SKILL.md");
							if (existsSync(sourceFile)) {
								mkdirSync(path.join(worktreePath, ".pi", "skills", skillName), { recursive: true });
								if (statSync(sourceFile).isDirectory()) {
									mkdirSync(path.join(worktreePath, ".pi", "skills", skillName, "SKILL.md"), { recursive: true });
								} else {
									writeFileSync(path.join(worktreePath, ".pi", "skills", skillName, "SKILL.md"), readFileSync(sourceFile, "utf-8"));
								}
							}
						}
					}
					if (existsSync(sourceSettingsPath)) {
						mkdirSync(path.join(worktreePath, ".pi"), { recursive: true });
						writeFileSync(path.join(worktreePath, ".pi", "settings.json"), readFileSync(sourceSettingsPath, "utf-8"));
					}
				}
				setFiles.add(worktreePath);
			}
		}
		return { stdout: "", stderr: "" };
	};
	return { runner, calls, setFiles };
}

describe("parseSkillFile", () => {
	it("parses YAML frontmatter and body", () => {
		const content = "---\nname: test-skill\ndescription: A test\n---\n\n# Body\n";
		const parsed = parseSkillFile(content);
		expect(parsed.name).toBe("test-skill");
		expect(parsed.description).toBe("A test");
		expect(parsed.body).toBe("# Body\n");
	});

	it("returns empty metadata when no frontmatter", () => {
		const parsed = parseSkillFile("# Just body");
		expect(parsed.name).toBe("");
		expect(parsed.description).toBe("");
		expect(parsed.body).toBe("# Just body");
	});

	it("parses folded block scalar description", () => {
		const content = "---\nname: my-skill\ndescription: >\n  Line one\n  Line two\n---\n\nBody";
		const parsed = parseSkillFile(content);
		expect(parsed.name).toBe("my-skill");
		expect(parsed.description).toBe("Line one Line two");
		expect(parsed.body).toBe("Body");
	});

	it("parses literal block scalar description", () => {
		const content = "---\nname: my-skill\ndescription: |\n  Line one\n  Line two\n---\n\nBody";
		const parsed = parseSkillFile(content);
		expect(parsed.description).toBe("Line one\nLine two");
	});

	it("parses folded block scalar with blank line as paragraph separator", () => {
		const content = "---\nname: my-skill\ndescription: >\n  Para one\n\n  Para two\n---\n\nBody";
		const parsed = parseSkillFile(content);
		expect(parsed.description).toBe("Para one\n\nPara two");
	});

	it("parses block scalar with strip modifier", () => {
		const content = "---\nname: my-skill\ndescription: |-\n  Line one\n  Line two\n---\n\nBody";
		const parsed = parseSkillFile(content);
		expect(parsed.description).toBe("Line one\nLine two");
	});

	it("parses block scalar with keep modifier", () => {
		const content = "---\nname: my-skill\ndescription: |+\n  Line one\n  Line two\n---\n\nBody";
		const parsed = parseSkillFile(content);
		expect(parsed.description).toBe("Line one\nLine two\n");
	});

	it("parses empty block scalar description", () => {
		const content = "---\nname: my-skill\ndescription: >\n---\n\nBody";
		const parsed = parseSkillFile(content);
		expect(parsed.description).toBe("");
	});

	it("ignores unindented lines after block scalar", () => {
		const content = "---\nname: my-skill\ndescription: >\n  Line one\nunrelated: value\n---\n\nBody";
		const parsed = parseSkillFile(content);
		expect(parsed.description).toBe("Line one");
		expect(parsed.body).toBe("Body");
	});

	it("handles missing closing delimiter", () => {
		const parsed = parseSkillFile("---\nname: x\n# body");
		expect(parsed.name).toBe("");
		expect(parsed.body).toBe("---\nname: x\n# body");
	});
});

describe("buildSkillFile", () => {
	it("builds a skill file with frontmatter", () => {
		const result = buildSkillFile("my-skill", "My desc", "# Content");
		expect(result).toContain("name: my-skill");
		expect(result).toContain("description: My desc");
		expect(result).toContain("# Content");
	});

	it("emits multi-line descriptions as literal block scalars", () => {
		const result = buildSkillFile("my-skill", "Line one\nLine two", "# Content");
		expect(result).toContain("description: |");
		expect(result).toContain("  Line one");
		expect(result).toContain("  Line two");
	});
});

describe("RepoSkillService", () => {
	let service: RepoSkillService;
	let mock: ReturnType<typeof makeMockRunner>;

	beforeEach(() => {
		try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
		mkdirSync(TEST_DIR, { recursive: true });
		mock = makeMockRunner();
		service = new RepoSkillService(
			{ workspacesDir: TEST_DIR, githubUsername: "testuser", githubToken: "token", defaultBranch: "main" },
			mock.runner,
		);
	});

	afterEach(() => {
		try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	it("listRepoSkills reads from a checked-out worktree", async () => {
		const bareRepo = path.join(TEST_DIR, "owner-repo");
		mkdirSync(path.join(bareRepo, ".mock-source", ".pi", "skills", "skill-a"), { recursive: true });
		writeFileSync(path.join(bareRepo, ".mock-source", ".pi", "skills", "skill-a", "SKILL.md"), buildSkillFile("skill-a", "Desc A", "Body A"));
		mkdirSync(path.join(bareRepo, ".mock-source", ".pi", "skills", "skill-b"), { recursive: true });
		writeFileSync(path.join(bareRepo, ".mock-source", ".pi", "skills", "skill-b", "SKILL.md"), buildSkillFile("skill-b", "Desc B", "Body B"));

		const skills = await service.listRepoSkills("owner", "repo");
		expect(skills.length).toBe(2);
	});

	it("getRepoSkill returns null when missing", async () => {
		const found = await service.getRepoSkill("owner", "repo", "missing");
		expect(found).toBeNull();
	});

	it("getRepoSkill reads a skill file", async () => {
		const bareRepo = path.join(TEST_DIR, "owner-repo");
		mkdirSync(path.join(bareRepo, ".mock-source", ".pi", "skills", "found"), { recursive: true });
		writeFileSync(path.join(bareRepo, ".mock-source", ".pi", "skills", "found", "SKILL.md"), buildSkillFile("found", "Found desc", "Found body"));

		const skill = await service.getRepoSkill("owner", "repo", "found");
		expect(skill).not.toBeNull();
		expect(skill!.name).toBe("found");
		expect(skill!.description).toBe("Found desc");
		expect(skill!.content).toBe("Found body");
	});

	it("saveRepoSkill creates skill directory and pushes", async () => {
		const result = await service.saveRepoSkill("owner", "repo", {
			name: "new-skill",
			description: "New desc",
			content: "New body",
		});
		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
	
		const commitCalls = mock.calls.filter((c) => c.command === "git" && c.args[0] === "commit");
		expect(commitCalls.length).toBeGreaterThan(0);
		expect(commitCalls[0].args[2]).toContain("update skill new-skill");
	});

	it("saveRepoSkill does not modify settings.json", async () => {
		const bareRepo = path.join(TEST_DIR, "owner-repo");
		mkdirSync(path.join(bareRepo, ".mock-source", ".pi"), { recursive: true });
		writeFileSync(
			path.join(bareRepo, ".mock-source", ".pi", "settings.json"),
			JSON.stringify({ skills: ["existing-skill", 123, "new-skill"] }),
		);
		let capturedSettings = "";
		const inspectRunner: CommandRunner = async (command, args, options) => {
			await mock.runner(command, args, options);
			if (command === "git" && args[0] === "add" && options?.cwd) {
				capturedSettings = readFileSync(path.join(options.cwd, ".pi", "settings.json"), "utf-8");
			}
			return { stdout: "", stderr: "" };
		};
		const inspectService = new RepoSkillService(
			{ workspacesDir: TEST_DIR, githubUsername: "testuser", githubToken: "token", defaultBranch: "main" },
			inspectRunner,
		);

		const result = await inspectService.saveRepoSkill("owner", "repo", {
			name: "new-skill",
			description: "",
			content: "body",
		});
		expect(result.success).toBe(true);
		expect(JSON.parse(capturedSettings)).toEqual({ skills: ["existing-skill", 123, "new-skill"] });
	});

	it("saveRepoSkill returns error on git failure", async () => {
		const failingService = new RepoSkillService(
			{ workspacesDir: TEST_DIR, githubUsername: "u", githubToken: "t", defaultBranch: "main" },
			async () => { throw new Error("git failed"); },
		);
		const result = await failingService.saveRepoSkill("owner", "repo", {
			name: "fail",
			description: "",
			content: "body",
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("git failed");
	});

	it("deleteRepoSkill returns error on git failure", async () => {
		const failingService = new RepoSkillService(
			{ workspacesDir: TEST_DIR, githubUsername: "u", githubToken: "t", defaultBranch: "main" },
			async () => { throw new Error("git failed"); },
		);
		const result = await failingService.deleteRepoSkill("owner", "repo", "missing");
		expect(result.success).toBe(false);
		expect(result.error).toContain("git failed");
	});

	it("saveRepoSkill returns error on string throw", async () => {
		const failingService = new RepoSkillService(
			{ workspacesDir: TEST_DIR, githubUsername: "u", githubToken: "t", defaultBranch: "main" },
			async () => { throw "string failure"; },
		);
		const result = await failingService.saveRepoSkill("owner", "repo", {
			name: "fail",
			description: "",
			content: "body",
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("string failure");
	});

	it("deleteRepoSkill returns error on string throw", async () => {
		const failingService = new RepoSkillService(
			{ workspacesDir: TEST_DIR, githubUsername: "u", githubToken: "t", defaultBranch: "main" },
			async () => { throw "string failure"; },
		);
		const result = await failingService.deleteRepoSkill("owner", "repo", "missing");
		expect(result.success).toBe(false);
		expect(result.error).toContain("string failure");
	});

	it("deleteRepoSkill succeeds when skill dir does not exist", async () => {
		const result = await service.deleteRepoSkill("owner", "repo", "nonexistent");
		expect(result.success).toBe(true);
	});

	it("listRepoSkills returns empty when skills dir missing", async () => {
		const skills = await service.listRepoSkills("owner", "repo");
		expect(skills).toEqual([]);
	});

	it("listRepoSkills skips unreadable skill files", async () => {
		const bareRepo = path.join(TEST_DIR, "owner-repo");
		mkdirSync(path.join(bareRepo, ".mock-source", ".pi", "skills", "broken", "SKILL.md"), { recursive: true });

		const skills = await service.listRepoSkills("owner", "repo");
		expect(skills).toEqual([]);
	});

	it("listRepoSkills skips non-directories and missing SKILL.md", async () => {
		const bareRepo = path.join(TEST_DIR, "owner-repo");
		mkdirSync(path.join(bareRepo, ".mock-source", ".pi", "skills"), { recursive: true });
		writeFileSync(path.join(bareRepo, ".mock-source", ".pi", "skills", "not-a-dir.md"), "ignored");
		mkdirSync(path.join(bareRepo, ".mock-source", ".pi", "skills", "no-skill-file"), { recursive: true });

		const skills = await service.listRepoSkills("owner", "repo");
		expect(skills).toEqual([]);
	});

	it("getRepoSkill returns null for invalid skill file", async () => {
		const bareRepo = path.join(TEST_DIR, "owner-repo");
		mkdirSync(path.join(bareRepo, ".mock-source", ".pi", "skills", "bad"), { recursive: true });
		writeFileSync(path.join(bareRepo, ".mock-source", ".pi", "skills", "bad", "SKILL.md"), "");
		const skill = await service.getRepoSkill("owner", "repo", "bad");
		expect(skill).not.toBeNull();
		expect(skill!.name).toBe("bad");
	});

	it("getRepoSkill returns null when the skill file cannot be read", async () => {
		const bareRepo = path.join(TEST_DIR, "owner-repo");
		mkdirSync(path.join(bareRepo, ".mock-source", ".pi", "skills", "broken", "SKILL.md"), { recursive: true });

		const skill = await service.getRepoSkill("owner", "repo", "broken");
		expect(skill).toBeNull();
	});
});
