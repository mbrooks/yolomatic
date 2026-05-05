import { Octokit } from "@octokit/rest";

import type { ExecutionResult, PiAgentExecutor } from "../executor/index.js";
import { FatalSystemError, SelfMonitor } from "../self-monitor/index.js";
import { PRReviewHandler } from "../pr-review/handler.js";
import type { SessionManager } from "../session/manager.js";
import type { SessionState } from "../session/store.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { generateCommitMessage } from "../workspace/manager.js";

interface IssueLabel {
	name?: string;
}

interface IssuePayload {
	action: string;
	issue: {
		number: number;
		title: string;
		body: string | null;
		labels?: IssueLabel[];
		assignee?: {
			login: string;
		} | null;
		assignees?: {
			login: string;
		}[];
	};
	repository: {
		name: string;
		owner: {
			login: string;
		};
	};
	sender: {
		login: string;
	};
}

interface CommentPayload {
	action: string;
	issue: {
		number: number;
		title?: string;
		body?: string | null;
		labels?: IssueLabel[];
		assignee?: {
			login: string;
		} | null;
		assignees?: {
			login: string;
		}[];
		user?: {
			login: string;
		};
	};
	comment: {
		body: string;
		user: {
			login: string;
			type?: string;
		};
	};
	repository: {
		name: string;
		owner: {
			login: string;
		};
	};
	sender: {
		login: string;
	};
}

function hasLabel(labels: IssueLabel[] | undefined, label: string): boolean {
	return (labels ?? []).some((item) => item.name === label);
}

function hasAnyLabel(labels: IssueLabel[] | undefined, searchLabels: string[]): boolean {
	return (labels ?? []).some((item) => item.name && searchLabels.includes(item.name));
}

const TARS_WORKFLOW_LABELS = ["tars-working", "tars-feedback-required", "tars-pr-created", "tars-complete"];

export interface WebhookHandlers {
	handleIssueEvent(payload: unknown): Promise<void>;
	handleCommentEvent(payload: unknown): Promise<void>;
	handlePullRequestReviewCommentEvent(payload: unknown): Promise<void>;
	handlePullRequestReviewEvent(payload: unknown): Promise<void>;
	isInFlight(owner: string, repo: string, issueNumber: number): boolean;
}

export class GitHubIssueHandlers implements WebhookHandlers {
	private readonly octokit: Octokit;
	private readonly inFlight = new Set<string>();
	private readonly prReviewHandler: PRReviewHandler;

	public constructor(
		private readonly deps: {
			sessionManager: SessionManager;
			workspaceManager: WorkspaceManager;
			executor: PiAgentExecutor;
			githubToken: string;
			githubUsername: string;
			autoStart: boolean;
			defaultBranch: string;
			selfReportEnabled: boolean;
			maxIterations?: number;
			octokit?: Octokit;
		},
	) {
		this.octokit = deps.octokit ?? new Octokit({ auth: deps.githubToken });
		this.prReviewHandler = new PRReviewHandler({
			sessionManager: deps.sessionManager,
			workspaceManager: deps.workspaceManager,
			executor: deps.executor,
			githubToken: deps.githubToken,
			githubUsername: deps.githubUsername,
			maxIterations: deps.maxIterations ?? 3,
			octokit: this.octokit,
		});
	}

	private isAssignedToTars(issue: { assignee?: { login: string } | null; assignees?: { login: string }[] }): boolean {
		if (issue.assignees && issue.assignees.some((a) => a.login === this.deps.githubUsername)) return true;
		if (issue.assignee?.login === this.deps.githubUsername) return true;
		return false;
	}

