import type { PiAgentExecutor, ExecutionResult } from "../executor/index.js";
import { GitHubClient } from "../github/client.js";
import { FatalSystemError, SelfMonitor } from "../self-monitor/index.js";
import type { SessionState } from "../session/store.js";
import { SessionWorkflow } from "../session/workflow.js";
import type { TaskController } from "../task-controller.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { generateCommitMessage } from "../workspace/manager.js";
import { validatePRSessionMapping } from "../pr-review/session-invariant.js";

export class IssueExecutionService {
	public constructor(
		private readonly deps: {
			workflow: SessionWorkflow;
			workspaceManager: WorkspaceManager;
			executor: PiAgentExecutor;
			github: GitHubClient;
			taskController?: TaskController;
			selfReportEnabled: boolean;
			defaultBranch: string;
		},
	) {}

	async executeIssue(owner: string, repo: string, issueNumber: number, comment?: string): Promise<void> {
		await this.deps.workspaceManager.createOrGetWorktree(owner, repo, issueNumber);

		let state = await this.deps.workflow.getSession(owner, repo, issueNumber);
		if (!state) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}
		process.stdout.write(`[webhook] execute repo=${owner}/${repo} issue=#${issueNumber} session=${state.sessionPath}\n`);

		const preflightError = await this.validateSessionBeforeExecution(state);
		if (preflightError) {
			process.stdout.write(`[webhook] execution blocked for ${owner}/${repo}#${issueNumber}: ${preflightError}\n`);
			await this.deps.workflow.markFailed(owner, repo, issueNumber, { summary: preflightError });
			await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-working");
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-failed"]);
			await this.deps.github.createComment(
				owner,
				repo,
				issueNumber,
				[
					"**TARS stopped before execution.**",
					"",
					preflightError,
					"",
					"This protects the task from being handled by the wrong issue worktree.",
				].join("\n"),
			);
			return;
		}

		state = await this.deps.workflow.markWorking(owner, repo, issueNumber);

		const inFlightKey = `${owner}/${repo}#${issueNumber}`;
		const abortController = new AbortController();
		this.deps.taskController?.register(inFlightKey, () => abortController.abort());

		let result: ExecutionResult;
		try {
			result = await this.deps.executor.execute(state, comment, undefined, abortController.signal);
		} catch (error) {
			if (abortController.signal.aborted) {
				process.stdout.write(`[webhook] execution aborted for ${inFlightKey}\n`);
				await this.handleCancelledExecution(owner, repo, issueNumber, "Task cancelled by admin. TARS is idle.");
				return;
			}

			if (error instanceof FatalSystemError && this.deps.selfReportEnabled) {
				const issueUrl = await this.fileSelfReport(error);
				await this.deps.github.createComment(
					owner,
					repo,
					issueNumber,
					`⛔ TARS stopped due to a fatal system error. A bug report has been filed in \`mbrooks/tars\`: ${issueUrl}`,
				);
				await this.deps.workflow.markFailed(owner, repo, issueNumber);
				await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-working");
				await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-failed"]);
				process.stdout.write(`[webhook] fatal system error self-reported for ${repo}#${issueNumber}: ${issueUrl}\n`);
				return;
			}

			const context = comment ? "Resuming from comment" : "Processing issue";
			await this.postFailureComment(owner, repo, issueNumber, error, context);
			await this.deps.workflow.markFailed(owner, repo, issueNumber);
			await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-working");
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-failed"]);
			throw error;
		} finally {
			this.deps.taskController?.unregister(inFlightKey);
		}

		process.stdout.write(`[webhook] execution result repo=${repo} issue=#${issueNumber} status=${result.status}\n`);

