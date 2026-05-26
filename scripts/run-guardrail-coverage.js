import { existsSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const vitestEntrypoint = resolve(repoRoot, "node_modules/vitest/vitest.mjs");
const vitestConfig = resolve(repoRoot, "vitest.guardrail.config.ts");
const sourceFilePattern = /^src\/.*\.ts$/;
const excludedPrefixes = ["src/admin/api/", "src/adapters/http/"];

function parseChangedFiles(value) {
	const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
	return [...new Set(lines)];
}

function isGuardrailSourceFile(file) {
	return (
		sourceFilePattern.test(file) &&
		!excludedPrefixes.some((prefix) => file.startsWith(prefix)) &&
		!file.endsWith(".test.ts") &&
		!file.endsWith("/types.ts")
	);
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
