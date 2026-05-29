/**
 * Tests for skill-optimizer.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { SkillOptimizer } from "./skill-optimizer.js";
import { DEFAULT_OPTIMIZER_CONFIG } from "./types.js";
import type { SessionLogEntry } from "../logging/session-log-store.js";

function createTempDir(): string {
	return mkdtempSync(path.join(tmpdir(), "skill-opt-test-"));
}

describe("SkillOptimizer.buildOptimizationPrompt", () => {
	const optimizer = new SkillOptimizer();

	it("includes skill content and metrics", () => {
		const prompt = optimizer.buildOptimizationPrompt({
			skill: {
				name: "pdf-tools",
				description: "PDF processing.",
				filePath: "/workspace/.pi/skills/pdf-tools/SKILL.md",
				baseDir: "/workspace/.pi/skills/pdf-tools",
				content: "---\nname: pdf-tools\ndescription: PDF processing.\n---\n# PDF Tools",
				frontmatter: {},
			},
			metrics: {
				skillName: "pdf-tools",
				workspacePath: "/workspace",
				totalInvocations: 5,
				successfulInvocations: 2,
				failedInvocations: 3,
				lastUsedAt: "2026-05-01T00:00:00Z",
				scores: [0.5, 0, 1, 0.5, 0],
				averageScore: 0.4,
				decayedScore: 0.35,
			},
			config: DEFAULT_OPTIMIZER_CONFIG,
			previousEdits: [],
		});

		expect(prompt).toContain("pdf-tools");
		expect(prompt).toContain("Average rollout score: 40%");
		expect(prompt).toContain("# PDF Tools");
		expect(prompt).toContain("EDIT_TYPE:");
	});
});

describe("SkillOptimizer.parseBoundedEdits", () => {
	const optimizer = new SkillOptimizer();

	it("parses a single bounded edit", () => {
		const response = [
			"I'll fix the description.",
			"",
			"EDIT_TYPE: description",
			"REASON: Make it more specific",
			"OLD_TEXT:",
			"description: PDF processing.",
			"NEW_TEXT:",
			"description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs.",
			"---",
		].join("\n");

		const edits = optimizer.parseBoundedEdits(response);
		expect(edits).toHaveLength(1);
		expect(edits[0]?.type).toBe("description");
		expect(edits[0]?.reason).toBe("Make it more specific");
		expect(edits[0]?.oldText).toBe("description: PDF processing.");
	});

	it("parses multiple edits", () => {
		const response = [
			"EDIT_TYPE: description",
			"REASON: Rationale 1",
			"OLD_TEXT:",
			"old desc",
			"NEW_TEXT:",
			"new desc",
			"---",
			"EDIT_TYPE: instructions",
			"REASON: Rationale 2",
			"OLD_TEXT:",
			"old instruction",
			"NEW_TEXT:",
			"new instruction",
		].join("\n");

		const edits = optimizer.parseBoundedEdits(response);
		expect(edits).toHaveLength(2);
		expect(edits[0]?.type).toBe("description");
		expect(edits[1]?.type).toBe("instructions");
	});

	it("returns empty array when no EDIT_TYPE markers", () => {
		const edits = optimizer.parseBoundedEdits("No edits here.");
		expect(edits).toHaveLength(0);
	});

	it("handles edits with no oldText", () => {
		const response = [
			"EDIT_TYPE: instructions",
			"REASON: Add new section",
			"OLD_TEXT:",
			"",
			"NEW_TEXT:",
			"New section content",
			"---",
		].join("\n");

		const edits = optimizer.parseBoundedEdits(response);
		expect(edits).toHaveLength(1);
		expect(edits[0]?.oldText).toBe("");
		expect(edits[0]?.newText).toBe("New section content");
	});
});

describe("SkillOptimizer.isEditBounded", () => {
	const optimizer = new SkillOptimizer({ ...DEFAULT_OPTIMIZER_CONFIG, maxEditPercentage: 50 });

	it("accepts a simple description edit", () => {
		const skill = {
			name: "pdf-tools",
			description: "PDF processing.",
			filePath: "/x/SKILL.md",
			baseDir: "/x",
			content: "---\nname: pdf-tools\ndescription: PDF processing.\n---\n# PDF Tools",
			frontmatter: {},
		};

		const edit = {
			type: "description" as const,
			reason: "Improve specificity",
			oldText: "description: PDF processing.",
			newText: "description: Extracts text and tables from PDF files.",
		};

		expect(optimizer.isEditBounded(skill, edit)).toBe(true);
	});

	it("rejects an edit whose oldText is not in the skill", () => {
		const skill = {
			name: "pdf-tools",
			description: "PDF processing.",
			filePath: "/x/SKILL.md",
			baseDir: "/x",
			content: "---\nname: pdf-tools\n---\n",
			frontmatter: {},
		};

		const edit = {
			type: "description" as const,
			reason: "x",
			oldText: "not present",
			newText: "still not present",
		};

		expect(optimizer.isEditBounded(skill, edit)).toBe(false);
	});

	it("rejects frontmatter edit outside frontmatter block", () => {
		const skill = {
			name: "pdf-tools",
			description: "PDF processing.",
			filePath: "/x/SKILL.md",
			baseDir: "/x",
			content: "---\nname: pdf-tools\n---\n# Body\ndescription: something",
			frontmatter: {},
		};

		const edit = {
			type: "frontmatter" as const,
			reason: "x",
			oldText: "description: something",
			newText: "description: edited",
		};

		expect(optimizer.isEditBounded(skill, edit)).toBe(false);
	});

	it("rejects instruction edit inside a code block", () => {
		const skill = {
			name: "pdf-tools",
			description: "PDF processing.",
			filePath: "/x/SKILL.md",
			baseDir: "/x",
			content: [
				"---",
				"name: pdf-tools",
				"---",
				"# Setup",
				"```bash",
				"npm install",
				"```",
			].join("\n"),
			frontmatter: {},
		};

		const edit = {
			type: "instructions" as const,
			reason: "x",
			oldText: "npm install",
			newText: "yarn install",
		};

		expect(optimizer.isEditBounded(skill, edit)).toBe(false);
	});

	it("rejects edits exceeding maxEditPercentage", () => {
		const strictOptimizer = new SkillOptimizer({ ...DEFAULT_OPTIMIZER_CONFIG, maxEditPercentage: 5 });
		const skill = {
			name: "pdf-tools",
			description: "PDF processing.",
			filePath: "/x/SKILL.md",
			baseDir: "/x",
			content: "---\nname: pdf-tools\ndescription: PDF processing.\n---\n# PDF Tools\n\nShort.\n",
			frontmatter: {},
		};

		const edit = {
			type: "instructions" as const,
			reason: "x",
			oldText: "Short.",
			newText: "This is a very long replacement text that spans multiple lines\nand dramatically changes the file size beyond the allowed percentage.",
		};

		expect(strictOptimizer.isEditBounded(skill, edit)).toBe(false);
	});
});

describe("SkillOptimizer.applyEdits", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("applies a single edit to a file", async () => {
		const filePath = path.join(tempDir, "SKILL.md");
		const original = ["---", "name: x", "---", "", "# Old", "text"].join("\n");
		writeFileSync(filePath, original, "utf-8");

		const optimizer = new SkillOptimizer();
		await optimizer.applyEdits(filePath, [
			{
				type: "instructions",
				reason: "Update",
				oldText: "# Old\ntext",
				newText: "# New\ncontent",
			},
		]);

		const updated = readFileSync(filePath, "utf-8");
		expect(updated).toContain("# New");
		expect(updated).toContain("content");
		expect(updated).not.toContain("# Old");
	});

	it("applies multiple edits sequentially", async () => {
		const filePath = path.join(tempDir, "SKILL.md");
		const original = ["---", "name: x", "---", "", "Line A", "Line B"].join("\n");
		writeFileSync(filePath, original, "utf-8");

		const optimizer = new SkillOptimizer();
		await optimizer.applyEdits(filePath, [
			{
				type: "instructions",
				reason: "Update A",
				oldText: "Line A",
				newText: "Line Alpha",
			},
			{
				type: "instructions",
				reason: "Update B",
				oldText: "Line B",
				newText: "Line Beta",
			},
		]);

		const updated = readFileSync(filePath, "utf-8");
		expect(updated).toContain("Line Alpha");
		expect(updated).toContain("Line Beta");
	});

	it("throws when oldText is not found", async () => {
		const filePath = path.join(tempDir, "SKILL.md");
		writeFileSync(filePath, "content", "utf-8");

		const optimizer = new SkillOptimizer();
		await expect(
			optimizer.applyEdits(filePath, [
				{
					type: "instructions",
					reason: "x",
					oldText: "missing",
					newText: "replacement",
				},
			]),
		).rejects.toThrow("oldText not found");
	});
});

describe("SkillOptimizer.iterate", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns metrics when skill performs above threshold", async () => {
		const skillsDir = path.join(tempDir, ".pi", "skills");
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(
			path.join(skillsDir, "good-skill.md"),
			"---\nname: good-skill\ndescription: A good skill.\n---\n# Good Skill",
			"utf-8",
		);

		const optimizer = new SkillOptimizer({ ...DEFAULT_OPTIMIZER_CONFIG, minScoreThreshold: 0.5 });

		// Simulate successful rollouts
		const logs: SessionLogEntry[] = [];
		for (let i = 0; i < 5; i++) {
			logs.push({
				timestamp: `2026-05-01T00:00:${String(i).padStart(2, "0")}Z`,
				level: "tool",
				message: "read",
				details: {
					type: "tool_execution_start",
					toolName: "read",
					args: { path: `${tempDir}/.pi/skills/good-skill.md` },
				},
			});
			logs.push({
				timestamp: `2026-05-01T00:00:${String(i).padStart(2, "0")}Z`,
				level: "tool",
				message: "bash done",
				details: {
					type: "tool_execution_end",
					toolName: "bash",
					isError: false,
				},
			});
		}

		const results = await optimizer.iterate(tempDir, logs);
		expect(results).toHaveLength(1);
		expect(results[0]?.skillName).toBe("good-skill");
		expect(results[0]?.applied).toBe(false);
		expect(results[0]?.metricsAfter.averageScore).toBeGreaterThanOrEqual(0.5);
	});

	it("triggers optimization when skill is underperforming", async () => {
		const skillsDir = path.join(tempDir, ".pi", "skills");
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(
			path.join(skillsDir, "bad-skill.md"),
			"---\nname: bad-skill\ndescription: A bad skill.\n---\n# Bad Skill",
			"utf-8",
		);

		const optimizer = new SkillOptimizer({ ...DEFAULT_OPTIMIZER_CONFIG, minScoreThreshold: 0.9 });

		// Simulate failed rollouts
		const logs: SessionLogEntry[] = [
			{
				timestamp: "2026-05-01T00:00:00Z",
				level: "tool",
				message: "read",
				details: {
					type: "tool_execution_start",
					toolName: "read",
					args: { path: `${tempDir}/.pi/skills/bad-skill.md` },
				},
			},
			{
				timestamp: "2026-05-01T00:00:01Z",
				level: "tool",
				message: "bash error",
				details: {
					type: "tool_execution_end",
					toolName: "bash",
					isError: true,
				},
			},
		];

		const optimizeFn = async (prompt: string): Promise<string> => {
			expect(prompt).toContain("bad-skill");
			return [
				"EDIT_TYPE: description",
				"REASON: Improve clarity",
				"OLD_TEXT:",
				"description: A bad skill.",
				"NEW_TEXT:",
				"description: A clarified skill with precise instructions.",
			].join("\n");
		};

		const results = await optimizer.iterate(tempDir, logs, optimizeFn);
		expect(results).toHaveLength(1);
		expect(results[0]?.skillName).toBe("bad-skill");
		expect(results[0]?.applied).toBe(true);
		expect(results[0]?.edits).toHaveLength(1);
		expect(results[0]?.edits[0]?.oldText).toBe("description: A bad skill.");
	});

	it("skips optimization when optimizeFn is not provided", async () => {
		const skillsDir = path.join(tempDir, ".pi", "skills");
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(
			path.join(skillsDir, "idle-skill.md"),
			"---\nname: idle-skill\ndescription: Idle.\n---\n# Idle",
			"utf-8",
		);

		const optimizer = new SkillOptimizer();
		const results = await optimizer.iterate(tempDir, []);
		expect(results).toHaveLength(1);
		expect(results[0]?.applied).toBe(false);
	});

	it("handles missing skills gracefully", async () => {
		const optimizer = new SkillOptimizer();
		const results = await optimizer.iterate(tempDir, []);
		expect(results).toHaveLength(0);
	});

	it("handles LLM failure gracefully", async () => {
		const skillsDir = path.join(tempDir, ".pi", "skills");
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(
			path.join(skillsDir, " fragile-skill.md"),
			"---\nname: fragile-skill\ndescription: Fragile.\n---\n# Fragile",
			"utf-8",
		);

		const optimizer = new SkillOptimizer({ ...DEFAULT_OPTIMIZER_CONFIG, minScoreThreshold: 0.9 });
		const logs: SessionLogEntry[] = [
			{
				timestamp: "2026-05-01T00:00:00Z",
				level: "tool",
				message: "read",
				details: {
					type: "tool_execution_start",
					toolName: "read",
					args: { path: `${tempDir}/.pi/skills/fragile-skill.md` },
				},
			},
			{
				timestamp: "2026-05-01T00:00:01Z",
				level: "tool",
				message: "bash error",
				details: {
					type: "tool_execution_end",
					toolName: "bash",
					isError: true,
				},
			},
		];

		const optimizeFn = async (): Promise<string> => {
			throw new Error("LLM timeout");
		};

		const results = await optimizer.iterate(tempDir, logs, optimizeFn);
		expect(results).toHaveLength(1);
		expect(results[0]?.applied).toBe(false);
	});
});