	async handleIssueEvent(rawPayload: unknown): Promise<void> {
		const payload = rawPayload as IssuePayload;
		const owner = payload.repository.owner.login;
		const repo = payload.repository.name;
		const issue = payload.issue;

		if (payload.sender.login === this.deps.githubUsername) {
			process.stdout.write(`[webhook] issues action ignored: event from ${this.deps.githubUsername}\n`);
			return;
		}

		if (payload.action === "opened") {
			if (!this.isAssignedToTars(issue)) {
				process.stdout.write(`[webhook] issues.opened ignored: not assigned to ${this.deps.githubUsername}\n`);
				return;
			}
			process.stdout.write(`[webhook] issues.opened repo=${owner}/${repo} issue=#${issue.number} (assigned)\n`);
		} else if (payload.action === "assigned") {
			if (!this.isAssignedToTars(issue)) {
				process.stdout.write(`[webhook] issues.assigned ignored: not assigned to ${this.deps.githubUsername}\n`);
				return;
			}
			process.stdout.write(`[webhook] issues.assigned repo=${owner}/${repo} issue=#${issue.number} to=${this.deps.githubUsername}\n`);
		} else if (payload.action === "unassigned") {
			if (this.isAssignedToTars(issue)) {
				process.stdout.write(`[webhook] issues.unassigned ignored: TARS still assigned to ${owner}/${repo}#${issue.number}\n`);
				return;
			}
			process.stdout.write(`[webhook] issues.unassigned repo=${owner}/${repo} issue=#${issue.number} (TARS unassigned)\n`);
			const state = await this.deps.sessionManager.getSession(owner, repo, issue.number);
			if (state && (state.status === "working" || state.status === "waiting-feedback")) {
				await this.deps.sessionManager.updateStatus(owner, repo, issue.number, "pending");
				await this.safeRemoveLabel(owner, repo, issue.number, "tars-working");
				await this.safeRemoveLabel(owner, repo, issue.number, "tars-feedback-required");
				await this.safeRemoveLabel(owner, repo, issue.number, "tars-pr-created");
				await this.safeRemoveLabel(owner, repo, issue.number, "tars-complete");
				await this.postComment(owner, repo, issue.number, "TARS unassigned. Pausing work.");
			}
			return;
		} else {
			process.stdout.write(`[webhook] issues action ignored: ${payload.action}\n`);
			return;
		}

		const inFlightKey = `${owner}/${repo}#${issue.number}`;
		if (this.inFlight.has(inFlightKey)) {
			process.stdout.write(`[webhook] ${payload.action} ignored: ${inFlightKey} is already being processed\n`);
			return;
		}

		const worktree = await this.deps.workspaceManager.createOrGetWorktree(owner, repo, issue.number);

		const session = await this.deps.sessionManager.createSession(
			owner,
			repo,
			issue.number,
			issue.title,
			issue.body ?? "",
			worktree.path,
			issue.labels?.map((l) => l.name).filter((n): n is string => !!n),
		);

		if (session.status !== "pending") {
			process.stdout.write(`[webhook] ${payload.action} ignored: ${inFlightKey} session status is ${session.status}\n`);
			return;
		}

		if (!this.deps.autoStart) {
			process.stdout.write(`[webhook] auto-start disabled for ${repo}#${issue.number}\n`);
			return;
		}

		process.stdout.write(`[webhook] auto-starting ${repo}#${issue.number}\n`);
		this.inFlight.add(inFlightKey);
		try {
			await this.addLabels(owner, repo, issue.number, ["tars-working"]);
			await this.postComment(owner, repo, issue.number, "Picked up by TARS. Working on it...");
			await this.runExecution(owner, repo, issue.number);
		} finally {
			this.inFlight.delete(inFlightKey);
		}
	}

