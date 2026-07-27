import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GitHubService } from "../../ports/github-service.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { SessionState } from "../../session/store.js";
import type { FatalErrorCategory } from "../../self-monitor/types.js";
import { FatalSystemError, SelfMonitor } from "../../self-monitor/index.js";
import { isRateLimitError, type ExecutionResult } from "../../executor/index.js";
import { generateCommitMessage } from "../../workspace/commit-message.js";
import { removeWorkflowLabels } from "./workflow-helpers.js";

const execFileAsync = promisify(execFile);

type ExecutionCommentTarget =
	| { kind: "issue"; number: number }
	| { kind: "pull_request"; number: number };

export class ExecuteSessionReporter {
	constructor(
		private readonly deps: {
			github: GitHubService;
			workspaces: WorkspaceService;
			sessions: SessionRepository;
			selfReportEnabled: boolean;
		},
	) {}

	async postFailureComment(
		target: ExecutionCommentTarget,
		owner: string,
		repo: string,
		error: unknown,
		context: string,
	): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		if (isRateLimitError(message)) {
			const body = [
				"**Build failed**",
				"",
				"Yeetomatic encountered a 429 rate-limit error from Ollama and auto-retry was exhausted. The session cannot continue until usage limits are reset or the model is switched.",
				"",
				`Error: ${message}`,
			].join("\n");
			await this.postComment(target, owner, repo, body);
			return;
		}
		const stack = error instanceof Error ? error.stack ?? "" : "";
		const truncatedStack = stack.length > 3000 ? stack.slice(0, 3000) + "\n... (truncated)" : stack;
		const body = [
			"**Yeetomatic failed.**",
			"",
			`Context: ${context}`,
			`Error: ${message}`,
			"",
			"<details>",
			"<summary>Full trace</summary>",
			`<pre>${truncatedStack}</pre>`,
			"</details>",
		].join("\n");
		await this.postComment(target, owner, repo, body);
	}

	async handleExecutionFailure(args: {
		owner: string;
		repo: string;
		sessionIssueNumber: number;
		target: ExecutionCommentTarget;
		error: unknown;
		context: string;
	}): Promise<void> {
		await this.postFailureComment(args.target, args.owner, args.repo, args.error, args.context);
		await this.deps.sessions.updateStatus(args.owner, args.repo, args.sessionIssueNumber, "failed");
		if (args.target.kind === "issue") {
			await removeWorkflowLabels(this.deps.github, args.owner, args.repo, args.sessionIssueNumber);
			await this.deps.github.addLabels(args.owner, args.repo, args.sessionIssueNumber, ["yeetomatic-failed"]);
		}
	}

	async handleExecutionResult(args: {
		owner: string;
		repo: string;
		sessionIssueNumber: number;
		target: ExecutionCommentTarget;
		result: ExecutionResult;
		context: string;
		state: SessionState;
	}): Promise<void> {
		const { owner, repo, sessionIssueNumber, target, result, context, state } = args;

		if (target.kind === "issue") {
			await removeWorkflowLabels(this.deps.github, owner, repo, sessionIssueNumber);
		}

		if (result.status === "waiting-feedback") {
			await this.deps.sessions.updateStatus(owner, repo, sessionIssueNumber, "waiting-feedback");
			if (target.kind === "issue") {
				await this.deps.github.addLabels(owner, repo, sessionIssueNumber, ["yeetomatic-feedback-required"]);
			}
			await this.postComment(
				target,
				owner,
				repo,
				[
					"Need clarification:",
					result.summary || "Yeetomatic needs more information before continuing.",
				].join("\n\n"),
			);
			return;
		}

		if (result.status === "cancelled") {
			await this.deps.sessions.updateStatus(owner, repo, sessionIssueNumber, "cancelled");
			if (target.kind === "issue") {
				await this.deps.github.addLabels(owner, repo, sessionIssueNumber, ["yeetomatic-cancelled"]);
			}
			await this.postComment(
				target,
				owner,
				repo,
				[
					"Task cancelled by admin.",
					"",
					result.summary || this.defaultCancelledSummary(target),
					"",
					"Yeetomatic is idle and ready for the next task.",
				].join("\n"),
			);
			return;
		}

		if (result.status === "failed") {
			await this.handleExecutionFailure({
				owner,
				repo,
				sessionIssueNumber,
				target,
				error: new Error(result.summary),
				context,
			});
			return;
		}

		if (result.status === "complete") {
			if (target.kind === "pull_request") {
				await this.handlePullRequestCompletion(owner, repo, sessionIssueNumber, target.number, state, result);
				return;
			}
			throw new Error("Issue completion should be handled by ExecuteSessionDelivery.");
		}

		await this.deps.sessions.updateStatus(owner, repo, sessionIssueNumber, "working");
		if (target.kind === "issue") {
			await this.deps.github.addLabels(owner, repo, sessionIssueNumber, ["yeetomatic-working"]);
		}
		await this.postComment(
			target,
			owner,
			repo,
			[
				target.kind === "issue"
					? "Yeetomatic is still working on this issue."
					: "Yeetomatic is still working on the review feedback.",
				"",
				result.summary || "Execution is in progress.",
			].join("\n"),
		);
	}

	async handleDeliveryFailure(
		owner: string,
		repo: string,
		issueNumber: number,
		state: SessionState,
		error: unknown,
	): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		const diagnostics = await this.gatherDeliveryDiagnostics(owner, repo, issueNumber, state);
		const scopeHint = this.getPATScopeHint(message);

		let commentBody: string;
		if (this.deps.selfReportEnabled) {
			const issueUrl = await this.fileSelfReport(this.createDeliveryFatalError(state, message, diagnostics));
			commentBody = [
				"**Yeetomatic delivery failed.**",
				"",
				scopeHint,
				`A bug report has been filed in \`mbrooks/tars\`: ${issueUrl}`,
				"",
				"<details>",
				"<summary>Delivery diagnostics</summary>",
				"",
				`Worktree: \`${state.workspacePath}\``,
				"",
				"Git status:",
				"```",
				diagnostics.gitStatus || "(clean)",
				"```",
				"",
				"Git diff:",
				"```",
				diagnostics.gitDiff || "(none)",
				"```",
				"</details>",
			].filter(Boolean).join("\n");
			process.stdout.write(`[execute] delivery failure self-reported for ${repo}#${issueNumber}: ${issueUrl}\n`);
		} else {
			const stack = error instanceof Error ? (error.stack ?? "") : "";
			const truncatedStack = stack.length > 3000 ? stack.slice(0, 3000) + "\n... (truncated)" : stack;
			commentBody = [
				"**Yeetomatic delivery failed.**",
				"",
				scopeHint,
				`Context: Delivering completed work`,
				`Error: ${message}`,
				"",
				"<details>",
				"<summary>Delivery diagnostics</summary>",
				"",
				`Worktree: \`${state.workspacePath}\``,
				"",
				"Git status:",
				"```",
				diagnostics.gitStatus || "(clean)",
				"```",
				"",
				"Git diff:",
				"```",
				diagnostics.gitDiff || "(none)",
				"```",
				"</details>",
				"",
				"<details>",
				"<summary>Full trace</summary>",
				`<pre>${truncatedStack}</pre>`,
				"</details>",
			].filter(Boolean).join("\n");
		}

		await this.deps.github.postComment(owner, repo, issueNumber, commentBody);
		await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "yeetomatic-feedback-required");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "yeetomatic-pr-created");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "yeetomatic-complete");
		await this.deps.github.addLabels(owner, repo, issueNumber, ["yeetomatic-working", "yeetomatic-delivery-failed"]);
	}

	private classifyDeliveryError(message: string): FatalErrorCategory {
		const lower = message.toLowerCase();
		if (lower.includes("refusing to allow a personal access token") && lower.includes("scope")) {
			return "github_pat_scope_missing";
		}
		return "git_worktree_failure";
	}

	private createDeliveryFatalError(
		state: SessionState,
		message: string,
		diagnostics: { gitStatus: string; gitDiff: string; lsWorkspace: string },
	): FatalSystemError {
		return new FatalSystemError({
			toolHistory: [
				{
					toolName: "workspace.commitAndPush/createPR",
					args: undefined,
					result: message,
					isError: true,
					timestamp: new Date().toISOString(),
				},
			],
			fatalError: {
				category: this.classifyDeliveryError(message),
				message,
				toolName: "workspace.commitAndPush/createPR",
			},
			systemEvidence: {
				whoami: process.env.USER ?? process.env.LOGNAME ?? "unknown",
				pwd: process.cwd(),
				workspacePath: state.workspacePath,
				lsWorkspace: diagnostics.lsWorkspace,
				gitStatus: diagnostics.gitStatus,
				gitDiff: diagnostics.gitDiff,
				gitBranch: `yeetomatic/issue-${state.issueNumber}`,
				nodeVersion: process.version,
				timestamp: new Date().toISOString(),
			},
		});
	}

	private async gatherDeliveryDiagnostics(
		owner: string,
		repo: string,
		issueNumber: number,
		state: SessionState,
	): Promise<{ gitStatus: string; gitDiff: string; lsWorkspace: string }> {
		const [gitStatus, gitDiff, lsWorkspace] = await Promise.all([
			this.deps.workspaces.getGitStatus(owner, repo, issueNumber).catch(() => "(failed)"),
			this.deps.workspaces.getGitDiff(owner, repo, issueNumber).catch(() => "(failed)"),
			this.getWorkspaceListing(state.workspacePath),
		]);
		return { gitStatus, gitDiff, lsWorkspace };
	}

	private async getWorkspaceListing(workspacePath: string): Promise<string> {
		try {
			const { stdout } = await execFileAsync("ls", ["-la", workspacePath], { timeout: 10000 });
			return stdout;
		} catch {
			return "(failed to list workspace)";
		}
	}

	private getPATScopeHint(message: string): string {
		const lower = message.toLowerCase();
		if (
			lower.includes("refusing to allow a personal access token") &&
			lower.includes("workflow") &&
			lower.includes("scope")
		) {
			return "The GitHub PAT is missing the `workflow` scope. Update the token in GitHub settings and restart Yeetomatic.";
		}
		return "";
	}

	private async fileSelfReport(error: FatalSystemError): Promise<string> {
		const body = SelfMonitor.formatBugReportBody(error.evidence);
		const title = SelfMonitor.getIssueTitle(error.evidence);
		return this.deps.github.fileSelfReport(title, body, ["yeetomatic-self-report", "bug"]);
	}

	private async handlePullRequestCompletion(
		owner: string,
		repo: string,
		issueNumber: number,
		prNumber: number,
		state: SessionState,
		result: ExecutionResult,
	): Promise<void> {
		const branchName = state.branch ?? `yeetomatic/issue-${issueNumber}`;
		const pushed = await this.deps.workspaces.commitAndPushPath(
			state.workspacePath,
			branchName,
			generateCommitMessage(state.labels, issueNumber, result.summary),
		);
		await this.deps.sessions.updateStatus(owner, repo, issueNumber, "complete");
		if (pushed) {
			await this.deps.github.postPRComment(
				owner,
				repo,
				prNumber,
				[
					"**Yeetomatic iteration complete.**",
					"",
					"Changes pushed to the PR branch.",
					"",
					"Summary:",
					result.summary || "No summary provided.",
				].join("\n"),
			);
			return;
		}

		await this.deps.github.postPRComment(
			owner,
			repo,
			prNumber,
			[
				"**Yeetomatic iteration complete.**",
				"",
				"No changes were needed.",
				"",
				"Summary:",
				result.summary || "No summary provided.",
			].join("\n"),
		);
	}

	private defaultCancelledSummary(target: ExecutionCommentTarget): string {
		return target.kind === "issue"
			? "Yeetomatic has stopped working on this issue."
			: "Yeetomatic has stopped working on this review.";
	}

	private async postComment(target: ExecutionCommentTarget, owner: string, repo: string, body: string): Promise<void> {
		if (target.kind === "issue") {
			await this.deps.github.postComment(owner, repo, target.number, body);
			return;
		}
		await this.deps.github.postPRComment(owner, repo, target.number, body);
	}
}
