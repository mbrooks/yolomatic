/**
 * Skill optimization loop.
 *
 * Inspired by SkillOpt: skills are treated as optimizable parameters.
 * An external optimizer (an LLM prompt in this implementation) suggests
 * bounded edits to skill definitions based on scored rollouts.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	BoundedEdit,
	SkillDefinition,
	SkillMetricsRecord,
	SkillOptimizationResult,
	SkillOptimizerConfig,
} from "./types.js";
import { DEFAULT_OPTIMIZER_CONFIG } from "./types.js";
import { SkillMetricsCollector } from "./skill-metrics.js";
import type { SessionLogEntry } from "../logging/session-log-store.js";

export interface OptimizerPromptContext {
	skill: SkillDefinition;
	metrics: SkillMetricsRecord;
	config: SkillOptimizerConfig;
	previousEdits: BoundedEdit[];
}

export class SkillOptimizer {
	private readonly metricsCollector: SkillMetricsCollector;
	private iterationCount = new Map<string, number>();

	constructor(private readonly config: SkillOptimizerConfig = DEFAULT_OPTIMIZER_CONFIG) {
		this.metricsCollector = new SkillMetricsCollector(config);
	}

	/**
	 * Run one full optimization iteration for all skills in a workspace.
	 *
	 * Steps:
	 * 1. Discover skills
	 * 2. Compute metrics from session logs
	 * 3. For under-performing skills, generate optimization prompt
	 * 4. Parse bounded edits from LLM response
	 * 5. Apply edits if they satisfy constraints
	 */
	async iterate(
		workspacePath: string,
		sessionLogs: SessionLogEntry[],
		/** Optional LLM caller for the optimizer pass */
		optimizeFn?: (prompt: string) => Promise<string>,
	): Promise<SkillOptimizationResult[]> {
		const skills = await this.metricsCollector.discoverSkills(workspacePath);
		const metricsMap = this.metricsCollector.computeMetrics(workspacePath, sessionLogs);
		const results: SkillOptimizationResult[] = [];

		for (const skill of skills) {
			const metrics = metricsMap.get(skill.name) ?? {
				skillName: skill.name,
				workspacePath,
				totalInvocations: 0,
				successfulInvocations: 0,
				failedInvocations: 0,
				lastUsedAt: null,
				scores: [],
				averageScore: 0,
				decayedScore: 0,
			};

			const iteration = (this.iterationCount.get(skill.name) ?? 0) + 1;
			this.iterationCount.set(skill.name, iteration);

			// If skill is performing well and has been used recently, skip
			if (
				metrics.averageScore >= this.config.minScoreThreshold &&
				metrics.totalInvocations >= 3
			) {
				results.push({
					skillName: skill.name,
					metricsBefore: metrics,
					metricsAfter: metrics,
					edits: [],
					applied: false,
					iteration,
				});
				continue;
			}

			if (!optimizeFn) {
				// No optimizer available; just record metrics
				results.push({
					skillName: skill.name,
					metricsBefore: metrics,
					metricsAfter: metrics,
					edits: [],
					applied: false,
					iteration,
				});
				continue;
			}

			const prompt = this.buildOptimizationPrompt({
				skill,
				metrics,
				config: this.config,
				previousEdits: [], // TODO: load from persistent store
			});

			let llmResponse: string;
			try {
				llmResponse = await optimizeFn(prompt);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				results.push({
					skillName: skill.name,
					metricsBefore: metrics,
					metricsAfter: metrics,
					edits: [],
					applied: false,
					iteration,
				});
				process.stdout.write(`[skill-optimizer] LLM call failed for ${skill.name}: ${message}\n`);
				continue;
			}

			const edits = this.parseBoundedEdits(llmResponse);
			const validEdits = edits.filter((edit) => this.isEditBounded(skill, edit));

			let applied = false;
			if (validEdits.length > 0) {
				try {
					await this.applyEdits(skill.filePath, validEdits);
					applied = true;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(
						`[skill-optimizer] Failed to apply edits for ${skill.name}: ${message}\n`,
					);
				}
			}

			// Reload skill to reflect applied edits
			const refreshedContent = applied ? await readFile(skill.filePath, "utf-8") : skill.content;
			const newSkill: SkillDefinition = applied
				? { ...skill, content: refreshedContent }
				: skill;

			// Recompute metrics (they stay the same until next rollout)
			const metricsAfter: SkillMetricsRecord = { ...metrics };

			results.push({
				skillName: newSkill.name,
				metricsBefore: metrics,
				metricsAfter,
				edits: validEdits,
				applied,
				iteration,
			});
		}

		return results;
	}

	/**
	 * Build the optimization prompt sent to the LLM.
	 *
	 * Constraints are explicitly communicated so the LLM produces bounded edits:
	 * - Only edit description and instructions
	 * - Preserve frontmatter structure
	 * - Preserve script paths and executable commands
	 * - Limit changes to maxEditPercentage% of lines
	 */
	buildOptimizationPrompt(context: OptimizerPromptContext): string {
		const { skill, metrics, config } = context;
		const avgPct = Math.round(metrics.averageScore * 100);
		const decayedPct = Math.round(metrics.decayedScore * 100);

		return [
			`You are a skill optimizer. Your job is to improve a Pi agent skill definition based on validation feedback.`,
			``,
			`## Skill Performance Metrics`,
			`- Name: ${skill.name}`,
			`- Total invocations: ${metrics.totalInvocations}`,
			`- Success rate: ${metrics.successfulInvocations}/${metrics.totalInvocations}`,
			`- Average rollout score: ${avgPct}%`,
			`- Decayed score (recent rollouts weighted more): ${decayedPct}%`,
			`- Threshold for optimization: ${Math.round(config.minScoreThreshold * 100)}%`,
			``,
			`## Current Skill Definition (${skill.filePath})`,
			``,
			"```markdown",
			skill.content,
			"```",
			``,
			`## Optimization Rules (Bounded Edits)`,
			`1. ONLY modify the description, frontmatter values, or instructional text (Setup/Usage sections).`,
			`2. DO NOT change script paths, executable commands, file references, or any code blocks that the agent might run.`,
			`3. DO NOT remove or rename sections.`,
			`4. Keep edits limited: change at most ${config.maxEditPercentage}% of the non-code lines.`,
			`5. If the skill is performing poorly, the description may be too vague. Make it specific about WHEN to use the skill and WHAT it does.`,
			`6. If Setup instructions are unclear or causing tool failures, clarify the steps but keep commands intact.`,
			`7. Return your edits in the exact format below. If no edits are needed, output "NO_EDITS".`,
			``,
			`## Edit Format`,
			`For each edit, produce:`,
			``,
			`EDIT_TYPE: description | instructions | frontmatter`,
			`REASON: <one-line rationale>`,
			`OLD_TEXT:`,
			`<exact text to replace>`,
			`NEW_TEXT:`,
			`<replacement text>`,
			`---`,
			``,
			`Do not wrap OLD_TEXT or NEW_TEXT in code blocks. They must be exact substrings of the skill markdown.`,
		].join("\n");
	}

	/**
	 * Parse bounded edits from an LLM response.
	 */
	parseBoundedEdits(response: string): BoundedEdit[] {
		const edits: BoundedEdit[] = [];
		const blocks = response.split(/(?=^EDIT_TYPE:\s*(description|instructions|frontmatter)\s*$)/mui);

		for (const block of blocks) {
			const typeMatch = /^EDIT_TYPE:\s*(description|instructions|frontmatter)\s*$/mui.exec(block);
			if (!typeMatch) continue;

			const type = typeMatch[1] as BoundedEdit["type"];
			const reasonMatch = /^REASON:\s*(.*)$/mui.exec(block);
			const reason = reasonMatch?.[1]?.trim() || "";

			const oldTextMatch = /OLD_TEXT:\s*\n?([\s\S]*?)(?=\n?NEW_TEXT:|$)/.exec(block);
			const newTextMatch = /NEW_TEXT:\s*\n?([\s\S]*?)(?=\n?EDIT_TYPE:|\n?---\s*$|$)/.exec(block);

			if (!oldTextMatch || !newTextMatch) continue;

			const oldText = oldTextMatch[1].trimEnd();
			const newText = newTextMatch[1].trimEnd();

			if (oldText.length > 0 || newText.length > 0) {
				edits.push({ type, reason, oldText, newText });
			}
		}

		return edits;
	}

	/**
	 * Validate that an edit is bounded — it must be a strict substring replacement
	 * and must not touch executable regions.
	 */
	isEditBounded(skill: SkillDefinition, edit: BoundedEdit): boolean {
		// Must exist in the file
		if (!skill.content.includes(edit.oldText)) {
			return false;
		}

		if (edit.type === "frontmatter") {
			// Frontmatter edits must stay within the frontmatter block
			const fmEnd = skill.content.indexOf("\n---\n");
			if (fmEnd === -1) return false;
			const idx = skill.content.indexOf(edit.oldText);
			if (idx === -1 || idx > fmEnd) return false;
		}

		if (edit.type === "instructions") {
			// Instructions should not be inside code blocks
			const idx = skill.content.indexOf(edit.oldText);
			if (idx === -1) return false;
			if (this.isInsideCodeBlock(skill.content, idx)) {
				return false;
			}
		}

		if (edit.type === "description") {
			// Description is typically in frontmatter; allow anywhere
			const idx = skill.content.indexOf(edit.oldText);
			if (idx === -1) return false;
		}

		// Check line change percentage
		const originalLines = skill.content.split("\n").length;
		const changedLines = edit.newText.split("\n").length;
		const removedLines = edit.oldText.split("\n").length;
		const netChange = Math.abs(changedLines - removedLines);
		const pct = (netChange / Math.max(originalLines, 1)) * 100;
		return pct <= this.config.maxEditPercentage;
	}

	private isInsideCodeBlock(content: string, index: number): boolean {
		// Count backticks before index
		const before = content.slice(0, index);
		const codeFenceMatches = before.match(/```[a-z]*\n/g);
		if (!codeFenceMatches) return false;
		// Simplistic: if odd number of opening fences, we're inside a block
		return codeFenceMatches.length % 2 === 1;
	}

	/**
	 * Apply a list of bounded edits to a file using exact text replacement.
	 */
	async applyEdits(filePath: string, edits: BoundedEdit[]): Promise<void> {
		let content = await readFile(filePath, "utf-8");
		for (const edit of edits) {
			if (!content.includes(edit.oldText)) {
				throw new Error(`Edit oldText not found in ${filePath}: ${edit.oldText.slice(0, 50)}...`);
			}
			content = content.replace(edit.oldText, edit.newText);
		}
		await writeFile(filePath, content, "utf-8");
	}

	/**
	 * Reset iteration counters. Useful in tests.
	 */
	_resetCounters(): void {
		this.iterationCount.clear();
	}
}