		if (!state.seeded && !comment) {
			await this.deps.workflow.markSeeded(owner, repo, issueNumber);
		}

		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-working");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-feedback-required");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-complete");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-pr-created");

		if (result.status === "waiting-feedback") {
			await this.deps.workflow.markWaitingFeedback(owner, repo, issueNumber);
			process.stdout.write(`[webhook] waiting for feedback on ${repo}#${issueNumber}\n`);
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-feedback-required"]);
			await this.deps.github.createComment(
				owner,
				repo,
				issueNumber,
				[
					"Need clarification:",
					result.summary || "TARS needs more information before continuing.",
				].join("\n\n"),
			);
			return;
		}

		if (result.status === "complete") {
			await this.handleCompletedExecution(owner, repo, issueNumber, state, result);
			return;
		}

		if (result.status === "cancelled") {
			await this.deps.workflow.markCancelled(owner, repo, issueNumber);
			process.stdout.write(`[webhook] marked cancelled ${repo}#${issueNumber}\n`);
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-cancelled"]);
			await this.deps.github.createComment(
				owner,
				repo,
				issueNumber,
				[
					"Task cancelled by admin.",
					"",
					result.summary || "TARS has stopped working on this issue.",
					"",
					"TARS is idle and ready for the next task.",
				].join("\n"),
			);
			return;
		}

		await this.deps.workflow.markWorking(owner, repo, issueNumber);
		process.stdout.write(`[webhook] left in working state ${repo}#${issueNumber}\n`);
		await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-working"]);
		await this.deps.github.createComment(
			owner,
			repo,
			issueNumber,
			[
				"TARS is still working on this issue.",
				"",
				result.summary || "Execution is in progress.",
			].join("\n"),
		);
	}

	private async handleCompletedExecution(
		owner: string,
		repo: string,
		issueNumber: number,
		state: SessionState,
		result: ExecutionResult,
	): Promise<void> {
		let prUrl: string | undefined;
		try {
			const pushed = await this.deps.workspaceManager.commitAndPush(
				owner,
				repo,
				issueNumber,
				generateCommitMessage(state.labels, issueNumber, result.summary),
			);

			if (pushed) {
				prUrl = await this.createPR(owner, repo, issueNumber, state.title, result.summary);
			}
		} catch (error) {
			await this.handleDeliveryFailure(owner, repo, issueNumber, state, error);
			return;
		}

		await this.deps.workflow.markComplete(owner, repo, issueNumber);
		process.stdout.write(`[webhook] marked complete ${repo}#${issueNumber}\n`);

		if (prUrl) {
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-pr-created"]);
			await this.deps.github.createComment(
				owner,
				repo,
				issueNumber,
				[
					"**TARS Complete**",
					"",
					`PR created: ${prUrl}`,
					"",
					"Summary:",
					result.summary || "No summary provided.",
					"",
					"Ready for review.",
				].join("\n"),
			);
			return;
		}

		await this.deps.github.createComment(
			owner,
			repo,
			issueNumber,
			[
				"**TARS Complete**",
				"",
				"Summary:",
				result.summary || "No summary provided.",
				"",
				"No code changes were necessary.",
			].join("\n"),
		);
	}

	private async handleCancelledExecution(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
		await this.deps.workflow.markCancelled(owner, repo, issueNumber);
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-working");
		await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-cancelled"]);
		await this.deps.github.createComment(owner, repo, issueNumber, body);
	}

	private async validateSessionBeforeExecution(state: SessionState): Promise<string | null> {
		if (!state.workspacePath.endsWith(`issue-${state.issueNumber}`)) {
			return [
				`Session ${state.owner}/${state.repo}#${state.issueNumber} points to unexpected workspace '${state.workspacePath}'.`,
				`Expected a path ending in 'issue-${state.issueNumber}'.`,
			].join(" ");
		}

		if (state.prNumber === undefined) {
			return null;
		}

		const pullRequest = await this.deps.github.getPullRequest(state.owner, state.repo, state.prNumber);
		return validatePRSessionMapping(state, state.prNumber, pullRequest.head.ref);
	}

	private async createPR(
		owner: string,
		repo: string,
		issueNumber: number,
		title: string,
		summary: string,
	): Promise<string> {
		const base = this.deps.defaultBranch;
		const head = `tars/issue-${issueNumber}`;

		try {
			const pr = await this.deps.github.createPullRequest(
				owner,
				repo,
				`TARS: ${title}`,
				`Fixes #${issueNumber}\n\n${summary}`,
				head,
				base,
			);
			await this.deps.workflow.associatePR(owner, repo, issueNumber, pr.number, pr.url);
			return pr.url;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("A pull request already exists")) {
				const existing = await this.deps.github.listOpenPullRequests(owner, repo, `${owner}:${head}`, base);
				if (existing.length > 0) {
					const pr = existing[0];
					await this.deps.workflow.associatePR(owner, repo, issueNumber, pr.number, pr.url);
					return pr.url;
				}
			}
			throw error;
		}
	}

	private async postFailureComment(
		owner: string,
		repo: string,
		issueNumber: number,
		error: unknown,
		context: string,
	): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		const stack = error instanceof Error ? error.stack ?? "" : "";
		const truncatedStack = stack.length > 3000 ? stack.slice(0, 3000) + "\n... (truncated)" : stack;

		await this.deps.github.createComment(
			owner,
			repo,
			issueNumber,
			[
				"**TARS failed.**",
				"",
				`Context: ${context}`,
				`Error: ${message}`,
				"",
				"<details>",
				"<summary>Full trace</summary>",
				`<pre>${truncatedStack}</pre>`,
				"</details>",
			].join("\n"),
		);
	}

	private async handleDeliveryFailure(
		owner: string,
		repo: string,
		issueNumber: number,
		state: SessionState,
		error: unknown,
	): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);

		if (this.deps.selfReportEnabled) {
			const issueUrl = await this.fileSelfReport(this.createDeliveryFatalError(state, message));
			await this.deps.github.createComment(
				owner,
				repo,
				issueNumber,
				`TARS could not deliver the completed work. A bug report has been filed in \`mbrooks/tars\`: ${issueUrl}`,
			);
			process.stdout.write(`[webhook] delivery failure self-reported for ${repo}#${issueNumber}: ${issueUrl}\n`);
		} else {
			await this.postFailureComment(owner, repo, issueNumber, error, "Delivering completed work");
		}

		await this.deps.workflow.markFailed(owner, repo, issueNumber);
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-working");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-pr-created");
		await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-failed"]);
	}

	private createDeliveryFatalError(state: SessionState, message: string): FatalSystemError {
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
				category: "git_worktree_failure",
				message,
				toolName: "workspace.commitAndPush/createPR",
			},
			systemEvidence: {
				whoami: process.env.USER ?? process.env.LOGNAME ?? "unknown",
				pwd: process.cwd(),
				workspacePath: state.workspacePath,
				lsWorkspace: "(not collected for delivery failure)",
				gitStatus: "(not collected for delivery failure)",
				gitBranch: `tars/issue-${state.issueNumber}`,
				nodeVersion: process.version,
				timestamp: new Date().toISOString(),
			},
		});
	}

	private async fileSelfReport(error: FatalSystemError): Promise<string> {
		const { owner, repo } = SelfMonitor.getTargetRepo();
		const body = SelfMonitor.formatBugReportBody(error.evidence);
		const title = SelfMonitor.getIssueTitle(error.evidence);
		const response = await this.deps.github.createIssue(owner, repo, title, body, ["tars-self-report", "bug"]);
		const data = response as { data: { html_url: string } };
		return data.data.html_url;
	}
}
