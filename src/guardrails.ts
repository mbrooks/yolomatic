import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { MOCK_EXCEPTIONS_FILE, runMockBoundaryGuardrail } from "./mock-boundary.js";

export const MINIMUM_COVERAGE = 80;
export const COVERAGE_SUMMARY_FILE = resolve(process.cwd(), "coverage/coverage-summary.json");

const SOURCE_PATH_PATTERN = /^src\//u;
const SOURCE_FILE_PATTERN = /\.tsx?$/u;
const TEST_FILE_PATTERN = /\.test\.ts$/u;

/**
 * Coverage-relevance exclusions per `AGENTS.md`.
 *
 * The guardrail enforces 80% statements/branches/functions/lines only on
 * business logic, utilities, and state transitions. The categories below are
 * excluded from both coverage measurement and enforcement. Each rule is a
 * deterministic path pattern so the excluded set stays reviewable.
 */

// Type-export modules: files that only export types/interfaces. Matches any
// file named `types.ts` anywhere under `src/`.
const TYPE_EXPORT_PATTERN = /(^|\/)types\.ts$/u;

// Styling files: admin UI components (`.tsx`) and CSS/style modules. `.tsx`
// is also outside the `.ts` coverage include; the explicit check keeps the
// exclusion intentional rather than incidental to the extension.
const STYLING_PATTERN = /(^|\/)((styles|style|.*\.styles|.*\.style)\.ts|.*\.tsx)$/u;

// Configuration files: modules that wire settings into runtime config.
// Matches `config.ts` and any `*.config.ts` under `src/`.
const CONFIG_PATTERN = /(^|\/)(config|.*\.config)\.ts$/u;

// Third-party setup / wiring: modules that only instantiate/configure an
// external SDK. Add new SDK-wiring module basenames here so the exclusion
// set stays deterministic and reviewable.
const THIRD_PARTY_SETUP_PATTERN = /(^|\/)octokit\.ts$/u;

// TypeScript declaration files: ambient type declarations with no runtime
// code. These are excluded from coverage and test-file requirements.
const DECLARATION_FILE_PATTERN = /\.d\.ts$/u;

export function isTestFile(file: string): boolean {
	return TEST_FILE_PATTERN.test(file);
}

export function isTypeExportFile(file: string): boolean {
	return TYPE_EXPORT_PATTERN.test(file);
}

export function isStylingFile(file: string): boolean {
	return STYLING_PATTERN.test(file);
}

export function isConfigurationFile(file: string): boolean {
	return CONFIG_PATTERN.test(file);
}

export function isThirdPartySetupFile(file: string): boolean {
	return THIRD_PARTY_SETUP_PATTERN.test(file);
}

export function isDeclarationFile(file: string): boolean {
	return DECLARATION_FILE_PATTERN.test(file);
}

export interface CoverageEntry {
	statements: { pct: number };
	branches: { pct: number };
	functions: { pct: number };
	lines: { pct: number };
}

export interface CoverageReport {
	total: CoverageEntry;
	[file: string]: CoverageEntry;
}

export interface GuardrailResult {
	ok: boolean;
	checkedFiles: string[];
	failures: string[];
}

export function parseChangedFiles(value: string): string[] {
	const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
	return [...new Set(lines)];
}

export function isGuardrailSourceFile(file: string): boolean {
	if (!SOURCE_PATH_PATTERN.test(file)) return false;
	if (!SOURCE_FILE_PATTERN.test(file)) return false;
	if (isTestFile(file)) return false;
	if (isTypeExportFile(file)) return false;
	if (isStylingFile(file)) return false;
	if (isConfigurationFile(file)) return false;
	if (isThirdPartySetupFile(file)) return false;
	if (isDeclarationFile(file)) return false;
	return true;
}

export function getChangedSourceFiles(files: string[]): string[] {
	return files.filter(isGuardrailSourceFile);
}

export function getExpectedTestFile(sourceFile: string): string {
	return sourceFile.replace(/\.ts$/, ".test.ts");
}

export async function findMissingTests(
	sourceFiles: string[],
	fileExists: (path: string) => boolean = (p) => existsSync(p),
): Promise<string[]> {
	const missing: string[] = [];
	for (const sourceFile of sourceFiles) {
		const testFile = getExpectedTestFile(sourceFile);
		if (!fileExists(testFile)) {
			missing.push(testFile);
		}
	}
	return missing;
}

