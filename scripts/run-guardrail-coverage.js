import { existsSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const vitestConfig = resolve(repoRoot, "vitest.guardrail.config.ts");

function findVitestEntrypoint(startDir) {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		const candidate = resolve(dir, "node_modules/vitest/vitest.mjs");
		if (existsSync(candidate)) {
			return candidate;
		}
		dir = dirname(dir);
	}
	return null;
}

const vitestEntrypoint = findVitestEntrypoint(repoRoot) ?? resolve(repoRoot, "node_modules/vitest/vitest.mjs");

const SOURCE_PATH_PATTERN = /^src\//u;
const SOURCE_FILE_PATTERN = /\.tsx?$/u;
const TEST_FILE_PATTERN = /\.test\.ts$/u;

// Coverage-relevance exclusions per `AGENTS.md`. These MUST match the
// classification in `src/guardrails.ts` exactly; the parity test in
// `tests/integration/guardrail-coverage-parity.test.ts` asserts they agree.
const TYPE_EXPORT_PATTERN = /(^|\/)types\.ts$/u;
const STYLING_PATTERN = /(^|\/)((styles|style|.*\.styles|.*\.style)\.ts|.*\.tsx)$/u;
const CONFIG_PATTERN = /(^|\/)(config|.*\.config)\.ts$/u;
const THIRD_PARTY_SETUP_PATTERN = /(^|\/)octokit\.ts$/u;

function isTestFile(file) {
	return TEST_FILE_PATTERN.test(file);
}

function isTypeExportFile(file) {
	return TYPE_EXPORT_PATTERN.test(file);
}

function isStylingFile(file) {
	return STYLING_PATTERN.test(file);
}

function isConfigurationFile(file) {
	return CONFIG_PATTERN.test(file);
}

function isThirdPartySetupFile(file) {
	return THIRD_PARTY_SETUP_PATTERN.test(file);
}

function parseChangedFiles(value) {
	const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
	return [...new Set(lines)];
}

function isGuardrailSourceFile(file) {
	if (!SOURCE_PATH_PATTERN.test(file)) return false;
	if (!SOURCE_FILE_PATTERN.test(file)) return false;
	if (isTestFile(file)) return false;
	if (isTypeExportFile(file)) return false;
	if (isStylingFile(file)) return false;
	if (isConfigurationFile(file)) return false;
	if (isThirdPartySetupFile(file)) return false;
	return true;
}

function getDefaultChangedFiles() {
	let output = "";
	try {
		output += execSync("git diff --name-only --diff-filter=ACMR HEAD --", {
			cwd: repoRoot,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		// ignore
	}
	try {
		output += execSync("git ls-files --others --exclude-standard", {
			cwd: repoRoot,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		// ignore
	}
	return parseChangedFiles(output);
}

function getExpectedTestFile(sourceFile) {
	return sourceFile.replace(/\.ts$/, ".test.ts");
}

function unique(values) {
	return [...new Set(values)];
}

function runCoverage() {
	const changedSourceFiles = getDefaultChangedFiles().filter(isGuardrailSourceFile);
	const existingTestFiles = unique(
		changedSourceFiles
			.map((sourceFile) => getExpectedTestFile(sourceFile))
			.filter((testFile) => existsSync(resolve(repoRoot, testFile))),
	);

	if (existingTestFiles.length === 0) {
		process.stdout.write("No guardrail-relevant test files to run for coverage.\n");
		process.exit(0);
	}

	const result = spawnSync(
		process.execPath,
		[
			vitestEntrypoint,
			"run",
			"--config",
			vitestConfig,
			"--coverage",
			...existingTestFiles,
		],
		{
			cwd: repoRoot,
			stdio: "inherit",
			env: process.env,
		},
	);

	process.exit(result.status ?? 1);
}

export {
	getExpectedTestFile,
	isConfigurationFile,
	isGuardrailSourceFile,
	isStylingFile,
	isTestFile,
	isThirdPartySetupFile,
	isTypeExportFile,
	parseChangedFiles,
};

/* v8 ignore start */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runCoverage();
}
/* v8 ignore stop */
