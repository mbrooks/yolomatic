import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
	findRelativeMocks,
	findUnauthorizedMocks,
	getChangedTestFiles,
	isRelativeModulePath,
	MOCK_EXCEPTIONS_FILE,
	parseMockExceptions,
	runMockBoundaryGuardrail,
} from "./mock-boundary.js";

describe("isRelativeModulePath", () => {
	it("returns true for ./ and ../ paths", () => {
		expect(isRelativeModulePath("./client.js")).toBe(true);
		expect(isRelativeModulePath("../logging/llm-logger.js")).toBe(true);
		expect(isRelativeModulePath("../../api/issues.js")).toBe(true);
	});

	it("returns false for bare package names, scoped packages, and node: builtins", () => {
		expect(isRelativeModulePath("ws")).toBe(false);
		expect(isRelativeModulePath("node:child_process")).toBe(false);
		expect(isRelativeModulePath("@earendil-works/pi-coding-agent")).toBe(false);
		expect(isRelativeModulePath("vitest")).toBe(false);
	});

	it("returns false for absolute-style or other non-relative strings", () => {
		expect(isRelativeModulePath("/abs/path.js")).toBe(false);
		expect(isRelativeModulePath("client.js")).toBe(false);
	});
});

describe("findRelativeMocks", () => {
	it("extracts relative vi.mock paths with 1-based line numbers", () => {
		const source = [
			`import { vi } from "vitest";`,
			`vi.mock("./client.js", () => ({}));`,
			`vi.mock("../logging/llm-logger.js", () => ({}));`,
			`vi.mock("ws", () => ({}));`,
		].join("\n");
		const mocks = findRelativeMocks(source);
		expect(mocks).toEqual([
			{ module: "./client.js", line: 2 },
			{ module: "../logging/llm-logger.js", line: 3 },
		]);
	});

	it("supports single and double quotes", () => {
		const source = [
			`vi.mock('./a.js', () => ({}));`,
			`vi.mock("./b.js", () => ({}));`,
		].join("\n");
		const mocks = findRelativeMocks(source);
		expect(mocks).toEqual([
			{ module: "./a.js", line: 1 },
			{ module: "./b.js", line: 2 },
		]);
	});

	it("supports the async importOriginal variant", () => {
		const source = `vi.mock("../../api/onboarding.js", async (importOriginal) => { return await importOriginal(); });`;
		const mocks = findRelativeMocks(source);
		expect(mocks).toEqual([{ module: "../../api/onboarding.js", line: 1 }]);
	});

	it("ignores vi.mocked(...) calls", () => {
		const source = [
			`vi.mock("./client.js", () => ({}));`,
			`const fn = vi.mocked(someFn);`,
		].join("\n");
		const mocks = findRelativeMocks(source);
		expect(mocks).toEqual([{ module: "./client.js", line: 1 }]);
	});

	it("ignores vi.mock occurrences embedded in string/template literals", () => {
		// These are test-fixture strings, not real vi.mock calls. The guardrail
		// must not flag a test file merely because it mentions vi.mock in a
		// string literal (e.g. mock-boundary.test.ts itself).
		const source = [
			'const fixture = `vi.mock("./fixture.js", () => ({}));`;',
			'const fileRead = async () => `vi.mock("./sneaky.js", () => ({}));`;',
			'const arr = [`vi.mock("./a.js", () => ({}))`, `vi.mock("./b.js", () => ({}))`];',
		].join("\n");
		expect(findRelativeMocks(source)).toEqual([]);
	});

	it("still detects a real vi.mock call alongside string-literal fixtures", () => {
		const source = [
			'const fixture = `vi.mock("./fixture.js", () => ({}));`;',
			`vi.mock("./real.js", () => ({}));`,
		].join("\n");
		expect(findRelativeMocks(source)).toEqual([{ module: "./real.js", line: 2 }]);
	});

	it("ignores non-relative package mocks", () => {
		const source = [
			`vi.mock("ws", () => ({}));`,
			`vi.mock("@earendil-works/pi-coding-agent", () => ({}));`,
			`vi.mock("node:child_process", () => ({}));`,
		].join("\n");
		expect(findRelativeMocks(source)).toEqual([]);
	});

	it("returns empty for source with no mocks", () => {
		expect(findRelativeMocks("console.log('hi');\n")).toEqual([]);
	});
});

describe("parseMockExceptions", () => {
	it("parses a valid exceptions file", async () => {
		const content = JSON.stringify({
			exceptions: [
				{
					testFile: "src/admin/api/users.test.ts",
					module: "./client.js",
					category: "composition-root",
					reason: "HTTP transport client wiring",
				},
			],
		});
		const parsed = await parseMockExceptions(content);
		expect(parsed.exceptions).toHaveLength(1);
		expect(parsed.exceptions[0].testFile).toBe("src/admin/api/users.test.ts");
		expect(parsed.exceptions[0].category).toBe("composition-root");
	});

	it("throws on invalid JSON", async () => {
		await expect(parseMockExceptions("{not json")).rejects.toThrow();
	});

	it("returns empty exceptions array when none listed", async () => {
		const parsed = await parseMockExceptions(JSON.stringify({ exceptions: [] }));
		expect(parsed.exceptions).toEqual([]);
	});
});

