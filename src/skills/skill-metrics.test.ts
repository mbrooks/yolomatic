/**
 * Tests for skill-metrics.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { SkillMetricsCollector } from "./skill-metrics.js";
import { DEFAULT_OPTIMIZER_CONFIG } from "./types.js";
import type { SessionLogEntry } from "../logging/session-log-store.js";

function createTempDir(): string {
	return mkdtempSync(path.join(tmpdir(), "skill-metrics-test-"));
}

function writeSkill(baseDir: string, name: string, content: string): void {
	mkdirSync(baseDir, { recursive: true });
	writeFileSync(path.join(baseDir, `${name}.md`), content);
}

function writeSkillDir(baseDir: string, dirName: string, content: string): void {
	const dir = path.join(baseDir, dirName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "SKILL.md"), content);
}

describe("SkillMetricsCollector.discoverSkills", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers root-level .md files in .pi/skills/", async () => {
		const skillsDir = path.join(tempDir, ".pi", "skills");
		writeSkill(skillsDir, "data-analysis", `---\nname: data-analysis\ndescription: Analyzes CSV data.\n---\n# Data Analysis`);

		const collector = new SkillMetricsCollector();
		const skills = await collector.discoverSkills(tempDir);

		expect(skills).toHaveLength(1);
		expect(skills[0]?.name).toBe("data-analysis");
		expect(skills[0]?.description).toBe("Analyzes CSV data.");
	});

	it("discovers subdirectory skills with SKILL.md", async () => {
		const skillsDir = path.join(tempDir, ".pi", "skills");
		writeSkillDir(skillsDir, "pdf-tools", `---\nname: pdf-tools\ndescription: PDF processing utilities.\n---\n# PDF Tools`);

		const collector = new SkillMetricsCollector();
		const skills = await collector.discoverSkills(tempDir);

		expect(skills).toHaveLength(1);
		expect(skills[0]?.name).toBe("pdf-tools");
	});

	it("ignores files without frontmatter", async () => {
		const skillsDir = path.join(tempDir, ".pi", "skills");
		writeSkill(skillsDir, "bad-skill", `# No frontmatter`);

		const collector = new SkillMetricsCollector();
		const skills = await collector.discoverSkills(tempDir);

		expect(skills).toHaveLength(0);
	});

	it("returns empty array when .pi/skills does not exist", async () => {
		const collector = new SkillMetricsCollector();
		const skills = await collector.discoverSkills(tempDir);
		expect(skills).toHaveLength(0);
	});
});

describe("SkillMetricsCollector.parseSkillContent", () => {
	it("parses frontmatter and content", () => {
		const collector = new SkillMetricsCollector();
		const result = collector.parseSkillContent(
			`---\nname: my-skill\ndescription: Does things.\n---\n\n# Instructions\nRun ./script.sh`,
			"/path/SKILL.md",
			"/path",
		);

		expect(result).not.toBeNull();
		expect(result?.name).toBe("my-skill");
		expect(result?.description).toBe("Does things.");
		expect(result?.content).toContain("# Instructions");
	});

	it("returns null when name is missing", () => {
		const collector = new SkillMetricsCollector();
		const result = collector.parseSkillContent(
			`---\ndescription: Does things.\n---\n`,
			"/path/SKILL.md",
			"/path",
		);
		expect(result).toBeNull();
	});

	it("returns null when description is missing", () => {
		const collector = new SkillMetricsCollector();
		const result = collector.parseSkillContent(
			`---\nname: my-skill\n---\n`,
			"/path/SKILL.md",
			"/path",
		);
		expect(result).toBeNull();
	});
});

describe("SkillMetricsCollector.extractInvocations", () => {
	it("detects skill read from tool_execution_start", () => {
		const collector = new SkillMetricsCollector();
		const workspacePath = "/workspace/issue-42";
		const logs: SessionLogEntry[] = [
			{
				timestamp: "2026-05-01T00:00:00Z",
				level: "tool",
				message: "read",
				details: {
					type: "tool_execution_start",
					toolName: "read",
					args: { path: `${workspacePath}/.pi/skills/data-analysis/SKILL.md` },
				},
			},
			{
				timestamp: "2026-05-01T00:00:01Z",
				level: "tool",
				message: "bash done",
				details: {
					type: "tool_execution_end",
					toolName: "bash",
					isError: false,
				},
			},
		];

		const invocations = collector.extractInvocations(workspacePath, logs);
		expect(invocations).toHaveLength(1);
		expect(invocations[0]?.skillName).toBe("data-analysis");
		expect(invocations[0]?.toolCalls).toHaveLength(1);
		expect(invocations[0]?.outcome).toBe("success");
	});

	it("detects skill invocation from /skill: in assistant message", () => {
		const collector = new SkillMetricsCollector();
		const logs: SessionLogEntry[] = [
			{
				timestamp: "2026-05-01T00:00:00Z",
				level: "assistant",
				message: "I'll use /skill:brave-search to find docs.",
				details: { type: "response", status: "working" },
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

		const invocations = collector.extractInvocations("/workspace", logs);
		expect(invocations).toHaveLength(1);
		expect(invocations[0]?.skillName).toBe("brave-search");
		expect(invocations[0]?.outcome).toBe("failure");
	});

	it("handles multiple invocations", () => {
		const collector = new SkillMetricsCollector();
		const logs: SessionLogEntry[] = [
			{
				timestamp: "2026-05-01T00:00:00Z",
				level: "tool",
				message: "read",
				details: {
					type: "tool_execution_start",
					toolName: "read",
					args: { path: "/workspace/.pi/skills/skill-a.md" },
				},
			},
			{
				timestamp: "2026-05-01T00:00:01Z",
				level: "tool",
				message: "read",
				details: {
					type: "tool_execution_start",
					toolName: "read",
					args: { path: "/workspace/.pi/skills/skill-b.md" },
				},
			},
		];

		const invocations = collector.extractInvocations("/workspace", logs);
		expect(invocations).toHaveLength(2);
		expect(invocations[0]?.skillName).toBe("skill-a");
		expect(invocations[1]?.skillName).toBe("skill-b");
	});

	it("ignores reads outside the workspace", () => {
		const collector = new SkillMetricsCollector();
		const logs: SessionLogEntry[] = [
			{
				timestamp: "2026-05-01T00:00:00Z",
				level: "tool",
				message: "read",
				details: {
					type: "tool_execution_start",
					toolName: "read",
					args: { path: "/other/.pi/skills/data-analysis/SKILL.md" },
				},
			},
		];

		const invocations = collector.extractInvocations("/workspace", logs);
		expect(invocations).toHaveLength(0);
	});
});

describe("SkillMetricsCollector.computeMetrics", () => {
	it("aggregates invocations into records", () => {
		const collector = new SkillMetricsCollector();
		const workspacePath = "/workspace";
		const logs: SessionLogEntry[] = [
			{
				timestamp: "2026-05-01T00:00:00Z",
				level: "tool",
				message: "read",
				details: {
					type: "tool_execution_start",
					toolName: "read",
					args: { path: `${workspacePath}/.pi/skills/pdf-tools/SKILL.md` },
				},
			},
			{
				timestamp: "2026-05-01T00:00:01Z",
				level: "tool",
				message: "bash done",
				details: {
					type: "tool_execution_end",
					toolName: "bash",
					isError: false,
				},
			},
			{
				timestamp: "2026-05-01T00:00:02Z",
				level: "tool",
				message: "read",
				details: {
					type: "tool_execution_start",
					toolName: "read",
					args: { path: `${workspacePath}/.pi/skills/pdf-tools/SKILL.md` },
				},
			},
			{
				timestamp: "2026-05-01T00:00:03Z",
				level: "tool",
				message: "bash error",
				details: {
					type: "tool_execution_end",
					toolName: "bash",
					isError: true,
				},
			},
		];

		const metrics = collector.computeMetrics(workspacePath, logs);
		const record = metrics.get("pdf-tools");
		expect(record).toBeDefined();
		expect(record?.totalInvocations).toBe(2);
		expect(record?.successfulInvocations).toBe(1);
		expect(record?.failedInvocations).toBe(1);
	});

	it("caps scores to rolloutWindowSize", () => {
		const config = { ...DEFAULT_OPTIMIZER_CONFIG, rolloutWindowSize: 3 };
		const collector = new SkillMetricsCollector(config);
		const workspacePath = "/workspace";
		const logs: SessionLogEntry[] = [];
		for (let i = 0; i < 5; i++) {
			logs.push({
				timestamp: `2026-05-01T00:00:${String(i).padStart(2, "0")}Z`,
				level: "tool",
				message: "read",
				details: {
					type: "tool_execution_start",
					toolName: "read",
					args: { path: `${workspacePath}/.pi/skills/skill-a.md` },
				},
			});
		}

		const metrics = collector.computeMetrics(workspacePath, logs);
		const record = metrics.get("skill-a");
		expect(record?.scores).toHaveLength(3);
	});

	it("returns empty map for empty logs", () => {
		const collector = new SkillMetricsCollector();
		const metrics = collector.computeMetrics("/workspace", []);
		expect(metrics.size).toBe(0);
	});
});

describe("SkillMetricsCollector scoring", () => {
	it("scoreRollout returns 1 for success with no tools", () => {
		const collector = new SkillMetricsCollector();
		const score = collector.scoreRollout({
			skillName: "x",
			timestamp: "2026-05-01T00:00:00Z",
			outcome: "success",
			toolCalls: [],
		});
		expect(score).toBe(1);
	});

	it("scoreRollout returns 0 for failure with no tools", () => {
		const collector = new SkillMetricsCollector();
		const score = collector.scoreRollout({
			skillName: "x",
			timestamp: "2026-05-01T00:00:00Z",
			outcome: "failure",
			toolCalls: [],
		});
		expect(score).toBe(0);
	});

	it("scoreRollout computes tool success ratio", () => {
		const collector = new SkillMetricsCollector();
		const score = collector.scoreRollout({
			skillName: "x",
			timestamp: "2026-05-01T00:00:00Z",
			outcome: "unknown",
			toolCalls: [
				{ toolName: "bash", success: true, timestamp: "2026-05-01T00:00:00Z" },
				{ toolName: "bash", success: false, timestamp: "2026-05-01T00:00:01Z" },
				{ toolName: "read", success: true, timestamp: "2026-05-01T00:00:02Z" },
			],
		});
		expect(score).toBeCloseTo(2 / 3);
	});

	it("computeAverageScore handles empty array", () => {
		const collector = new SkillMetricsCollector();
		expect(collector.computeAverageScore([])).toBe(0);
	});

	it("computeDecayedScore weights recent scores higher", () => {
		const collector = new SkillMetricsCollector();
		const scores = [0, 0, 1]; // oldest to newest
		const decayed = collector.computeDecayedScore(scores, 0.5);
		// weights: oldest=0.25, middle=0.5, newest=1.0
		// weightedSum = 0*0.25 + 0*0.5 + 1*1.0 = 1.0
		// totalWeight = 0.25 + 0.5 + 1.0 = 1.75
		expect(decayed).toBeCloseTo(1.0 / 1.75);
	});

	it("computeDecayedScore handles empty array", () => {
		const collector = new SkillMetricsCollector();
		expect(collector.computeDecayedScore([], 0.9)).toBe(0);
	});
});
