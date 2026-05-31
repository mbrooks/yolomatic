import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	checkLockfileSync,
	COVERAGE_SUMMARY_FILE,
	findCoverageFailures,
	findMissingTests,
	getChangedSourceFiles,
	getDefaultChangedFiles,
	getExpectedTestFile,
	getFileCoverage,
	isGuardrailSourceFile,
	LOCKFILE_PATH,
	MINIMUM_COVERAGE,
	parseChangedFiles,
	parseCoverageSummary,
	runGuardrail,
} from "./guardrails.js";

describe("parseChangedFiles", () => {
	it("splits and deduplicates newline-separated file list", () => {
		const result = parseChangedFiles("src/a.ts\nsrc/b.ts\nsrc/a.ts\n");
		expect(result).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("returns empty array for empty string", () => {
		expect(parseChangedFiles("")).toEqual([]);
	});

	it("trims whitespace from each line", () => {
		const result = parseChangedFiles("  src/a.ts  \n  src/b.ts  ");
		expect(result).toEqual(["src/a.ts", "src/b.ts"]);
	});
});

describe("isGuardrailSourceFile", () => {
	it("returns true for source files in src/", () => {
		expect(isGuardrailSourceFile("src/index.ts")).toBe(true);
		expect(isGuardrailSourceFile("src/foo/bar.ts")).toBe(true);
	});

	it("returns false for non-src paths", () => {
		expect(isGuardrailSourceFile("README.md")).toBe(false);
		expect(isGuardrailSourceFile("tests/foo.test.ts")).toBe(false);
	});

	it("returns true for transport-layer files in src/", () => {
		expect(isGuardrailSourceFile("src/admin/api/issues.ts")).toBe(true);
		expect(isGuardrailSourceFile("src/adapters/http/admin-router.ts")).toBe(true);
	});

	it("returns false for test files", () => {
		expect(isGuardrailSourceFile("src/foo.test.ts")).toBe(false);
	});

	it("returns false for types files", () => {
		expect(isGuardrailSourceFile("src/types.ts")).toBe(false);
		expect(isGuardrailSourceFile("src/foo/types.ts")).toBe(false);
	});
});

describe("getChangedSourceFiles", () => {
	it("filters to only guardrail source files", () => {
		const result = getChangedSourceFiles([
			"README.md",
			"src/index.ts",
			"src/index.test.ts",
			"src/types.ts",
			"src/foo/bar.ts",
			"src/admin/api/issues.ts",
			"src/adapters/http/admin-router.ts",
		]);
		expect(result).toEqual([
			"src/index.ts",
			"src/foo/bar.ts",
			"src/admin/api/issues.ts",
			"src/adapters/http/admin-router.ts",
		]);
	});
});

describe("getExpectedTestFile", () => {
	it("replaces .ts with .test.ts", () => {
		expect(getExpectedTestFile("src/index.ts")).toBe("src/index.test.ts");
		expect(getExpectedTestFile("src/foo/bar.ts")).toBe("src/foo/bar.test.ts");
	});
});

describe("findMissingTests", () => {
	it("returns empty when all tests exist", async () => {
		const exists = vi.fn().mockReturnValue(true);
		const result = await findMissingTests(["src/a.ts", "src/b.ts"], exists);
		expect(result).toEqual([]);
		expect(exists).toHaveBeenCalledWith("src/a.test.ts");
		expect(exists).toHaveBeenCalledWith("src/b.test.ts");
	});

	it("returns missing test files when they do not exist", async () => {
		const exists = vi.fn().mockReturnValue(false);
		const result = await findMissingTests(["src/a.ts"], exists);
		expect(result).toEqual(["src/a.test.ts"]);
	});
});

describe("parseCoverageSummary", () => {
	it("parses JSON into a typed report", async () => {
		const report = await parseCoverageSummary(
			JSON.stringify({
				total: { statements: { pct: 90 }, branches: { pct: 80 }, functions: { pct: 85 }, lines: { pct: 90 } },
				"src/index.ts": { statements: { pct: 95 }, branches: { pct: 90 }, functions: { pct: 100 }, lines: { pct: 95 } },
			}),
		);
		expect(report.total.statements.pct).toBe(90);
		expect(report["src/index.ts"].functions.pct).toBe(100);
	});
});

describe("getFileCoverage", () => {
	const report = {
		total: { statements: { pct: 90 }, branches: { pct: 80 }, functions: { pct: 85 }, lines: { pct: 90 } },
		"src/index.ts": { statements: { pct: 95 }, branches: { pct: 90 }, functions: { pct: 100 }, lines: { pct: 95 } },
	};

	it("returns coverage by relative path", () => {
		const entry = getFileCoverage(report, "src/index.ts");
		expect(entry?.statements.pct).toBe(95);
	});

	it("returns coverage by absolute path", () => {
		const entry = getFileCoverage(report, "src/missing.ts");
		expect(entry).toBeUndefined();
	});
});

describe("findCoverageFailures", () => {
	const report = {
		total: { statements: { pct: 90 }, branches: { pct: 80 }, functions: { pct: 85 }, lines: { pct: 90 } },
		"src/good.ts": { statements: { pct: 100 }, branches: { pct: 100 }, functions: { pct: 100 }, lines: { pct: 100 } },
		"src/bad.ts": { statements: { pct: 70 }, branches: { pct: 70 }, functions: { pct: 70 }, lines: { pct: 70 } },
		"src/mixed.ts": { statements: { pct: 85 }, branches: { pct: 75 }, functions: { pct: 90 }, lines: { pct: 85 } },
	};

	it("returns no failures when all metrics meet threshold", () => {
		const failures = findCoverageFailures(["src/good.ts"], report, MINIMUM_COVERAGE);
		expect(failures).toEqual([]);
	});

	it("returns failures for metrics below threshold", () => {
		const failures = findCoverageFailures(["src/bad.ts"], report, MINIMUM_COVERAGE);
		expect(failures).toHaveLength(4);
		const metrics = failures.map((f) => f.metric);
		expect(metrics).toContain("statements");
		expect(metrics).toContain("branches");
		expect(metrics).toContain("functions");
		expect(metrics).toContain("lines");
		for (const f of failures) {
			expect(f.actual).toBe(70);
			expect(f.expected).toBe(80);
		}
	});

	it("returns only failing metrics for mixed coverage", () => {
		const failures = findCoverageFailures(["src/mixed.ts"], report, MINIMUM_COVERAGE);
		expect(failures).toHaveLength(1);
		expect(failures[0].metric).toBe("branches");
		expect(failures[0].actual).toBe(75);
	});

	it("returns no-coverage failure when file not in report", () => {
		const failures = findCoverageFailures(["src/unknown.ts"], report, MINIMUM_COVERAGE);
		expect(failures).toHaveLength(1);
		expect(failures[0].file).toBe("src/unknown.ts");
		expect(failures[0].metric).toBe("coverage");
		expect(failures[0].actual).toBe(0);
		expect(failures[0].expected).toBe(80);
	});
});

describe("runGuardrail", () => {
	it("returns ok when no changed source files", async () => {
		const result = await runGuardrail(["README.md"]);
		expect(result.ok).toBe(true);
		expect(result.checkedFiles).toEqual([]);
	});

	it("returns failure when test is missing", async () => {
		const result = await runGuardrail(
			["src/thing.ts"],
			"/nonexistent/coverage-summary.json",
			MINIMUM_COVERAGE,
		);
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.includes("Missing test file"))).toBe(true);
		expect(result.failures.some((f) => f.includes("No coverage report"))).toBe(true);
	});

	it("passes when tests exist and coverage is sufficient", async () => {
		const tmpDir = await mkdtemp(path.join(os.tmpdir(), "tars-guard-"));
		const summaryPath = path.join(tmpDir, "coverage-summary.json");
		const summary = JSON.stringify({
			total: { statements: { pct: 90 }, branches: { pct: 80 }, functions: { pct: 85 }, lines: { pct: 90 } },
			"src/thing.ts": { statements: { pct: 100 }, branches: { pct: 100 }, functions: { pct: 100 }, lines: { pct: 100 } },
		});
		await writeFile(summaryPath, summary, "utf-8");
		const result = await runGuardrail(
			["src/thing.ts"],
			summaryPath,
			MINIMUM_COVERAGE,
			() => true,
		);
		expect(result.ok).toBe(true);
		expect(result.failures).toEqual([]);
	});

	it("fails coverage when report exists but metrics are below threshold", async () => {
		const tmpDir = await mkdtemp(path.join(os.tmpdir(), "tars-guard-"));
		const summaryPath = path.join(tmpDir, "coverage-summary.json");
		const summary = JSON.stringify({
			total: { statements: { pct: 90 }, branches: { pct: 80 }, functions: { pct: 85 }, lines: { pct: 90 } },
			"src/thing.ts": { statements: { pct: 70 }, branches: { pct: 70 }, functions: { pct: 70 }, lines: { pct: 70 } },
		});
		await writeFile(summaryPath, summary, "utf-8");
		const result = await runGuardrail(
			["src/thing.ts"],
			summaryPath,
			MINIMUM_COVERAGE,
			() => true,
		);
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.includes("Coverage too low"))).toBe(true);
	});
});

