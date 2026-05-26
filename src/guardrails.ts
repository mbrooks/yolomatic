import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const MINIMUM_COVERAGE = 80;
export const COVERAGE_SUMMARY_FILE = resolve(process.cwd(), "coverage/coverage-summary.json");
export const LOCKFILE_PATH = resolve(process.cwd(), "package-lock.json");

const SOURCE_FILE_PATTERN = /^src\/.*\.ts$/;
const GUARDRAIL_EXCLUDED_PREFIXES = [
	"src/admin/api/",
	"src/adapters/http/",
];

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
	return (
		SOURCE_FILE_PATTERN.test(file) &&
		!GUARDRAIL_EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
		!file.endsWith(".test.ts") &&
		!file.endsWith("/types.ts")
	);
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

export interface LockfileSyncResult {
	ok: boolean;
	failure?: string;
}

export async function checkLockfileSync(
	lockfilePath: string = LOCKFILE_PATH,
	execSyncFn: typeof execSync = execSync,
): Promise<LockfileSyncResult> {
	if (!existsSync(lockfilePath)) {
		return { ok: false, failure: "package-lock.json not found" };
	}

	const original = await readFile(lockfilePath, "utf-8");
	let npmError: string | undefined;

	try {
		execSyncFn("npm install --package-lock-only", { encoding: "utf-8", stdio: "pipe" });
	} catch (error: any) {
		npmError = error.stderr?.toString() || error.message;
	}

	const current = await readFile(lockfilePath, "utf-8");

	if (original !== current) {
		await writeFile(lockfilePath, original, "utf-8");
		return {
			ok: false,
			failure: "package-lock.json is out of sync with package.json. Run `npm install` and commit the updated lockfile.",
		};
	}

	if (npmError) {
		return { ok: false, failure: `npm install --package-lock-only failed: ${npmError}` };
	}

	return { ok: true };
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

		const lockfileResult = await checkLockfileSync();
		if (!lockfileResult.ok) {
			console.error(`FAIL: ${lockfileResult.failure}`);
			exitCode = 1;
		} else {
			console.log("Lockfile sync check passed.");
		}

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

		if (exitCode === 0) {
			console.log("Guardrail passed.");
		}
		process.exit(exitCode);
	})();
}
