import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Mock-boundary guardrail.
 *
 * `AGENTS.md` permits mocking only external boundaries — network requests and
 * third-party SDKs. Mocking internal relative modules inflates execution
 * coverage without a useful quality signal, so this guardrail rejects new
 * relative-module `vi.mock(...)` calls in unit tests unless they are listed in
 * `mock-exceptions.json` with an explicit external-adapter / composition-root
 * (or grandfathered legacy) reason.
 *
 * The exception file is the auditable escape hatch. The completeness audit in
 * `src/mock-boundary.test.ts` pins the grandfathered set so every existing
 * relative mock is accounted for and any new one must be deliberately added.
 */

export const MOCK_EXCEPTIONS_FILE = resolve(process.cwd(), "mock-exceptions.json");

export type MockExceptionCategory = "external-adapter" | "composition-root" | "legacy";

export interface MockException {
	testFile: string;
	module: string;
	category: MockExceptionCategory;
	reason: string;
}

export interface MockExceptionsFile {
	exceptions: MockException[];
}

export interface RelativeMock {
	module: string;
	line: number;
}

export interface MockFailure {
	testFile: string;
	module: string;
	line: number;
}

export interface MockBoundaryResult {
	ok: boolean;
	failures: string[];
}

const CHANGED_TEST_FILE_PATTERN = /^(src|tests)\/.*\.test\.tsx?$/u;
// Matches a real `vi.mock("./..." )` / `vi.mock('../...' )` call. The `^\s*`
// anchor restricts matches to statement position so `vi.mock(...)` text
// embedded in string/template-literal fixtures (e.g. inside backticks in
// mock-boundary.test.ts) is not flagged as a real mock. The `\.{1,2}/` capture
// anchor ensures only relative module specs are captured, and `vi.mock(\b`
// (with the required `(`) excludes `vi.mocked(...)`.
const RELATIVE_MOCK_PATTERN = /^\s*vi\.mock\(\s*(["'])(\.{1,2}\/[^"']+)\1/u;

export function isRelativeModulePath(spec: string): boolean {
	return spec.startsWith("./") || spec.startsWith("../");
}

export function findRelativeMocks(source: string): RelativeMock[] {
	const results: RelativeMock[] = [];
	const lines = source.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line.includes("vi.mock(")) {
			continue;
		}
		const match = line.match(RELATIVE_MOCK_PATTERN);
		if (match) {
			results.push({ module: match[2], line: index + 1 });
		}
	}
	return results;
}

export function getChangedTestFiles(files: string[]): string[] {
	return files.filter((file) => CHANGED_TEST_FILE_PATTERN.test(file));
}

export async function parseMockExceptions(content: string): Promise<MockExceptionsFile> {
	const parsed = JSON.parse(content) as Partial<MockExceptionsFile> as unknown as {
		exceptions?: MockException[];
	};
	const exceptions = Array.isArray(parsed.exceptions) ? parsed.exceptions : [];
	return { exceptions };
}

export async function findUnauthorizedMocks(
	testFiles: string[],
	fileRead: (path: string) => Promise<string>,
	exceptions: MockException[],
): Promise<MockFailure[]> {
	const excepted = new Set(exceptions.map((exception) => `${exception.testFile}::${exception.module}`));
	const failures: MockFailure[] = [];
	for (const testFile of testFiles) {
		const source = await fileRead(testFile);
		for (const mock of findRelativeMocks(source)) {
			if (!excepted.has(`${testFile}::${mock.module}`)) {
				failures.push({ testFile, module: mock.module, line: mock.line });
			}
		}
	}
	return failures;
}

const defaultFileRead = async (path: string): Promise<string> =>
	readFile(resolve(process.cwd(), path), "utf-8");

export async function runMockBoundaryGuardrail(
	changedFiles: string[],
	exceptionsPath: string = MOCK_EXCEPTIONS_FILE,
	fileRead: (path: string) => Promise<string> = defaultFileRead,
): Promise<MockBoundaryResult> {
	const testFiles = getChangedTestFiles(changedFiles);
	if (testFiles.length === 0) {
		return { ok: true, failures: [] };
	}

	let exceptions: MockException[] = [];
	if (existsSync(exceptionsPath)) {
		const content = await readFile(exceptionsPath, "utf-8");
		exceptions = (await parseMockExceptions(content)).exceptions;
	}

	const failures = await findUnauthorizedMocks(testFiles, fileRead, exceptions);
	const failureStrings = failures.map(
		(failure) =>
			`Unauthorized relative mock in ${failure.testFile}:${failure.line} -> ${failure.module}`,
	);
	return { ok: failureStrings.length === 0, failures: failureStrings };
}