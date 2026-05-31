import { describe, expect, it, vi } from "vitest";
import { ExecuteSessionReporter } from "./execute-session-reporter.js";

function makeDeps() {
	return {
		github: {
			postComment: vi.fn(),
			postPRComment: vi.fn(),
			addLabels: vi.fn(),
			removeLabel: vi.fn(),
			getPullRequest: vi.fn(),
			createPullRequest: vi.fn(),
			listPullRequests: vi.fn(),
			getIssue: vi.fn(),
			createIssue: vi.fn(),
			fileSelfReport: vi.fn(),
			listReviewComments: vi.fn(),
		},
		workspaces: {
			createOrGetWorktree: vi.fn(),
			removeWorktree: vi.fn(),
			commitAndPush: vi.fn(),
			hasChanges: vi.fn(),
			getWorktreePath: vi.fn(),
			getGitStatus: vi.fn(async () => " M src/main.ts"),
			getGitDiff: vi.fn(async () => "diff --git a/src/main.ts"),
		},
		sessions: {
			get: vi.fn(),
			getAll: vi.fn(),
			save: vi.fn(),
			delete: vi.fn(),
			archive: vi.fn(),
			createSession: vi.fn(),
			updateStatus: vi.fn(),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
			findSessionByPR: vi.fn(),
			cancelSession: vi.fn(),
			pauseSession: vi.fn(),
			unpauseSession: vi.fn(),
			restartSession: vi.fn(),
			markComplete: vi.fn(),
			markFailed: vi.fn(),
			markStale: vi.fn(),
		},
		selfReportEnabled: false,
	};
}

describe("ExecuteSessionReporter", () => {
	it("posts generic failure comment for non-rate-limit errors", async () => {
		const deps = makeDeps();
		const reporter = new ExecuteSessionReporter(deps as never);
		await reporter.postFailureComment("mbrooks", "tars", 1, new Error("something blew up"), "Processing issue");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("**TARS failed.**"),
		);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("Full trace"),
		);
	});

	it("posts generic failure comment when error is not an Error instance", async () => {
		const deps = makeDeps();
		const reporter = new ExecuteSessionReporter(deps as never);
		await reporter.postFailureComment("mbrooks", "tars", 1, "plain string error", "Processing issue");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("Error: plain string error"),
		);
	});

	it("truncates stack traces longer than 3000 characters", async () => {
		const deps = makeDeps();
		const reporter = new ExecuteSessionReporter(deps as never);
		const error = new Error("boom");
		error.stack = "x".repeat(4000);
		await reporter.postFailureComment("mbrooks", "tars", 1, error, "Processing issue");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("... (truncated)"),
		);
	});

	it("posts generic failure comment when error stack is missing", async () => {
		const deps = makeDeps();
		const reporter = new ExecuteSessionReporter(deps as never);
		const error = new Error("no stack");
		delete (error as Error & { stack?: string }).stack;
		await reporter.postFailureComment("mbrooks", "tars", 1, error, "Processing issue");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("**TARS failed.**"),
		);
	});

	it("posts 'Build failed' comment for Ollama 429 rate-limit errors", async () => {
		const deps = makeDeps();
		const reporter = new ExecuteSessionReporter(deps as never);
		const error = new Error('429 "you (aubiematt) have reached your weekly usage limit..."');
		await reporter.postFailureComment("mbrooks", "tars", 1, error, "Processing issue");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("**Build failed**"),
		);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("TARS encountered a 429 rate-limit error from Ollama"),
		);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.not.stringContaining("Full trace"),
		);
	});

	it("posts delivery failure comment with diagnostics when self-report is disabled", async () => {
		const deps = makeDeps();
		deps.selfReportEnabled = false;
		const reporter = new ExecuteSessionReporter(deps as never);
		const state = {
			owner: "mbrooks",
			repo: "tars",
			issueNumber: 1,
			workspacePath: "/tmp/ws",
		} as import("../../session/store.js").SessionState;
		await reporter.handleDeliveryFailure("mbrooks", "tars", 1, state, new Error("push failed"));
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("TARS delivery failed."),
		);
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "failed");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 1, ["tars-working", "tars-delivery-failed"]);
	});

	it("posts delivery failure comment when error is not an Error instance and workspace listing succeeds", async () => {
		const deps = makeDeps();
		deps.selfReportEnabled = false;
		const reporter = new ExecuteSessionReporter(deps as never);
		const state = {
			owner: "mbrooks",
			repo: "tars",
			issueNumber: 1,
			workspacePath: process.cwd(),
		} as import("../../session/store.js").SessionState;
		await reporter.handleDeliveryFailure("mbrooks", "tars", 1, state, "plain string error");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("TARS delivery failed."),
		);
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "failed");
	});

	it("posts delivery failure comment when error stack is missing", async () => {
		const deps = makeDeps();
		deps.selfReportEnabled = false;
		const reporter = new ExecuteSessionReporter(deps as never);
		const state = {
			owner: "mbrooks",
			repo: "tars",
			issueNumber: 1,
			workspacePath: "/tmp/ws",
		} as import("../../session/store.js").SessionState;
		const error = new Error("no stack");
		delete (error as Error & { stack?: string }).stack;
		await reporter.handleDeliveryFailure("mbrooks", "tars", 1, state, error);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("TARS delivery failed."),
		);
	});

	it("truncates delivery failure stack trace when longer than 3000 characters", async () => {
		const deps = makeDeps();
		deps.selfReportEnabled = false;
		const reporter = new ExecuteSessionReporter(deps as never);
		const state = {
			owner: "mbrooks",
			repo: "tars",
			issueNumber: 1,
			workspacePath: "/tmp/ws",
		} as import("../../session/store.js").SessionState;
		const error = new Error("long stack");
		error.stack = "x".repeat(4000);
		await reporter.handleDeliveryFailure("mbrooks", "tars", 1, state, error);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("... (truncated)"),
		);
	});

	it("posts delivery failure comment when self-report is enabled, git diagnostics fail, and PAT hint partially matches", async () => {
		const deps = makeDeps();
		deps.selfReportEnabled = true;
		(deps.workspaces.getGitStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("git status failed"));
		(deps.workspaces.getGitDiff as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("git diff failed"));
		const reporter = new ExecuteSessionReporter(deps as never);
		const state = {
			owner: "mbrooks",
			repo: "tars",
			issueNumber: 1,
			workspacePath: "/tmp/ws",
		} as import("../../session/store.js").SessionState;
		await reporter.handleDeliveryFailure(
			"mbrooks",
			"tars",
			1,
			state,
			new Error("refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml`"),
		);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			expect.stringContaining("TARS delivery failed."),
		);
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "failed");
		expect(deps.github.fileSelfReport).toHaveBeenCalled();
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "tars", 1, ["tars-working", "tars-delivery-failed"]);
	});
});
