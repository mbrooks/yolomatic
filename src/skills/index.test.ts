/**
 * Smoke tests for the skills module public API.
 */

import { describe, it, expect } from "vitest";
import {
	SkillMetricsCollector,
	SkillOptimizer,
	DEFAULT_OPTIMIZER_CONFIG,
} from "./index.js";

describe("skills module exports", () => {
	it("exports SkillMetricsCollector", () => {
		expect(typeof SkillMetricsCollector).toBe("function");
	});

	it("exports SkillOptimizer", () => {
		expect(typeof SkillOptimizer).toBe("function");
	});

	it("exports default config constants", () => {
		expect(DEFAULT_OPTIMIZER_CONFIG.minScoreThreshold).toBe(0.6);
		expect(DEFAULT_OPTIMIZER_CONFIG.maxEditPercentage).toBe(30);
		expect(DEFAULT_OPTIMIZER_CONFIG.rolloutWindowSize).toBe(10);
		expect(DEFAULT_OPTIMIZER_CONFIG.decayFactor).toBe(0.9);
	});
});