export async function parseCoverageSummary(content: string): Promise<CoverageReport> {
	return JSON.parse(content) as CoverageReport;
}

export function getFileCoverage(report: CoverageReport, file: string): CoverageEntry | undefined {
	if (report[file]) {
		return report[file];
	}
	const absolute = resolve(process.cwd(), file);
	return report[absolute];
}

export interface CoverageFailure {
	file: string;
	metric: string;
	actual: number;
	expected: number;
}

export function findCoverageFailures(
	sourceFiles: string[],
	report: CoverageReport,
	minimumCoverage: number = MINIMUM_COVERAGE,
): CoverageFailure[] {
	const failures: CoverageFailure[] = [];
	for (const sourceFile of sourceFiles) {
		const entry = getFileCoverage(report, sourceFile);
		if (!entry) {
			failures.push({ file: sourceFile, metric: "coverage", actual: 0, expected: minimumCoverage });
			continue;
		}
		const metrics: Array<keyof CoverageEntry> = ["statements", "branches", "functions", "lines"];
		for (const metric of metrics) {
			if (entry[metric].pct < minimumCoverage) {
				failures.push({
					file: sourceFile,
					metric,
					actual: entry[metric].pct,
					expected: minimumCoverage,
				});
			}
		}
	}
	return failures;
}

export function getDefaultChangedFiles(): string[] {
	let output = "";
	try {
		output += execSync("git diff --name-only --diff-filter=ACMR HEAD --", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
	} catch {
		// ignore
	}
	try {
		output += execSync("git ls-files --others --exclude-standard", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
	} catch {
		// ignore
	}
	return parseChangedFiles(output);
}

export async function runGuardrail(
	changedFiles?: string[],
	summaryPath: string = COVERAGE_SUMMARY_FILE,
	minimumCoverage: number = MINIMUM_COVERAGE,
	fileExists: (path: string) => boolean = (p) => existsSync(p),
): Promise<GuardrailResult> {
	const files = changedFiles ?? getDefaultChangedFiles();
	const sourceFiles = getChangedSourceFiles(files);
	const failures: string[] = [];

	if (sourceFiles.length === 0) {
		return { ok: true, checkedFiles: [], failures: [] };
	}

	const missingTests = await findMissingTests(sourceFiles, fileExists);
	for (const missing of missingTests) {
		failures.push(`Missing test file: ${missing}`);
	}

	let report: CoverageReport | undefined;
	if (existsSync(summaryPath)) {
		const content = await readFile(summaryPath, "utf-8");
		report = await parseCoverageSummary(content);
	}

	if (report) {
		const coverageFailures = findCoverageFailures(sourceFiles, report, minimumCoverage);
		for (const failure of coverageFailures) {
			failures.push(
				`Coverage too low for ${failure.file}: ${failure.metric} ${failure.actual.toFixed(2)}% (minimum ${failure.expected}%)`,
			);
		}
	} else {
		for (const sourceFile of sourceFiles) {
			failures.push(`No coverage report found for ${sourceFile}`);
		}
	}

	return { ok: failures.length === 0, checkedFiles: sourceFiles, failures };
}

/* istanbul ignore next */
if (import.meta.url === `file://${process.argv[1]}`) {
	(async () => {
		let exitCode = 0;

		const result = await runGuardrail();
		for (const file of result.checkedFiles) {
			console.log(`Checking ${file}...`);
		}
		if (result.failures.length > 0) {
			for (const failure of result.failures) {
				console.error(`FAIL: ${failure}`);
			}
			console.error(`\nGuardrail failed: ${result.failures.length} issue(s).`);
			exitCode = 1;
		}

		const mockBoundary = await runMockBoundaryGuardrail(
			getDefaultChangedFiles(),
			MOCK_EXCEPTIONS_FILE,
		);
		if (mockBoundary.failures.length > 0) {
			for (const failure of mockBoundary.failures) {
				console.error(`FAIL: ${failure}`);
			}
			console.error(
				`\nMock-boundary guardrail failed: ${mockBoundary.failures.length} issue(s).`,
			);
			exitCode = 1;
		}

		if (exitCode === 0) {
			console.log("Guardrail passed.");
		}
		process.exit(exitCode);
	})();
}
