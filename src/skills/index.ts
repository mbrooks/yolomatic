/**
 * Skill optimization module.
 *
 * Implements a validation-feedback optimization loop for Pi agent skills,
 * inspired by the SkillOpt paper. Core components:
 *
 * - SkillMetricsCollector: discovers skills and computes per-skill rollout scores
 * - SkillOptimizer: runs the optimization iteration, generates prompts, and applies bounded edits
 * - Types: shared interfaces for skills, metrics, edits, and results
 */

export * from "./types.js";
export { SkillMetricsCollector } from "./skill-metrics.js";
export { SkillOptimizer } from "./skill-optimizer.js";