	async handleCommentEvent(rawPayload: unknown): Promise<void> {
		const payload = rawPayload as CommentPayload;
		if (payload.action !== "created") {
			process.stdout.write(`[webhook] issue_comment action ignored: ${payload.action}\n`);
			return;
		}

		if (payload.comment.user.login === this.deps.githubUsername) {
			process.stdout.write(
				`[webhook] issue_comment ignored for ${payload.repository.name}#${payload.issue.number}: comment from ${this.deps.githubUsername}\n`,
			);
			return;
		}

		// Ignore bot comments (including our own)
		if (payload.comment.user.type === "Bot") {
			process.stdout.write(
				`[webhook] issue_comment ignored for ${payload.repository.name}#${payload.issue.number}: bot comment\n`,
			);
			return;
		}

		const isAssigned = this.isAssignedToTars(payload.issue);
		const isCreatedByTars = payload.issue.user?.login === this.deps.githubUsername;
		const isMentioned =
			payload.comment.body.includes(`@${this.deps.githubUsername}`) ||
			payload.comment.body.toLowerCase().includes("@tars");
		const hasTarsLabel = hasAnyLabel(payload.issue.labels, TARS_WORKFLOW_LABELS) || hasLabel(payload.issue.labels, "tars");

		if (!isAssigned && !isCreatedByTars && !isMentioned) {
			process.stdout.write(
				`[webhook] issue_comment ignored for ${payload.repository.name}#${payload.issue.number}: not assigned to ${this.deps.githubUsername}, not created by ${this.deps.githubUsername}, and no TARS mention\n`,
			);
			return;
		}

		if (isAssigned && !hasTarsLabel && !isMentioned) {
			process.stdout.write(
				`[webhook] issue_comment ignored for ${payload.repository.name}#${payload.issue.number}: no tars label or mention\n`,
			);
			return;
		}

		const owner = payload.repository.owner.login;
		const repo = payload.repository.name;
		const issueNumber = payload.issue.number;

		if (isMentioned) {
			process.stdout.write(`[webhook] issue_comment accepted for ${repo}#${issueNumber}: mentioned\n`);
		} else if (isCreatedByTars) {
			process.stdout.write(`[webhook] issue_comment accepted for ${repo}#${issueNumber}: created by ${this.deps.githubUsername}\n`);
		} else {
			process.stdout.write(`[webhook] issue_comment accepted for ${repo}#${issueNumber}: has tars label\n`);
		}

		// Auto-label on mention so future comments pass via label gate
		if (isMentioned && !hasTarsLabel) {
			await this.octokit.issues.addLabels({
				owner,
				repo,
				issue_number: issueNumber,
				labels: ["tars"],
			});
			process.stdout.write(`[webhook] added tars label to ${owner}/${repo}#${issueNumber}\n`);
		}

		process.stdout.write(`[webhook] resuming ${owner}/${repo}#${issueNumber} from comment\n`);

		// Fallback: auto-create session if it doesn't exist (e.g., assignment event was missed)
		let session = await this.deps.sessionManager.getSession(owner, repo, issueNumber);
		if (!session) {
			const worktree = await this.deps.workspaceManager.createOrGetWorktree(owner, repo, issueNumber);
			session = await this.deps.sessionManager.createSession(
				owner,
				repo,
				issueNumber,
				payload.issue.title ?? "",
				payload.issue.body ?? "",
				worktree.path,
				payload.issue.labels?.map((l) => l.name).filter((n): n is string => !!n),
			);
		}

		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-feedback-required");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-pr-created");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-complete");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-working");
		await this.addLabels(owner, repo, issueNumber, ["tars-working"]);
		await this.postComment(owner, repo, issueNumber, "Feedback received. Resuming work.");
		await this.runExecution(owner, repo, issueNumber, payload.comment.body);
	}

	private async runExecution(owner: string, repo: string, issueNumber: number, comment?: string): Promise<void> {
		await this.deps.workspaceManager.createOrGetWorktree(owner, repo, issueNumber);

		let state = await this.deps.sessionManager.getSession(owner, repo, issueNumber);
		if (!state) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}
		process.stdout.write(
			`[webhook] execute repo=${owner}/${repo} issue=#${issueNumber} session=${state.sessionPath}\n`,
		);

		state = await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "working");

		let result: ExecutionResult;
		try {
			result = await this.deps.executor.execute(state, comment);
		} catch (error) {
			if (error instanceof FatalSystemError && this.deps.selfReportEnabled) {
				const issueUrl = await this.fileSelfReport(error);
				await this.postComment(
					owner,
					repo,
					issueNumber,
					`⛔ TARS stopped due to a fatal system error. A bug report has been filed in \`mbrooks/tars\`: ${issueUrl}`,
				);
				await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "failed");
				await this.safeRemoveLabel(owner, repo, issueNumber, "tars-working");
				await this.addLabels(owner, repo, issueNumber, ["tars-failed"]);
				process.stdout.write(`[webhook] fatal system error self-reported for ${repo}#${issueNumber}: ${issueUrl}\n`);
				return;
			}

			const context = comment ? "Resuming from comment" : "Processing issue";
			await this.postFailureComment(owner, repo, issueNumber, error, context);
			await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "failed");
			await this.safeRemoveLabel(owner, repo, issueNumber, "tars-working");
			await this.addLabels(owner, repo, issueNumber, ["tars-failed"]);
			throw error;
		}
		process.stdout.write(
			`[webhook] execution result repo=${repo} issue=#${issueNumber} status=${result.status}\n`,
		);
		let updatedState: SessionState;

		if (!state.seeded && !comment) {
			await this.deps.sessionManager.markSeeded(owner, repo, issueNumber);
		}

		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-working");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-feedback-required");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-complete");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-pr-created");

		if (result.status === "waiting-feedback") {
			updatedState = await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "waiting-feedback");
			process.stdout.write(`[webhook] waiting for feedback on ${repo}#${issueNumber}\n`);
			await this.addLabels(owner, repo, issueNumber, ["tars-feedback-required"]);
			await this.postComment(
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
			let prUrl: string;
			try {
				// Push branch so code is actually delivered
				await this.deps.workspaceManager.commitAndPush(
					owner,
					repo,
					issueNumber,
					generateCommitMessage(state.labels, issueNumber, result.summary),
				);

				// Create PR via GitHub API
				prUrl = await this.createPR(owner, repo, issueNumber, state.title, result.summary);
			} catch (error) {
				await this.handleDeliveryFailure(owner, repo, issueNumber, state, error);
				return;
			}

			updatedState = await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "complete");
			process.stdout.write(`[webhook] marked complete ${repo}#${issueNumber}\n`);

			await this.addLabels(owner, repo, issueNumber, ["tars-pr-created"]);
			await this.postComment(
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

		updatedState = await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "working");
		process.stdout.write(`[webhook] left in working state ${repo}#${issueNumber}\n`);
		await this.addLabels(owner, repo, issueNumber, ["tars-working"]);
		await this.postComment(
			owner,
			repo,
			issueNumber,
			[
				"TARS is still working on this issue.",
				"",
				result.summary || "Execution is in progress.",
			].join("\n"),
		);

		void updatedState;
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
			const pr = await this.octokit.pulls.create({
				owner,
				repo,
				title: `TARS: ${title}`,
				body: `Fixes #${issueNumber}\n\n${summary}`,
				head,
				base,
			});

			await this.deps.sessionManager.associatePR(owner, repo, issueNumber, pr.data.number, pr.data.html_url);

			return pr.data.html_url;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("A pull request already exists")) {
				const existing = await this.octokit.pulls.list({
					owner,
					repo,
					head: `${owner}:${head}`,
					base,
					state: "open",
				});
				if (existing.data.length > 0) {
					const pr = existing.data[0];
					await this.deps.sessionManager.associatePR(owner, repo, issueNumber, pr.number, pr.html_url);
					return pr.html_url;
				}
			}
			throw error;
		}
	}

	private async addLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
		await this.octokit.issues.addLabels({
			owner,
			repo,
			issue_number: issueNumber,
			labels,
		});
	}

	private async safeRemoveLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<void> {
		try {
			await this.octokit.issues.removeLabel({
				owner,
				repo,
				issue_number: issueNumber,
				name: label,
			});
		} catch (error) {
			const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
			if (status !== 404) {
				throw error;
			}
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

		await this.postComment(owner, repo, issueNumber, body);
	}

	private async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
		await this.octokit.issues.createComment({
			owner,
			repo,
			issue_number: issueNumber,
			body,
		});
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
			await this.postComment(
				owner,
				repo,
				issueNumber,
				`TARS could not deliver the completed work. A bug report has been filed in \`mbrooks/tars\`: ${issueUrl}`,
			);
			process.stdout.write(`[webhook] delivery failure self-reported for ${repo}#${issueNumber}: ${issueUrl}\n`);
		} else {
			await this.postFailureComment(owner, repo, issueNumber, error, "Delivering completed work");
		}

		await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "failed");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-working");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-pr-created");
		await this.addLabels(owner, repo, issueNumber, ["tars-failed"]);
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

		const response = await this.octokit.issues.create({
			owner,
			repo,
			title,
			body,
			labels: ["tars-self-report", "bug"],
		});

		return response.data.html_url;
	}

	async handlePullRequestReviewCommentEvent(payload: unknown): Promise<void> {
		return this.prReviewHandler.handlePullRequestReviewCommentEvent(payload);
	}

	async handlePullRequestReviewEvent(payload: unknown): Promise<void> {
		return this.prReviewHandler.handlePullRequestReviewEvent(payload);
	}

	isInFlight(owner: string, repo: string, issueNumber: number): boolean {
		return this.inFlight.has(`${owner}/${repo}#${issueNumber}`);
	}
}
