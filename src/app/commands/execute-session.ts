import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { ExecutionService } from "../../ports/execution-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { Clock } from "../../ports/clock.js";
import type { ExecutionResult } from "../../executor/index.js";
import type { SessionState } from "../../session/store.js";
import type { FatalErrorCategory } from "../../self-monitor/types.js";
import { FatalSystemError, SelfMonitor } from "../../self-monitor/index.js";
import { generateCommitMessage } from "../../workspace/manager.js";
import { validatePRSessionMapping } from "../../pr-review/session-invariant.js";
import { issueSessionKey, removeWorkflowLabels } from "./workflow-helpers.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecuteSessionDeps {
	sessions: SessionRepository;
	workspaces: WorkspaceService;
	executor: ExecutionService;
	github: GitHubService;
	tasks: TaskControlService;
	clock: Clock;
	defaultBranch: string;
	githubUsername: string;
	selfReportEnabled: boolean;
}

export class ExecuteSession {
	constructor(private readonly deps: ExecuteSessionDeps) {}

	async run(state: SessionState, comment?: string): Promise<void> {
		const { owner, repo, issueNumber } = state;
		const key = issueSessionKey(owner, repo, issueNumber);

		await this.deps.workspaces.createOrGetWorktree(owner, repo, issueNumber);

		let current = await this.deps.sessions.get(owner, repo, issueNumber);
		if (!current) {
			throw new Error(`No session for ${key}`);
		}

		const preflightError = await this.validateSessionBeforeExecution(current);
		if (preflightError) {
			process.stdout.write(`[execute] execution blocked for ${key}: ${preflightError}\n`);
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed", { summary: preflightError });
			await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-failed"]);
			await this.deps.github.postComment(
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

		current = await this.deps.sessions.updateStatus(owner, repo, issueNumber, "working");

		const abortController = new AbortController();
		let resolveSession: ((session: AgentSession) => void) | undefined;
		const sessionPromise = new Promise<AgentSession>((resolve) => {
			resolveSession = resolve;
		});

		this.deps.tasks.register(
			key,
			() => abortController.abort(),
			async (msg) => {
				const session = await Promise.race([
					sessionPromise,
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error("steer timeout")), 5000)),
				]);
				await session.steer(msg);
			},
		);

		let result: ExecutionResult;
		try {
			result = await this.deps.executor.execute(
				current,
				comment,
				abortController.signal,
				(session) => {
					resolveSession?.(session);
				},
			);
		} catch (error) {
			if (abortController.signal.aborted) {
				process.stdout.write(`[execute] execution aborted for ${key}\n`);
				await this.deps.sessions.cancelSession(owner, repo, issueNumber);
				await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);
				await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-cancelled"]);
				await this.deps.github.postComment(owner, repo, issueNumber, "Task cancelled by admin. TARS is idle.");
				return;
			}

