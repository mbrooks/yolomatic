import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { Octokit } from "@octokit/rest";

import type { ExecutionResult, PiAgentExecutor } from "../executor/index.js";
import { FatalSystemError, SelfMonitor } from "../self-monitor/index.js";
import { PRReviewHandler } from "../pr-review/handler.js";
import type { SessionManager } from "../session/manager.js";
import type { SessionState } from "../session/store.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { generateCommitMessage } from "../workspace/manager.js";
import type { TaskController } from "../task-controller.js";
import {
	extractIssueNumberFromBranch,
	validatePRSessionMapping,
} from "../pr-review/session-invariant.js";

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
		user?: {
			login: string;
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
	changes?: {
		body?: { from: string };
		title?: { from: string };
	};
}

interface CommentPayload {
	action: string;
	issue: {
		number: number;
		title?: string;
		body?: string | null;
		pull_request?: {
			url: string;
		};
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
		id?: number;
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
			taskController?: TaskController;
			adminGithubUsername?: string;
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
			taskController: deps.taskController,
		});
	}

	private isAssignedToTars(issue: { assignee?: { login: string } | null; assignees?: { login: string }[] }): boolean {
		if (issue.assignees && issue.assignees.some((a) => a.login === this.deps.githubUsername)) return true;
		if (issue.assignee?.login === this.deps.githubUsername) return true;
		return false;
	}

	private isAdmin(login: string): boolean {
		return !!this.deps.adminGithubUsername && login === this.deps.adminGithubUsername;
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
		} else if (payload.action === "edited") {
			const hasTarsLabel = hasAnyLabel(issue.labels, TARS_WORKFLOW_LABELS) || hasLabel(issue.labels, "tars");
			if (!this.isAssignedToTars(issue) && !hasTarsLabel && issue.user?.login !== this.deps.githubUsername) {
				process.stdout.write(`[webhook] issues.edited ignored: not a TARS issue\n`);
				return;
			}
			const inFlightKey = `${owner}/${repo}#${issue.number}`;
			const state = await this.deps.sessionManager.getSession(owner, repo, issue.number);
			if (!state) {
				process.stdout.write(`[webhook] issues.edited ignored: no session for ${inFlightKey}\n`);
				return;
			}
			if (this.deps.taskController?.isActive(inFlightKey)) {
				const steered = await this.deps.taskController?.steer(inFlightKey, issue.body ?? "");
				if (steered) {
					process.stdout.write(`[webhook] steered description update on active execution ${inFlightKey}\n`);
					await this.postComment(owner, repo, issue.number, "Issue description updated. Steering to TARS.");
				} else {
					await this.postComment(owner, repo, issue.number, "Issue description updated but could not be steered.");
				}
				return;
			}
			await this.deps.sessionManager.updateStatus(owner, repo, issue.number, state.status, {
				body: issue.body ?? "",
				title: issue.title,
			});
			process.stdout.write(`[webhook] updated session body/title for ${inFlightKey}\n`);
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

		if (this.deps.taskController?.isDraining()) {
			process.stdout.write(`[webhook] ${payload.action} ignored: draining mode for ${inFlightKey}\n`);
			await this.postComment(owner, repo, issue.number, "Deploy in progress. Task will resume after restart.");
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

		const owner = payload.repository.owner.login;
		const repo = payload.repository.name;

		if (payload.issue.pull_request) {
			await this.handlePullRequestTimelineComment(payload);
			return;
		}

		const issueNumber = payload.issue.number;
		const inFlightKey = `${owner}/${repo}#${issueNumber}`;

		// Handle admin stop command
		const isStopCommand = payload.comment.body.trim().toLowerCase() === "/tars stop";
		if (isStopCommand) {
			if (!this.isAdmin(payload.sender.login)) {
				process.stdout.write(`[webhook] issue_comment ignored for ${repo}#${issueNumber}: /tars stop from non-admin\n`);
				await this.postComment(owner, repo, issueNumber, "Only admins can stop TARS.");
				return;
			}

			process.stdout.write(`[webhook] issue_comment stop command for ${repo}#${issueNumber} from admin\n`);
			const cancelledInFlight = this.deps.taskController?.cancel(inFlightKey) ?? false;
			if (cancelledInFlight) {
				await this.postComment(owner, repo, issueNumber, "Stopping TARS...");
				return;
			}

			const session = await this.deps.sessionManager.getSession(owner, repo, issueNumber);
			if (session && session.status === "working") {
				await this.deps.sessionManager.cancelSession(owner, repo, issueNumber);
				await this.safeRemoveLabel(owner, repo, issueNumber, "tars-working");
				await this.addLabels(owner, repo, issueNumber, ["tars-cancelled"]);
				await this.postComment(owner, repo, issueNumber, "Task cancelled by admin. TARS is idle.");
				process.stdout.write(`[webhook] stopped ${inFlightKey} (not in-flight)\n`);
			} else {
				await this.postComment(owner, repo, issueNumber, "TARS is not currently working on this issue.");
			}
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

		// If TARS is actively executing, steer the comment instead of starting a new run
		if (this.deps.taskController?.isActive(inFlightKey)) {
			const steered = await this.deps.taskController?.steer(inFlightKey, payload.comment.body);
			if (steered) {
				process.stdout.write(`[webhook] steered comment on active execution ${inFlightKey}\n`);
				await this.postComment(owner, repo, issueNumber, "Steering comment received.");
				return;
			}
			process.stdout.write(`[webhook] could not steer comment for ${inFlightKey}\n`);
			await this.postComment(owner, repo, issueNumber, "TARS is busy. Comment could not be steered.");
			return;
		}

		process.stdout.write(`[webhook] resuming ${owner}/${repo}#${issueNumber} from comment\n`);

		if (this.deps.taskController?.isDraining()) {
			process.stdout.write(`[webhook] comment ignored: draining mode for ${inFlightKey}\n`);
			await this.postComment(owner, repo, issueNumber, "Deploy in progress. Feedback will be processed after restart.");
			return;
		}

		// Fallback: auto-create session if it doesn't exist (e.g., assignment event was missed)
		let session = await this.deps.sessionManager.getSession(owner, repo, issueNumber);
		if (session && session.status === "paused") {
			process.stdout.write(`[webhook] comment ignored: ${inFlightKey} is paused\n`);
			await this.postComment(owner, repo, issueNumber, "TARS is paused on this issue. It will resume when unpaused.");
			return;
		}

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

	private async handlePullRequestTimelineComment(payload: CommentPayload): Promise<void> {
		const owner = payload.repository.owner.login;
		const repo = payload.repository.name;
		const prNumber = payload.issue.number;

		const { data: pullRequest } = await this.octokit.pulls.get({
			owner,
			repo,
			pull_number: prNumber,
		});

		const issueNumber = extractIssueNumberFromBranch(pullRequest.head.ref);
		if (!issueNumber) {
			await this.postComment(
				owner,
				repo,
				prNumber,
				[
					"**TARS stopped.**",
					"",
					`PR #${prNumber} head branch \`${pullRequest.head.ref}\` is not a TARS issue branch.`,
				].join("\n"),
			);
			return;
		}

		const isStopCommand = payload.comment.body.trim().toLowerCase() === "/tars stop";
		if (isStopCommand) {
			await this.handleStopCommand(owner, repo, issueNumber, prNumber, payload.sender.login);
			return;
		}

		await this.prReviewHandler.handlePullRequestReviewCommentEvent({
			action: payload.action,
			pull_request: {
				number: prNumber,
				head: {
					ref: pullRequest.head.ref,
				},
				state: pullRequest.state,
				merged: pullRequest.merged ?? false,
			},
			repository: payload.repository,
			sender: payload.sender,
			comment: {
				id: payload.comment.id ?? 0,
				body: payload.comment.body,
				user: payload.comment.user,
			},
		});
	}

	private async handleStopCommand(
		owner: string,
		repo: string,
		issueNumber: number,
		commentTargetNumber: number,
		senderLogin: string,
	): Promise<void> {
		if (!this.isAdmin(senderLogin)) {
			process.stdout.write(`[webhook] issue_comment ignored for ${repo}#${commentTargetNumber}: /tars stop from non-admin\n`);
			await this.postComment(owner, repo, commentTargetNumber, "Only admins can stop TARS.");
			return;
		}

		const inFlightKey = `${owner}/${repo}#${issueNumber}`;
		process.stdout.write(`[webhook] issue_comment stop command for ${repo}#${commentTargetNumber} mapped to ${inFlightKey} from admin\n`);
		const cancelledInFlight = this.deps.taskController?.cancel(inFlightKey) ?? false;
		if (cancelledInFlight) {
			await this.postComment(owner, repo, commentTargetNumber, "Stopping TARS...");
			return;
		}

		const session = await this.deps.sessionManager.getSession(owner, repo, issueNumber);
		if (session && session.status === "working") {
			await this.deps.sessionManager.cancelSession(owner, repo, issueNumber);
			await this.safeRemoveLabel(owner, repo, issueNumber, "tars-working");
			await this.addLabels(owner, repo, issueNumber, ["tars-cancelled"]);
			await this.postComment(owner, repo, commentTargetNumber, "Task cancelled by admin. TARS is idle.");
			process.stdout.write(`[webhook] stopped ${inFlightKey} (not in-flight)\n`);
		} else {
			await this.postComment(owner, repo, commentTargetNumber, "TARS is not currently working on this issue.");
		}
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

		const preflightError = await this.validateSessionBeforeExecution(state);
		if (preflightError) {
			process.stdout.write(`[webhook] execution blocked for ${owner}/${repo}#${issueNumber}: ${preflightError}\n`);
			await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "failed", {
				summary: preflightError,
			});
			await this.safeRemoveLabel(owner, repo, issueNumber, "tars-working");
			await this.addLabels(owner, repo, issueNumber, ["tars-failed"]);
			await this.postComment(
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

		state = await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "working");

		const inFlightKey = `${owner}/${repo}#${issueNumber}`;
		const abortController = new AbortController();

		let resolveSession: ((session: AgentSession) => void) | undefined;
		const sessionPromise = new Promise<AgentSession>((resolve) => {
			resolveSession = resolve;
		});

		this.deps.taskController?.register(
			inFlightKey,
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
				state,
				comment,
				undefined,
				abortController.signal,
				(session) => {
					resolveSession?.(session);
				},
			);
		} catch (error) {
			if (abortController.signal.aborted) {
				process.stdout.write(`[webhook] execution aborted for ${inFlightKey}\n`);
				await this.deps.sessionManager.cancelSession(owner, repo, issueNumber);
				await this.safeRemoveLabel(owner, repo, issueNumber, "tars-working");
				await this.addLabels(owner, repo, issueNumber, ["tars-cancelled"]);
				await this.postComment(owner, repo, issueNumber, "Task cancelled by admin. TARS is idle.");
				return;
			}

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
		} finally {
			this.deps.taskController?.unregister(inFlightKey);
		}

		// If session was paused during execution, skip all further status updates
		const postExecState = await this.deps.sessionManager.getSession(owner, repo, issueNumber);
		if (postExecState?.status === "paused") {
			process.stdout.write(`[webhook] ${inFlightKey} paused during execution; suppressing result transitions\n`);
			return;
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
			let prUrl: string | undefined;
			try {
				// Push branch so code is actually delivered
				const pushed = await this.deps.workspaceManager.commitAndPush(
					owner,
					repo,
					issueNumber,
					generateCommitMessage(state.labels, issueNumber, result.summary),
				);

				if (pushed) {
					// Create PR via GitHub API
					prUrl = await this.createPR(owner, repo, issueNumber, state.title, result.summary);
				}
			} catch (error) {
				await this.handleDeliveryFailure(owner, repo, issueNumber, state, error);
				return;
			}

			updatedState = await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "complete");
			process.stdout.write(`[webhook] marked complete ${repo}#${issueNumber}\n`);

			if (prUrl) {
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
			} else {
				await this.postComment(
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
			updatedState = await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "cancelled");
			process.stdout.write(`[webhook] marked cancelled ${repo}#${issueNumber}\n`);
			await this.safeRemoveLabel(owner, repo, issueNumber, "tars-working");
			await this.addLabels(owner, repo, issueNumber, ["tars-cancelled"]);
			await this.postComment(
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

		const { data: pullRequest } = await this.octokit.pulls.get({
			owner: state.owner,
			repo: state.repo,
			pull_number: state.prNumber,
		});

		return validatePRSessionMapping(state, state.prNumber, pullRequest.head.ref);
	}

	private async createPR(
		owner: string,
		repo: string,
		issueNumber: number,
		title: string,
		summary: string,
	): Promise<string | undefined> {
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
			if (message.includes("No commits between")) {
				// GitHub rejects PR creation when the branch has no unique commits
				// compared to the base. Treat this as "no changes needed".
				return undefined;
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

	async resumeInterruptedSession(owner: string, repo: string, issueNumber: number): Promise<void> {
		const inFlightKey = `${owner}/${repo}#${issueNumber}`;
		const session = await this.deps.sessionManager.getSession(owner, repo, issueNumber);
		if (!session) {
			process.stdout.write(`[resume] no session for ${inFlightKey}\n`);
			return;
		}
		if (session.status !== "working") {
			process.stdout.write(`[resume] session ${inFlightKey} is not in working status (${session.status})\n`);
			return;
		}
		process.stdout.write(`[resume] restarting interrupted session ${inFlightKey}\n`);
		await this.postComment(
			owner,
			repo,
			issueNumber,
			"TARS was restarted while working on this issue. Resuming work...",
		);
		this.inFlight.add(inFlightKey);
		try {
			await this.runExecution(owner, repo, issueNumber);
		} finally {
			this.inFlight.delete(inFlightKey);
		}
	}

	isInFlight(owner: string, repo: string, issueNumber: number): boolean {
		return this.inFlight.has(`${owner}/${repo}#${issueNumber}`);
	}
}
