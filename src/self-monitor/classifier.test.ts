import { describe, expect, it } from "vitest";

import { classifyFatalError, normalizeOutput } from "./classifier.js";

describe("normalizeOutput", () => {
	it("returns string results as-is", () => {
		const normalized = normalizeOutput("hello world");
		expect(normalized.output).toBe("hello world");
		expect(normalized.exitCode).toBeUndefined();
	});

	it("extracts output and exitCode from objects", () => {
		const normalized = normalizeOutput({ output: "stdout", exitCode: 2 });
		expect(normalized.output).toBe("stdout");
		expect(normalized.exitCode).toBe(2);
	});

	it("falls back to stdout field", () => {
		const normalized = normalizeOutput({ stdout: "std", code: 1 });
		expect(normalized.output).toBe("std");
		expect(normalized.exitCode).toBe(1);
	});

	it("returns empty for unknown types", () => {
		const normalized = normalizeOutput(123);
		expect(normalized.output).toBe("");
	});
});

describe("classifyFatalError", () => {
	it("detects missing binary after install in node_modules/.bin/", () => {
		const result = classifyFatalError({
			toolName: "bash",
			result: { output: "ls: cannot access 'node_modules/.bin/vitest': No such file or directory\nCommand exited with code 2", exitCode: 2 },
			isError: true,
		});
		expect(result).not.toBeNull();
		expect(result?.category).toBe("missing_binary_after_install");
		expect(result?.message).toContain("node_modules/.bin/vitest");
	});

	it("detects permission denied from EACCES", () => {
		const result = classifyFatalError({
			toolName: "bash",
			result: { output: "npm ERR! code EACCES\nnpm ERR! syscall mkdir", exitCode: 1 },
			isError: true,
		});
		expect(result?.category).toBe("permission_denied");
	});

	it("detects permission denied from EPERM", () => {
		const result = classifyFatalError({
			toolName: "bash",
			result: { output: "Error: EPERM: operation not permitted", exitCode: 1 },
			isError: true,
		});
		expect(result?.category).toBe("permission_denied");
	});

	it("detects disk full ENOSPC", () => {
		const result = classifyFatalError({
			toolName: "bash",
			result: { output: "write error: No space left on device (ENOSPC)", exitCode: 1 },
			isError: true,
		});
		expect(result?.category).toBe("disk_full");
	});

	it("detects git worktree failure", () => {
		const result = classifyFatalError({
			toolName: "bash",
			result: { output: "fatal: 'worktree' is not a valid ref name.", exitCode: 128 },
			isError: true,
		});
		expect(result?.category).toBe("git_worktree_failure");
	});

	it("detects git checkout failure", () => {
		const result = classifyFatalError({
			toolName: "bash",
			result: { output: "fatal: unable to checkout worktree path", exitCode: 128 },
			isError: true,
		});
		expect(result?.category).toBe("git_worktree_failure");
	});

	it("detects missing toolchain binary", () => {
		const result = classifyFatalError({
			toolName: "bash",
			result: { output: "vitest: command not found", exitCode: 127 },
			isError: true,
		});
		expect(result?.category).toBe("missing_toolchain_binary");
	});

	it("returns null for benign results", () => {
		const result = classifyFatalError({
			toolName: "bash",
			result: { output: "hello world", exitCode: 0 },
			isError: false,
		});
		expect(result).toBeNull();
	});

	it("returns null for non-bash tools", () => {
		const result = classifyFatalError({
			toolName: "read",
			result: { output: "some file content" },
			isError: false,
		});
		expect(result).toBeNull();
	});
});
