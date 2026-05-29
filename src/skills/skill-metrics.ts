/**
 * Skill metrics tracking and rollout scoring.
 *
 * Core assumptions:
 * - Skill usage is inferred from session logs: the agent reads SKILL.md or invokes tools
 *   that belong to a skill directory.
 * - A "rollout" is a single agent turn where a skill is loaded and then tools execute.
 * - Rollout score is derived from the ratio of successful to total tool calls in that turn.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
	SkillDefinition,
	SkillMetricsRecord,
	SkillToolCall,
	SkillInvocation,
	SkillOptimizerConfig,
} from "./types.js";
import { DEFAULT_OPTIMIZER_CONFIG } from "./types.js";
import type { SessionLogEntry } from "../logging/session-log-store.js";

const SKILL_DIR_NAMES = [".pi/skills", ".agents/skills"];
const SKILL_FILE = "SKILL.md";

export class SkillMetricsCollector {
	constructor(private readonly config: SkillOptimizerConfig = DEFAULT_OPTIMIZER_CONFIG) {}

	/**
	 * Discover all skills under a workspace path.
	 * Scans .pi/skills/ and .agents/skills/ directories.
	 */
	async discoverSkills(workspacePath: string): Promise<SkillDefinition[]> {
		const skills: SkillDefinition[] = [];
		for (const dirName of SKILL_DIR_NAMES) {
			const dirPath = path.join(workspacePath, dirName);
			try {
				const entries = await readdir(dirPath, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isFile() && entry.name.endsWith(".md")) {
						// Root-level .md files in .pi/skills/ are individual skills
						const filePath = path.join(dirPath, entry.name);
						const content = await readFile(filePath, "utf-8");
						const parsed = this.parseSkillContent(content, filePath, dirPath);
						if (parsed) skills.push({ ...parsed, baseDir: dirPath });
					} else if (entry.isDirectory()) {
						// Subdirectories containing SKILL.md
						const skillFile = path.join(dirPath, entry.name, SKILL_FILE);
						try {
							await stat(skillFile);
							const content = await readFile(skillFile, "utf-8");
							const parsed = this.parseSkillContent(content, skillFile, path.join(dirPath, entry.name));
							if (parsed) skills.push(parsed);
						} catch {
							// no SKILL.md in directory; skip
						}
					}
				}
			} catch {
				// skill directory doesn't exist; skip
			}
		}
		return skills;
	}

	/**
	 * Parse frontmatter and content from a SKILL.md file.
	 */
	parseSkillContent(content: string, filePath: string, baseDir: string): SkillDefinition | null {
		const frontmatterMatch = /^---\n([\s\S]*?)\n---\n?/.exec(content);
		if (!frontmatterMatch) return null;

		const frontmatterText = frontmatterMatch[1];
		const frontmatter: Record<string, unknown> = {};
		for (const line of frontmatterText.split("\n")) {
			const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line.trim());
			if (match) {
				const [, key, value] = match;
				frontmatter[key] = value;
			}
		}

		const name = String(frontmatter.name || "").trim();
		const description = String(frontmatter.description || "").trim();
		if (!name || !description) return null;

		return {
			name,
			description,
			filePath,
			baseDir,
			content,
			frontmatter,
		};
	}

	/**
	 * Compute metrics from session logs.
	 *
	 * Heuristic: detect skill usage by looking for `read` tool calls on SKILL.md files,
	 * or any mention of `/skill:` in assistant messages. Then aggregate subsequent
	 * tool_execution_end events within a time window as belonging to that rollout.
	 */
	computeMetrics(
		workspacePath: string,
		sessionLogs: SessionLogEntry[],
	): Map<string, SkillMetricsRecord> {
		const invocations = this.extractInvocations(workspacePath, sessionLogs);
		const records = new Map<string, SkillMetricsRecord>();

		for (const inv of invocations) {
			let record = records.get(inv.skillName);
			if (!record) {
				record = {
					skillName: inv.skillName,
					workspacePath,
					totalInvocations: 0,
					successfulInvocations: 0,
					failedInvocations: 0,
					lastUsedAt: null,
					scores: [],
					averageScore: 0,
					decayedScore: 0,
				};
				records.set(inv.skillName, record);
			}

			record.totalInvocations += 1;
			if (inv.outcome === "success") {
				record.successfulInvocations += 1;
			} else if (inv.outcome === "failure") {
				record.failedInvocations += 1;
			}
			if (inv.timestamp && (!record.lastUsedAt || inv.timestamp > record.lastUsedAt)) {
				record.lastUsedAt = inv.timestamp;
			}

			const score = this.scoreRollout(inv);
			record.scores.push(score);
		}

		for (const record of records.values()) {
			record.averageScore = this.computeAverageScore(record.scores);
			record.decayedScore = this.computeDecayedScore(record.scores, this.config.decayFactor);
			// Keep only the most recent window
			if (record.scores.length > this.config.rolloutWindowSize) {
				record.scores = record.scores.slice(-this.config.rolloutWindowSize);
			}
		}

		return records;
	}

	/**
	 * Extract skill invocations from session logs.
	 *
	 * Uses two signals:
	 * 1. tool_execution_start where toolName === "read" and args include a path ending in SKILL.md
	 * 2. assistant messages mentioning /skill:
	 *
	 * After detecting skill usage, we look at subsequent tool_execution_end events
	 * in the same session to determine the outcome.
	 */
	extractInvocations(workspacePath: string, sessionLogs: SessionLogEntry[]): SkillInvocation[] {
		const invocations: SkillInvocation[] = [];
		let currentInvocation: SkillInvocation | null = null;

		for (const entry of sessionLogs) {
			if (entry.details?.type === "tool_execution_start" && entry.details.toolName === "read" && entry.details.args) {
				const args = entry.details.args as Record<string, unknown>;
				const pathArg = String(args.path || "");
				if (this.isSkillRead(pathArg, workspacePath)) {
					const skillName = this.inferSkillNameFromPath(pathArg);
					if (currentInvocation) {
						invocations.push(this.finalizeInvocation(currentInvocation));
					}
					currentInvocation = {
						skillName,
						timestamp: entry.timestamp,
						outcome: "unknown",
						toolCalls: [],
					};
				}
			}

			if (entry.level === "assistant" && entry.message) {
				const skillMatch = /\/skill:([a-z0-9-]+)/g.exec(entry.message);
				if (skillMatch && entry.details?.type === "response") {
					const skillName = skillMatch[1];
					if (currentInvocation?.skillName !== skillName) {
						if (currentInvocation) {
							invocations.push(this.finalizeInvocation(currentInvocation));
						}
						currentInvocation = {
							skillName,
							timestamp: entry.timestamp,
							outcome: "unknown",
							toolCalls: [],
						};
					}
				}
			}

			if (
				entry.details?.type === "tool_execution_end" &&
				currentInvocation &&
				entry.details.toolName &&
				typeof entry.details.toolName === "string"
			) {
				const toolCall: SkillToolCall = {
					toolName: entry.details.toolName as string,
					success: !entry.details.isError,
					timestamp: entry.timestamp,
				};
				currentInvocation.toolCalls.push(toolCall);
			}

			if (
				entry.level === "error" &&
				currentInvocation &&
				currentInvocation.outcome === "unknown"
			) {
				currentInvocation.outcome = "failure";
				currentInvocation.errorMessage = entry.message;
			}
		}

		if (currentInvocation) {
			invocations.push(this.finalizeInvocation(currentInvocation));
		}

		return invocations;
	}

	private isSkillRead(filePath: string, workspacePath: string): boolean {
		if (!filePath.includes(workspacePath)) return false;
		// Must be in a skills directory
		if (!filePath.includes("/skills/")) return false;
		// Root .md files in skills dir, or SKILL.md in subdirectories
		if (filePath.endsWith(".md")) return true;
		return false;
	}

	private inferSkillNameFromPath(filePath: string): string {
		const base = path.basename(filePath, ".md");
		if (base === "SKILL") {
			// Use parent directory name
			return path.basename(path.dirname(filePath));
		}
		return base;
	}

	private finalizeInvocation(inv: SkillInvocation): SkillInvocation {
		if (inv.outcome === "unknown") {
			const total = inv.toolCalls.length;
			const successes = inv.toolCalls.filter((t) => t.success).length;
			if (total > 0) {
				inv.outcome = successes / total >= 0.5 ? "success" : "failure";
			}
		}
		return { ...inv };
	}

	/**
	 * Score an individual rollout.
	 * Returns a value between 0 and 1.
	 */
	scoreRollout(invocation: SkillInvocation): number {
		const calls = invocation.toolCalls;
		if (calls.length === 0) {
			return invocation.outcome === "success" ? 1 : invocation.outcome === "failure" ? 0 : 0.5;
		}
		const successes = calls.filter((c) => c.success).length;
		return successes / calls.length;
	}

	/**
	 * Compute simple average score.
	 */
	computeAverageScore(scores: number[]): number {
		if (scores.length === 0) return 0;
		return scores.reduce((a, b) => a + b, 0) / scores.length;
	}

	/**
	 * Compute exponentially decayed score so recent rollouts matter more.
	 */
	computeDecayedScore(scores: number[], decay: number): number {
		if (scores.length === 0) return 0;
		let totalWeight = 0;
		let weightedSum = 0;
		for (let i = 0; i < scores.length; i++) {
			const weight = Math.pow(decay, scores.length - 1 - i);
			weightedSum += scores[i] * weight;
			totalWeight += weight;
		}
		return totalWeight > 0 ? weightedSum / totalWeight : 0;
	}
}
