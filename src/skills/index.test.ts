/**
 * Module-boundary guardrail for the skills package.
 *
 * The skill-optimization subsystem (`SkillOptimizer`, `SkillMetricsCollector`,
 * and their optimizer-only types) is dormant: no production entrypoint
 * constructs or invokes it, yet the optimizer can rewrite repository skill
 * files. These tests keep that mutation subsystem from remaining reachable
 * through the skills barrel or any production import.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as skillsBarrel from "./index.js";

const SOURCE_ROOT = path.resolve(__dirname, "..");

/**
 * Identifiers that belong exclusively to the dormant optimization subsystem.
 * If any of these leak back onto the skills barrel, the boundary is broken.
 */
const DORMANT_EXPORTS = [
	"SkillOptimizer",
	"SkillMetricsCollector",
	"DEFAULT_OPTIMIZER_CONFIG",
	"SkillOptimizerConfig",
	"SkillOptimizationResult",
	"SkillMetricsRecord",
	"SkillDefinition",
	"SkillInvocation",
	"SkillToolCall",
	"BoundedEdit",
];

/**
 * Import path fragments that only the dormant modules use. No production
 * source may import these modules.
 */
const DORMANT_IMPORT_PATTERNS = [/skill-optimizer\b/u, /skill-metrics\b/u];

function isProductionSource(name: string): boolean {
	return /\.tsx?$/u.test(name) && !/\.test\.ts$/u.test(name);
}

function listProductionSource(root: string): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) {
			results.push(...listProductionSource(full));
			continue;
		}
		if (entry.isFile() && isProductionSource(entry.name)) {
			results.push(full);
		}
	}
	return results;
}

describe("skills module boundary", () => {
	it("does not export the dormant optimizer or metrics collector", () => {
		for (const name of DORMANT_EXPORTS) {
			expect(
				Object.prototype.hasOwnProperty.call(skillsBarrel, name),
				`${name} must not be exported from the skills barrel`,
			).toBe(false);
		}
	});

	it("no production source imports the dormant subsystem", () => {
		const offenders: string[] = [];
		for (const file of listProductionSource(SOURCE_ROOT)) {
			const content = readFileSync(file, "utf-8");
			for (const pattern of DORMANT_IMPORT_PATTERNS) {
				if (pattern.test(content)) {
					offenders.push(path.relative(SOURCE_ROOT, file));
					break;
				}
			}
		}
		expect(offenders, `dormant subsystem imported by: ${offenders.join(", ")}`).toEqual([]);
	});
});