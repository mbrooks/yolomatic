import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FatalSystemError, SelfMonitor } from "./index.js";

describe("SelfMonitor", () => {
	it("records tool history and detects fatal errors", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-sm-"));
		const monitor = new SelfMonitor(dir);

		monitor.recordToolEnd("read", { content: "hello" }, false);
		monitor.recordToolEnd("bash", "ls: cannot access 'node_modules/.bin/vitest': No such file or directory\nCommand exited with code 2", true);

		expect(monitor.hasFatalError()).toBe(true);
	});

	it("does not flag benign results", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-sm-"));
		const monitor = new SelfMonitor(dir);

		monitor.recordToolEnd("bash", { output: "hello", exitCode: 0 }, false);

		expect(monitor.hasFatalError()).toBe(false);
	});

	it("gathers system evidence on fatal error", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-sm-"));
		await writeFile(path.join(dir, "file.txt"), "test");

		const monitor = new SelfMonitor(dir);
		monitor.recordToolEnd("bash", { output: "EACCES", exitCode: 1 }, true);

		const error = await monitor.createFatalSystemError();
		expect(error).toBeInstanceOf(FatalSystemError);
		expect(error.evidence.systemEvidence.whoami).toBeTruthy();
		expect(await realpath(error.evidence.systemEvidence.pwd)).toBe(await realpath(dir));
		expect(error.evidence.systemEvidence.lsWorkspace).toContain("file.txt");
		expect(error.evidence.systemEvidence.gitBranch).toBeTruthy();
		expect(error.evidence.systemEvidence.nodeVersion).toContain("v");
	});

	it("truncates long results in history", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-sm-"));
		const monitor = new SelfMonitor(dir);

		const longOutput = "x".repeat(3000);
		monitor.recordToolEnd("bash", longOutput, false);

		expect(monitor.hasFatalError()).toBe(false);
		const record = (monitor as unknown as { toolHistory: Array<{ result: string }> }).toolHistory[0];
		expect(record.result.length).toBeLessThan(3000);
	});

	it("throws when creating fatal error without one", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-sm-"));
		const monitor = new SelfMonitor(dir);
		await expect(monitor.createFatalSystemError()).rejects.toThrow("No fatal error recorded");
	});

	it("formats a bug report body", async () => {
		const body = SelfMonitor.formatBugReportBody({
			toolHistory: [{ toolName: "bash", args: undefined, result: "err", isError: true, timestamp: "2024-01-01T00:00:00Z" }],
			fatalError: { category: "permission_denied", message: "EACCES", toolName: "bash" },
			systemEvidence: {
				whoami: "yeetomatic",
				pwd: "/tmp",
				workspacePath: "/tmp/ws",
				lsWorkspace: "total 0",
				gitStatus: "",
				gitDiff: "",
				gitBranch: "main",
				nodeVersion: "v20.0.0",
				timestamp: "2024-01-01T00:00:00Z",
			},
		});

		expect(body).toContain("permission_denied");
		expect(body).toContain("yeetomatic");
		expect(body).toContain("/tmp/ws");
		expect(body).toContain("Suggested remediation");
	});

	it("includes correct remediation for github_pat_scope_missing", async () => {
		const body = SelfMonitor.formatBugReportBody({
			toolHistory: [{ toolName: "bash", args: undefined, result: "err", isError: true, timestamp: "2024-01-01T00:00:00Z" }],
			fatalError: { category: "github_pat_scope_missing", message: "PAT scope missing", toolName: "bash" },
			systemEvidence: {
				whoami: "yeetomatic",
				pwd: "/tmp",
				workspacePath: "/tmp/ws",
				lsWorkspace: "total 0",
				gitStatus: "",
				gitDiff: "",
				gitBranch: "main",
				nodeVersion: "v20.0.0",
				timestamp: "2024-01-01T00:00:00Z",
			},
		});

		expect(body).toContain("github_pat_scope_missing");
		expect(body).toContain("workflow");
	});

	it("returns hardcoded target repo", () => {
		expect(SelfMonitor.getTargetRepo()).toEqual({ owner: "mbrooks", repo: "yeetomatic" });
	});

	it("sanitizes tokens in output", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-sm-"));
		const monitor = new SelfMonitor(dir);
		monitor.recordToolEnd("bash", "ghp_secret123abc", false);
		const record = (monitor as unknown as { toolHistory: Array<{ result: string }> }).toolHistory[0];
		expect(record.result).not.toContain("ghp_");
		expect(record.result).toContain("[REDACTED]");
	});
});

describe("FatalSystemError", () => {
	it("carries evidence", () => {
		const evidence = {
			toolHistory: [],
			fatalError: { category: "disk_full" as const, message: "No space", toolName: "bash" },
			systemEvidence: {
				whoami: "yeetomatic",
				pwd: "/tmp",
				workspacePath: "/tmp/ws",
				lsWorkspace: "",
				gitStatus: "",
				gitDiff: "",
				gitBranch: "main",
				nodeVersion: "v20",
				timestamp: "2024-01-01T00:00:00Z",
			},
		};
		const err = new FatalSystemError(evidence);
		expect(err.name).toBe("FatalSystemError");
		expect(err.message).toContain("disk_full");
		expect(err.evidence).toBe(evidence);
	});
});