describe("getDefaultChangedFiles", () => {
	it("parses git output into an array", () => {
		const result = getDefaultChangedFiles();
		expect(Array.isArray(result)).toBe(true);
	});
});

describe("constants", () => {
	it("has expected values", () => {
		expect(MINIMUM_COVERAGE).toBe(80);
		expect(COVERAGE_SUMMARY_FILE).toContain("coverage/coverage-summary.json");
		expect(LOCKFILE_PATH).toContain("package-lock.json");
	});
});

describe("checkLockfileSync", () => {
	it("returns ok when lockfile does not change after npm install", async () => {
		const tmpDir = await mkdtemp(path.join(os.tmpdir(), "tars-lock-"));
		const lockfilePath = path.join(tmpDir, "package-lock.json");
		await writeFile(lockfilePath, '{"lockfileVersion":3}', "utf-8");
		const execSyncFn = vi.fn().mockImplementation(() => "");
		const result = await checkLockfileSync(lockfilePath, execSyncFn);
		expect(result.ok).toBe(true);
		expect(execSyncFn).toHaveBeenCalledWith("npm install --package-lock-only", { encoding: "utf-8", stdio: "pipe" });
	});

	it("returns failure when lockfile changes after npm install", async () => {
		const tmpDir = await mkdtemp(path.join(os.tmpdir(), "tars-lock-"));
		const lockfilePath = path.join(tmpDir, "package-lock.json");
		await writeFile(lockfilePath, '{"lockfileVersion":3}', "utf-8");
		const execWithSideEffect = vi.fn().mockImplementation(() => {
			require("node:fs").writeFileSync(lockfilePath, '{"lockfileVersion":3,"updated":true}', "utf-8");
		});
		const result = await checkLockfileSync(lockfilePath, execWithSideEffect);
		expect(result.ok).toBe(false);
		expect(result.failure).toContain("out of sync");
		const restored = await readFile(lockfilePath, "utf-8");
		expect(restored).toBe('{"lockfileVersion":3}');
	});

	it("returns failure when lockfile is not found", async () => {
		const result = await checkLockfileSync("/nonexistent/package-lock.json", vi.fn());
		expect(result.ok).toBe(false);
		expect(result.failure).toBe("package-lock.json not found");
	});

	it("returns failure when npm errors and lockfile does not change", async () => {
		const tmpDir = await mkdtemp(path.join(os.tmpdir(), "tars-lock-"));
		const lockfilePath = path.join(tmpDir, "package-lock.json");
		await writeFile(lockfilePath, '{"lockfileVersion":3}', "utf-8");
		const execSyncFn = vi.fn().mockImplementation(() => {
			throw Object.assign(new Error("npm error"), { stderr: "some npm error" });
		});
		const result = await checkLockfileSync(lockfilePath, execSyncFn);
		expect(result.ok).toBe(false);
		expect(result.failure).toContain("npm install --package-lock-only failed");
	});
});
