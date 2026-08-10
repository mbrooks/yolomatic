/**
 * Skill management module.
 *
 * Exposes the active server-skill, repository-skill, and merge behavior used
 * by runtime workflows. The dormant skill-optimization subsystem
 * (`SkillOptimizer`, `SkillMetricsCollector`, and their optimizer-only types)
 * is intentionally not exported here; see `index.test.ts` for the
 * module-boundary guardrail that keeps it that way.
 */

export { SkillStore } from "./store.js";
export { RepoSkillService, parseSkillFile, buildSkillFile } from "./repo-skill-service.js";
export type { CommandRunner, RepoSkillServiceConfig } from "./repo-skill-service.js";
export { mergeRepoAndServerSkills } from "./merge-skills.js";
export type { ServerSkill, RepoSkill, SkillFormData, ParsedSkillFile } from "./model.js";
