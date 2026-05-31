import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SelfEvolutionEngine } from "./engine.js";
import { Validator } from "./validator.js";

function makeGithub() {
	return {
		createIssue: vi.fn(async () => ({ number: 1, html_url: "https://github.com/mbrooks/tars/issues/1" })),
		postComment: vi.fn(),
		addLabels: vi.fn(),
		removeLabel: vi.fn(),
		getPullRequest: vi.fn(),
		createPullRequest: vi.fn(),
		listPullRequests: vi.fn(async () => []),
		getIssue: vi.fn(),
		fileSelfReport: vi.fn(),
		listReviewComments: vi.fn(),
		listLabels: vi.fn(),
		getIssueTemplates: vi.fn(),
		listRecentCommits: vi.fn(),
		listRelatedIssues: vi.fn(),
		postPRComment: vi.fn(),
	};
}

describe("SelfEvolutionEngine", () => {
	it("skips non-code-level errors", async () => {
		const github = makeGithub();
		const engine = new SelfEvolutionEngine({
			github: github as any,
			repoPath: "/tmp/repo",
			selfReportRepo: { owner: "mbrooks", repo: "tars" },
		});

		const error = new Error("JSON parse error");
		await engine.handleError(error);

		expect(github.createIssue).not.toHaveBeenCalled();
	});

	it("files an issue for code-level error when no patch generated", async () => {
		const github = makeGithub();
		const engine = new SelfEvolutionEngine({
			github: github as any,
			repoPath: "/tmp/repo",
			selfReportRepo: { owner: "mbrooks", repo: "tars" },
		});

		const error = new Error("Random code error");
		error.stack = "Error: Random\n    at /tmp/repo/src/main.ts:1:1";
		await engine.handleError(error);

		expect(github.createIssue).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			expect.stringContaining("Self-evolution patch"),
			expect.stringContaining("Root Cause Analysis"),
			["tars-self-evolution", "bug"],
		);
	});

	it("applies patch, validates, and files issue for successful fix", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-engine-"));
		const srcDir = path.join(dir, "src");
		await mkdir(srcDir, { recursive: true });
		const filePath = path.join(srcDir, "demo.ts");
		await writeFile(filePath, "const x = obj.prop;\n", "utf-8");

		const github = makeGithub();
		const engine = new SelfEvolutionEngine({
			github: github as any,
			repoPath: dir,
			selfReportRepo: { owner: "mbrooks", repo: "tars" },
		});
		const validator = new Validator();
		vi.spyOn(validator, "validate").mockResolvedValue({ ok: true, output: "pass" });
		(engine as any).validator = validator;

		const error = new Error("Cannot read properties of undefined (reading 'prop')");
		error.stack = `Error: Cannot read properties of undefined (reading 'prop')\n    at ${filePath}:1:11`;
		await engine.handleError(error);

		expect(await readFile(filePath, "utf-8")).toBe("const x = obj?.prop;\n");
		expect(github.createIssue).toHaveBeenCalled();
	});

	it("rolls back patch when validation fails", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "tars-engine-"));
		const srcDir = path.join(dir, "src");
		await mkdir(srcDir, { recursive: true });
		const filePath = path.join(srcDir, "demo.ts");
		await writeFile(filePath, "const x = obj.prop;\n", "utf-8");

		const github = makeGithub();
		const engine = new SelfEvolutionEngine({
			github: github as any,
			repoPath: dir,
			selfReportRepo: { owner: "mbrooks", repo: "tars" },
		});
		const validator = new Validator();
		vi.spyOn(validator, "validate").mockResolvedValue({ ok: false, output: "fail" });
		(engine as any).validator = validator;

		const error = new Error("Cannot read properties of undefined (reading 'prop')");
		error.stack = `Error: Cannot read properties of undefined (reading 'prop')\n    at ${filePath}:1:11`;
		await engine.handleError(error);

		expect(await readFile(filePath, "utf-8")).toBe("const x = obj.prop;\n");
		expect(github.createIssue).toHaveBeenCalled();
	});
});
