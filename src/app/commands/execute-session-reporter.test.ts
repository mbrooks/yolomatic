import { describe, expect, it, vi } from "vitest";
import { ExecuteSessionReporter } from "./execute-session-reporter.js";

function makeDeps() {
	return {
		github: {
			postComment: vi.fn(async () => 1),
			postPRComment: vi.fn(async () => 1),
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
			commitAndPushPath: vi.fn(async () => true),
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
		await reporter.postFailureComment({ kind: "issue", number: 1 }, "mbrooks", "yolomatic", new Error("something blew up"), "Processing issue");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("**Yolomatic failed.**"),
		);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Full trace"),
		);
	});

	it("posts generic failure comment when error is not an Error instance", async () => {
		const deps = makeDeps();
		const reporter = new ExecuteSessionReporter(deps as never);
		await reporter.postFailureComment({ kind: "issue", number: 1 }, "mbrooks", "yolomatic", "plain string error", "Processing issue");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Error: plain string error"),
		);
	});

	it("truncates stack traces longer than 3000 characters", async () => {
		const deps = makeDeps();
		const reporter = new ExecuteSessionReporter(deps as never);
		const error = new Error("boom");
		error.stack = "x".repeat(4000);
		await reporter.postFailureComment({ kind: "issue", number: 1 }, "mbrooks", "yolomatic", error, "Processing issue");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("... (truncated)"),
		);
	});

	it("posts generic failure comment when error stack is missing", async () => {
		const deps = makeDeps();
		const reporter = new ExecuteSessionReporter(deps as never);
		const error = new Error("no stack");
		delete (error as Error & { stack?: string }).stack;
		await reporter.postFailureComment({ kind: "issue", number: 1 }, "mbrooks", "yolomatic", error, "Processing issue");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("**Yolomatic failed.**"),
		);
	});

	it("posts 'Build failed' comment for Ollama 429 rate-limit errors", async () => {
		const deps = makeDeps();
		const reporter = new ExecuteSessionReporter(deps as never);
		const error = new Error('429 "you (aubiematt) have reached your weekly usage limit..."');
		await reporter.postFailureComment({ kind: "issue", number: 1 }, "mbrooks", "yolomatic", error, "Processing issue");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("**Build failed**"),
		);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Yolomatic encountered a 429 rate-limit error from Ollama"),
		);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.not.stringContaining("Full trace"),
		);
	});

	it("posts failure comments to PRs", async () => {
		const deps = makeDeps();
		const reporter = new ExecuteSessionReporter(deps as never);
		await reporter.postFailureComment(
			{ kind: "pull_request", number: 99 },
			"mbrooks",
			"yolomatic",
			new Error("review failed"),
			"Processing PR review",
		);
		expect(deps.github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			99,
			expect.stringContaining("**Yolomatic failed.**"),
		);
	});

	it("handles waiting-feedback for issue targets", async () => {
		const deps = makeDeps();
		const reporter = new ExecuteSessionReporter(deps as never);
		await reporter.handleExecutionResult({
			owner: "mbrooks",
			repo: "yolomatic",
			sessionIssueNumber: 1,
			target: { kind: "issue", number: 1 },
			result: { status: "waiting-feedback", summary: "Need more detail", rawResponse: "" },
			context: "Processing issue",
			state: {
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 1,
				title: "Issue",
				body: "Body",
				status: "working",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: "/tmp/ws",
				lastActivity: new Date().toISOString(),
				seeded: true,
			},
		});
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "waiting-feedback");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-feedback-required"]);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Need clarification:"),
		);
	});

	it("uses the default cancelled summary for issues when none is provided", async () => {
		const deps = makeDeps();
		const reporter = new ExecuteSessionReporter(deps as never);
		await reporter.handleExecutionResult({
			owner: "mbrooks",
			repo: "yolomatic",
			sessionIssueNumber: 1,
			target: { kind: "issue", number: 1 },
			result: { status: "cancelled", summary: "", rawResponse: "" },
			context: "Processing issue",
			state: {
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 1,
				title: "Issue",
				body: "Body",
				status: "working",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: "/tmp/ws",
				lastActivity: new Date().toISOString(),
				seeded: true,
			},
		});
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "cancelled");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-cancelled"]);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Yolomatic has stopped working on this issue."),
		);
	});

	it("uses the default cancelled summary for PRs when none is provided", async () => {
		const deps = makeDeps();
		const reporter = new ExecuteSessionReporter(deps as never);
		await reporter.handleExecutionResult({
			owner: "mbrooks",
			repo: "yolomatic",
			sessionIssueNumber: 1,
			target: { kind: "pull_request", number: 7 },
			result: { status: "cancelled", summary: "", rawResponse: "" },
			context: "Processing issue",
			state: {
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 1,
				title: "Issue",
				body: "Body",
				status: "working",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: "/tmp/ws",
				lastActivity: new Date().toISOString(),
				seeded: true,
			},
		});
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "cancelled");
		expect(deps.github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			7,
			expect.stringContaining("Yolomatic has stopped working on this review."),
		);
	});

	it("handles complete results for PR targets", async () => {
		const deps = makeDeps();
		const reporter = new ExecuteSessionReporter(deps as never);
		await reporter.handleExecutionResult({
			owner: "mbrooks",
			repo: "yolomatic",
			sessionIssueNumber: 1,
			target: { kind: "pull_request", number: 99 },
			result: { status: "complete", summary: "Fixed the bug.", rawResponse: "" },
			context: "Processing PR review",
			state: {
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 1,
				title: "Issue",
				body: "Body",
				status: "working",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: "/tmp/ws",
				lastActivity: new Date().toISOString(),
				seeded: true,
				labels: ["bug"],
				branch: "yolomatic/issue-1",
			},
		});
		expect(deps.workspaces.commitAndPushPath).toHaveBeenCalledWith("/tmp/ws", "yolomatic/issue-1", "fix: Fix the bug");
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "complete");
		expect(deps.github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			99,
			expect.stringContaining("iteration complete"),
		);
	});

	it("handles failed results for PR targets", async () => {
		const deps = makeDeps();
		const reporter = new ExecuteSessionReporter(deps as never);
		await reporter.handleExecutionResult({
			owner: "mbrooks",
			repo: "yolomatic",
			sessionIssueNumber: 1,
			target: { kind: "pull_request", number: 99 },
			result: { status: "failed", summary: "plain failure", rawResponse: "" },
			context: "Processing PR review",
			state: {
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 1,
				title: "Issue",
				body: "Body",
				status: "working",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: "/tmp/ws",
				lastActivity: new Date().toISOString(),
				seeded: true,
			},
		});
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed");
		expect(deps.github.postPRComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			99,
			expect.stringContaining("**Yolomatic failed.**"),
		);
	});

	it("posts delivery failure comment with diagnostics when self-report is disabled", async () => {
		const deps = makeDeps();
		deps.selfReportEnabled = false;
		const reporter = new ExecuteSessionReporter(deps as never);
		const state = {
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 1,
			workspacePath: "/tmp/ws",
		} as import("../../session/store.js").SessionState;
		await reporter.handleDeliveryFailure("mbrooks", "yolomatic", 1, state, new Error("push failed"));
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Yolomatic delivery failed."),
		);
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed");
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-working", "yolomatic-delivery-failed"]);
	});

	it("posts delivery failure comment when error is not an Error instance and workspace listing succeeds", async () => {
		const deps = makeDeps();
		deps.selfReportEnabled = false;
		const reporter = new ExecuteSessionReporter(deps as never);
		const state = {
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 1,
			workspacePath: process.cwd(),
		} as import("../../session/store.js").SessionState;
		await reporter.handleDeliveryFailure("mbrooks", "yolomatic", 1, state, "plain string error");
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Yolomatic delivery failed."),
		);
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed");
	});

	it("posts delivery failure comment when error stack is missing", async () => {
		const deps = makeDeps();
		deps.selfReportEnabled = false;
		const reporter = new ExecuteSessionReporter(deps as never);
		const state = {
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 1,
			workspacePath: "/tmp/ws",
		} as import("../../session/store.js").SessionState;
		const error = new Error("no stack");
		delete (error as Error & { stack?: string }).stack;
		await reporter.handleDeliveryFailure("mbrooks", "yolomatic", 1, state, error);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Yolomatic delivery failed."),
		);
	});

	it("truncates delivery failure stack trace when longer than 3000 characters", async () => {
		const deps = makeDeps();
		deps.selfReportEnabled = false;
		const reporter = new ExecuteSessionReporter(deps as never);
		const state = {
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 1,
			workspacePath: "/tmp/ws",
		} as import("../../session/store.js").SessionState;
		const error = new Error("long stack");
		error.stack = "x".repeat(4000);
		await reporter.handleDeliveryFailure("mbrooks", "yolomatic", 1, state, error);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
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
			repo: "yolomatic",
			issueNumber: 1,
			workspacePath: "/tmp/ws",
		} as import("../../session/store.js").SessionState;
		await reporter.handleDeliveryFailure(
			"mbrooks",
			"yolomatic",
			1,
			state,
			new Error("refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml`"),
		);
		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			expect.stringContaining("Yolomatic delivery failed."),
		);
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "failed");
		expect(deps.github.fileSelfReport).toHaveBeenCalled();
		expect(deps.github.addLabels).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ["yolomatic-working", "yolomatic-delivery-failed"]);
	});
});