			if (error instanceof FatalSystemError && this.deps.selfReportEnabled) {
				const issueUrl = await this.fileSelfReport(error);
				await this.deps.github.postComment(
					owner,
					repo,
					issueNumber,
					`⛔ TARS stopped due to a fatal system error. A bug report has been filed in \`mbrooks/tars\`: ${issueUrl}`,
				);
				await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed");
				await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);
				await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-failed"]);
				process.stdout.write(`[execute] fatal system error self-reported for ${repo}#${issueNumber}: ${issueUrl}\n`);
				return;
			}

			const context = comment ? "Resuming from comment" : "Processing issue";
			await this.postFailureComment(owner, repo, issueNumber, error, context);
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed");
			await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-failed"]);
			throw error;
		} finally {
			this.deps.tasks.unregister(key);
		}

		const postExecState = await this.deps.sessions.get(owner, repo, issueNumber);
		if (postExecState?.status === "paused") {
			process.stdout.write(`[execute] ${key} paused during execution; suppressing result transitions\n`);
			return;
		}

		process.stdout.write(`[execute] result repo=${repo} issue=#${issueNumber} status=${result.status}\n`);

		if (!current.seeded && !comment) {
			await this.deps.sessions.markSeeded(owner, repo, issueNumber);
		}

		await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);

		if (result.status === "waiting-feedback") {
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "waiting-feedback");
			process.stdout.write(`[execute] waiting for feedback on ${repo}#${issueNumber}\n`);
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-feedback-required"]);
			await this.deps.github.postComment(
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
			let prUrl: string | undefined;
			let deliveryOutcome: "pr-created" | "pr-existed" | "no-changes" = "no-changes";

			try {
				const worktreePath = current.workspacePath;
				const preStatus = await this.deps.workspaces.getGitStatus(owner, repo, issueNumber).catch(() => "(unknown)");
				process.stdout.write(`[execute] pre-commit status for ${repo}#${issueNumber} at ${worktreePath}:\n${preStatus}\n`);

				const pushed = await this.deps.workspaces.commitAndPush(
					owner,
					repo,
					issueNumber,
					generateCommitMessage(current.labels, issueNumber, result.summary),
				);

				if (!pushed) {
					const postStatus = await this.deps.workspaces.getGitStatus(owner, repo, issueNumber).catch(() => "(unknown)");
					process.stdout.write(`[execute] commitAndPush returned false for ${repo}#${issueNumber}. worktree=${worktreePath}\nstatus=${postStatus}\n`);

					await this.deps.github.postComment(
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
							"",
							"<details>",
							"<summary>Delivery diagnostics</summary>",
							"",
							`Worktree: \`${worktreePath}\``,
							"",
							"Git status:",
							"```",
							postStatus || "(clean)",
							"```",
							"</details>",
						].join("\n"),
					);

					await this.deps.sessions.updateStatus(owner, repo, issueNumber, "complete");
					return;
				}

				const postStatus = await this.deps.workspaces.getGitStatus(owner, repo, issueNumber).catch(() => "(unknown)");
				process.stdout.write(`[execute] post-commit status for ${repo}#${issueNumber}: ${postStatus}\n`);

				const prResult = await this.createPR(owner, repo, issueNumber, current.title, result.summary);
				prUrl = prResult.url;
				deliveryOutcome = prResult.outcome;
			} catch (error) {
				await this.handleDeliveryFailure(owner, repo, issueNumber, current, error);
				return;
			}

			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "complete");
			process.stdout.write(`[execute] marked complete ${repo}#${issueNumber}\n`);

			if (deliveryOutcome === "pr-created" && prUrl) {
				await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-pr-created"]);
				await this.deps.github.postComment(
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
			} else if (deliveryOutcome === "pr-existed" && prUrl) {
				await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-pr-created"]);
				await this.deps.github.postComment(
					owner,
					repo,
					issueNumber,
					[
						"**TARS Complete**",
						"",
						`PR already exists: ${prUrl}`,
						"",
						"Summary:",
						result.summary || "No summary provided.",
						"",
						"Ready for review.",
					].join("\n"),
				);
			} else {
				await this.deps.github.postComment(
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
			return;
		}

		if (result.status === "cancelled") {
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "cancelled");
			process.stdout.write(`[execute] marked cancelled ${repo}#${issueNumber}\n`);
			await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-cancelled"]);
			await this.deps.github.postComment(
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

		await this.deps.sessions.updateStatus(owner, repo, issueNumber, "working");
		process.stdout.write(`[execute] left in working state ${repo}#${issueNumber}\n`);
		await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-working"]);
		await this.deps.github.postComment(
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
		const pr = await this.deps.github.getPullRequest(state.owner, state.repo, state.prNumber);
		if (!pr) {
			return null;
		}
		return validatePRSessionMapping(state, state.prNumber, pr.head.ref);
	}

	private async createPR(
		owner: string,
		repo: string,
		issueNumber: number,
		title: string,
		summary: string,
	): Promise<{ url?: string; outcome: "pr-created" | "pr-existed" | "no-changes" }> {
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
			if (pr) {
				await this.deps.sessions.associatePR(owner, repo, issueNumber, pr.number, pr.html_url);
				return { url: pr.html_url, outcome: "pr-created" };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("A pull request already exists")) {
				const existing = await this.deps.github.listPullRequests(owner, repo, {
					head: `${owner}:${head}`,
					base,
					state: "open",
				});
				if (existing.length > 0) {
					const pr = existing[0];
					await this.deps.sessions.associatePR(owner, repo, issueNumber, pr.number, pr.html_url);
					return { url: pr.html_url, outcome: "pr-existed" };
				}
			}
			if (message.includes("No commits between")) {
				return { outcome: "no-changes" };
			}
			throw error;
		}
		return { outcome: "no-changes" };
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
		const body = [
			"**TARS failed.**",
			"",
			`Context: ${context}`,
			`Error: ${message}`,
			"",
			"<details>",
			"<summary>Full trace</summary>",
			`<pre>${truncatedStack}</pre>`,
			"</details>",
		].join("\n");
		await this.deps.github.postComment(owner, repo, issueNumber, body);
	}

	private async handleDeliveryFailure(
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
				"**TARS delivery failed.**",
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
				"**TARS delivery failed.**",
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
		// Restore tars-working to show stalled state; remove others
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-feedback-required");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-pr-created");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-complete");
		await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-working", "tars-delivery-failed"]);
	}

	private classifyDeliveryError(message: string): FatalErrorCategory {
		const lower = message.toLowerCase();
		if (
			lower.includes("refusing to allow a personal access token") &&
			lower.includes("scope")
		) {
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
				gitBranch: `tars/issue-${state.issueNumber}`,
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
			return "The GitHub PAT is missing the `workflow` scope. Update the token in GitHub settings and restart TARS.";
		}
		return "";
	}

	private async fileSelfReport(error: FatalSystemError): Promise<string> {
		const { SelfMonitor } = await import("../../self-monitor/index.js");
		const body = SelfMonitor.formatBugReportBody(error.evidence);
		const title = SelfMonitor.getIssueTitle(error.evidence);
		return this.deps.github.fileSelfReport(title, body, ["tars-self-report", "bug"]);
	}
}
