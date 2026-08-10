import { describe, expect, it } from "vitest";

import { isGuardrailSourceFile as isGuardrailSourceFileInSource } from "../../src/guardrails.js";
import {
	getExpectedTestFile as getExpectedTestFileInScript,
	isGuardrailSourceFile as isGuardrailSourceFileInScript,
	parseChangedFiles as parseChangedFilesInScript,
} from "../../scripts/run-guardrail-coverage.js";
import {
	getExpectedTestFile as getExpectedTestFileInSource,
	parseChangedFiles as parseChangedFilesInSource,
} from "../../src/guardrails.js";

/**
 * The coverage-relevance classification is implemented twice:
 *   - `src/guardrails.ts` is the canonical source used by `runGuardrail` for
 *     enforcement.
 *   - `scripts/run-guardrail-coverage.js` re-implements the same logic to
 *     decide which test files to run for coverage measurement.
 *
 * The two MUST agree so that the set of files measured for coverage matches
 * the set of files enforced by the guardrail. This parity test asserts they
 * classify the same representative paths identically.
 */
describe("guardrail classification parity", () => {
	const representativePaths = [
		"README.md",
		"tests/foo.test.ts",
		"src/index.ts",
		"src/foo/bar.ts",
		"src/foo.test.ts",
		"src/types.ts",
		"src/foo/types.ts",
		"src/skills/types.ts",
		"src/admin/app/types.ts",
		"src/admin/components/Modal.tsx",
		"src/admin/styles.css",
		"src/admin/theme/styles.ts",
		"src/admin/lib/button.styles.ts",
		"src/admin/lib/button.style.ts",
		"src/config.ts",
		"src/workspace/config.ts",
		"src/foo/bar.config.ts",
		"src/adapters/github/octokit.ts",
		"src/session/manager.ts",
		"src/guardrails.ts",
		"src/domain/session/model.ts",
		"src/admin/api/issues.ts",
		"src/adapters/http/admin-router.ts",
		"src/admin/css-modules.d.ts",
	];

	it("classifies every representative path identically", () => {
		for (const file of representativePaths) {
			expect(
				isGuardrailSourceFileInSource(file),
				`parity mismatch for ${file}`,
			).toBe(isGuardrailSourceFileInScript(file));
		}
	});

	it("parses changed-file lists identically", () => {
		const input = "src/a.ts\nsrc/b.ts\nsrc/a.ts\n  src/c.ts  \n";
		expect(parseChangedFilesInScript(input)).toEqual(parseChangedFilesInSource(input));
	});

	it("derives expected test files identically", () => {
		for (const file of ["src/index.ts", "src/foo/bar.ts", "src/session/manager.ts"]) {
			expect(getExpectedTestFileInScript(file)).toBe(getExpectedTestFileInSource(file));
		}
	});
});