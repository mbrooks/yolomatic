/**
 * Skill optimization types inspired by SkillOpt paper.
 * Skills are treated as optimizable assets with validation feedback loops.
 */

export interface SkillDefinition {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	content: string;
	frontmatter: Record<string, unknown>;
}

export interface SkillInvocation {
	skillName: string;
	timestamp: string;
	/** Whether the agent achieved its goal after invoking this skill */
	outcome: "success" | "failure" | "unknown";
	/** Observed tool calls after skill invocation that contributed to the outcome */
	toolCalls: SkillToolCall[];
	/** Optional reason for failure */
	errorMessage?: string;
}

export interface SkillToolCall {
	toolName: string;
	success: boolean;
	timestamp: string;
}

export interface SkillMetricsRecord {
	skillName: string;
	workspacePath: string;
	totalInvocations: number;
	successfulInvocations: number;
	failedInvocations: number;
	lastUsedAt: string | null;
	/** Per-rollout scores (0-1) */
	scores: number[];
	/** Average score across all rollouts */
	averageScore: number;
	/** Optional decay factor for older rollouts */
	decayedScore: number;
}

/**
 * A single bounded edit to a skill definition.
 * Constraints ensure we don't break scripts, assets, or frontmatter structure.
 */
export interface BoundedEdit {
	type: "description" | "instructions" | "frontmatter";
	/** Human-readable rationale */
	reason: string;
	/** The old text to replace */
	oldText: string;
	/** The new text to insert */
	newText: string;
}

export interface SkillOptimizationResult {
	skillName: string;
	/** Before/after metrics */
	metricsBefore: SkillMetricsRecord;
	metricsAfter: SkillMetricsRecord;
	/** Suggested bounded edits */
	edits: BoundedEdit[];
	/** Whether edits were applied */
	applied: boolean;
	/** Iteration number */
	iteration: number;
}

export interface SkillOptimizerConfig {
	/** Minimum average score before triggering optimization */
	minScoreThreshold: number;
	/** Maximum percentage of lines that can be changed in a single iteration */
	maxEditPercentage: number;
	/** Number of recent rollouts to consider */
	rolloutWindowSize: number;
	/** Decay factor for older rollouts (0-1) */
	decayFactor: number;
}

export const DEFAULT_OPTIMIZER_CONFIG: SkillOptimizerConfig = {
	minScoreThreshold: 0.6,
	maxEditPercentage: 30,
	rolloutWindowSize: 10,
	decayFactor: 0.9,
};