describe("findUnauthorizedMocks", () => {
	const exceptions = [
		{
			testFile: "src/admin/api/users.test.ts",
			module: "./client.js",
			category: "composition-root" as const,
			reason: "HTTP transport client wiring",
		},
	];

	it("returns no failures when every relative mock is excepted", async () => {
		const fileRead = async () => `vi.mock("./client.js", () => ({}));`;
		const failures = await findUnauthorizedMocks(
			["src/admin/api/users.test.ts"],
			fileRead,
			exceptions,
		);
		expect(failures).toEqual([]);
	});

	it("returns a failure for an unexcepted relative mock", async () => {
		const fileRead = async () => `vi.mock("./internal.js", () => ({}));`;
		const failures = await findUnauthorizedMocks(
			["src/admin/api/users.test.ts"],
			fileRead,
			exceptions,
		);
		expect(failures).toHaveLength(1);
		expect(failures[0].testFile).toBe("src/admin/api/users.test.ts");
		expect(failures[0].module).toBe("./internal.js");
		expect(failures[0].line).toBe(1);
	});

	it("does not match an exception for a different test file with the same module", async () => {
		const fileRead = async () => `vi.mock("./client.js", () => ({}));`;
		const failures = await findUnauthorizedMocks(
			["src/other/other.test.ts"],
			fileRead,
			exceptions,
		);
		expect(failures).toHaveLength(1);
		expect(failures[0].testFile).toBe("src/other/other.test.ts");
	});

	it("returns no failures for a test file with only non-relative mocks", async () => {
		const fileRead = async () => `vi.mock("ws", () => ({}));`;
		const failures = await findUnauthorizedMocks(
			["src/admin/api/users.test.ts"],
			fileRead,
			exceptions,
		);
		expect(failures).toEqual([]);
	});

	it("returns no failures for a test file with no mocks", async () => {
		const fileRead = async () => `console.log("no mocks here");`;
		const failures = await findUnauthorizedMocks(
			["src/admin/api/users.test.ts"],
			fileRead,
			exceptions,
		);
		expect(failures).toEqual([]);
	});

	it("reports multiple unauthorized mocks in one file", async () => {
		const fileRead = async () =>
			[
				`vi.mock("./a.js", () => ({}));`,
				`vi.mock("./b.js", () => ({}));`,
			].join("\n");
		const failures = await findUnauthorizedMocks(
			["src/admin/api/users.test.ts"],
			fileRead,
			exceptions,
		);
		expect(failures).toHaveLength(2);
		expect(failures.map((f) => f.module)).toEqual(["./a.js", "./b.js"]);
	});
});

describe("getChangedTestFiles", () => {
	it("filters to .test.ts and .test.tsx files under src/ or tests/", () => {
		const files = [
			"src/index.ts",
			"src/index.test.ts",
			"src/admin/api/users.test.ts",
			"src/admin/features/issues/IssueDetail.test.tsx",
			"tests/integration/foo.test.ts",
			"README.md",
			"src/config.ts",
		];
		expect(getChangedTestFiles(files)).toEqual([
			"src/index.test.ts",
			"src/admin/api/users.test.ts",
			"src/admin/features/issues/IssueDetail.test.tsx",
			"tests/integration/foo.test.ts",
		]);
	});
});

describe("runMockBoundaryGuardrail", () => {
	it("returns ok when there are no changed test files", async () => {
		const result = await runMockBoundaryGuardrail(
			["src/index.ts", "README.md"],
			"/nonexistent/mock-exceptions.json",
		);
		expect(result.ok).toBe(true);
		expect(result.failures).toEqual([]);
	});

	it("returns ok when all relative mocks in changed test files are excepted", async () => {
		const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yolo-mock-"));
		const exceptionsPath = path.join(tmpDir, "mock-exceptions.json");
		await writeFile(
			exceptionsPath,
			JSON.stringify({
				exceptions: [
					{
						testFile: "src/admin/api/users.test.ts",
						module: "./client.js",
						category: "composition-root",
						reason: "HTTP transport client wiring",
					},
				],
			}),
			"utf-8",
		);
		const fileRead = async () => `vi.mock("./client.js", () => ({}));`;
		const result = await runMockBoundaryGuardrail(
			["src/admin/api/users.test.ts"],
			exceptionsPath,
			fileRead,
		);
		expect(result.ok).toBe(true);
		expect(result.failures).toEqual([]);
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("returns not-ok when a changed test file has an unauthorized relative mock", async () => {
		const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yolo-mock-"));
		const exceptionsPath = path.join(tmpDir, "mock-exceptions.json");
		await writeFile(exceptionsPath, JSON.stringify({ exceptions: [] }), "utf-8");
		const fileRead = async () => `vi.mock("./sneaky.js", () => ({}));`;
		const result = await runMockBoundaryGuardrail(
			["src/admin/api/users.test.ts"],
			exceptionsPath,
			fileRead,
		);
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.includes("./sneaky.js"))).toBe(true);
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("treats a missing exceptions file as empty (all relative mocks unauthorized)", async () => {
		const fileRead = async () => `vi.mock("./sneaky.js", () => ({}));`;
		const result = await runMockBoundaryGuardrail(
			["src/admin/api/users.test.ts"],
			"/nonexistent/mock-exceptions.json",
			fileRead,
		);
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.includes("./sneaky.js"))).toBe(true);
	});
});

describe("mock-exceptions.json completeness audit", () => {
	it("lists every relative vi.mock currently present in the test suite", async () => {
		const content = await readFile(MOCK_EXCEPTIONS_FILE, "utf-8");
		const { exceptions } = await parseMockExceptions(content);
		const excepted = new Set(exceptions.map((e) => `${e.testFile}::${e.module}`));

		// Files gathered from a repo-wide grep of `vi.mock("..." )` with
		// relative paths. This is the auditable grandfathered set; any new
		// relative mock must either be added here with an
		// external-adapter/composition-root reason or be rejected by the
		// guardrail.
		const knownRelativeMocks: Array<{ testFile: string; module: string }> = [
			{ testFile: "src/session/stale-detector.test.ts", module: "../adapters/github/octokit.js" },
			{ testFile: "src/adapters/http/admin-router.test.ts", module: "./asset-server.js" },
			{ testFile: "src/admin/features/onboarding/OnboardingWizard.test.tsx", module: "../../api/onboarding.js" },
			{ testFile: "src/admin/features/repos/RepoInventoryScreen.test.tsx", module: "../../api/repos.js" },
			{ testFile: "src/admin/features/repos/RepoManager.test.tsx", module: "../../api/repos.js" },
			{ testFile: "src/admin/features/issues/useRepoIssues.test.ts", module: "../../api/issues.js" },
			{ testFile: "src/admin/features/issues/IssuesScreen.test.tsx", module: "./useRepoIssues.js" },
			{ testFile: "src/admin/features/issues/IssueDetail.test.tsx", module: "../../api/issues.js" },
			{ testFile: "src/admin/features/issues/IssueDetail.test.tsx", module: "../../api/refinements.js" },
			{ testFile: "src/admin/features/issues/IssueDetail.test.tsx", module: "../../api/websocket.js" },
			{ testFile: "src/admin/features/issues/RefinementPanel.test.tsx", module: "../../api/refinements.js" },
			{ testFile: "src/admin/features/issues/RefinementPanel.test.tsx", module: "../../api/websocket.js" },
			{ testFile: "src/admin/features/sessions/SessionScreen.test.tsx", module: "../../hooks/useSessionLog.js" },
			{ testFile: "src/admin/features/sessions/SessionDetail.test.tsx", module: "../../hooks/useSessionLog.js" },
			{ testFile: "src/admin/features/sessions/SessionDetail.test.tsx", module: "../../api/sessions.js" },
			{ testFile: "src/admin/api/users.test.ts", module: "./client.js" },
			{ testFile: "src/admin/api/refinements.test.ts", module: "./client.js" },
			{ testFile: "src/admin/api/sessions.test.ts", module: "./client.js" },
			{ testFile: "src/admin/api/metrics.test.ts", module: "./client.js" },
			{ testFile: "src/admin/api/auth.test.ts", module: "./client.js" },
			{ testFile: "src/executor/index.test.ts", module: "./model-registry.js" },
			{ testFile: "src/executor/index.test.ts", module: "../logging/llm-logger.js" },
			{ testFile: "src/executor/index.test.ts", module: "../logging/session-log-store.js" },
			{ testFile: "src/executor/docker-worker.test.ts", module: "../logging/session-log-store.js" },
			{ testFile: "src/worker/runtime.test.ts", module: "../executor/index.js" },
			{ testFile: "src/worker/entrypoint.test.ts", module: "./runtime.js" },
			{ testFile: "src/app/commands/resume-interrupted-session.test.ts", module: "./workflow-helpers.js" },
			{ testFile: "src/app/commands/resume-interrupted-session.test.ts", module: "./execute-session.js" },
			{ testFile: "src/app/commands/run-session-command.test.ts", module: "../../logging/session-log-store.js" },
		];

		const missing: string[] = [];
		for (const { testFile, module } of knownRelativeMocks) {
			if (!excepted.has(`${testFile}::${module}`)) {
				missing.push(`${testFile} -> ${module}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("every exception references a real, non-relative category and a non-empty reason", async () => {
		const content = await readFile(MOCK_EXCEPTIONS_FILE, "utf-8");
		const { exceptions } = await parseMockExceptions(content);
		const allowed = new Set(["external-adapter", "composition-root", "legacy"]);
		for (const ex of exceptions) {
			expect(allowed.has(ex.category), `bad category for ${ex.testFile} -> ${ex.module}`).toBe(true);
			expect(ex.reason.trim().length, `empty reason for ${ex.testFile} -> ${ex.module}`).toBeGreaterThan(0);
		}
	});
});