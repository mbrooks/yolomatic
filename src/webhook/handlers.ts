import { Octokit } from "@octokit/rest";

import type { ExecutionResult, PiAgentExecutor } from "../executor/index.js";
import { TimeoutError } from "../session/timer.js";
import type { SessionManager } from "../session/manager.js";
import type { SessionState } from "../session/store.js";
import type { WorkspaceManager } from "../workspace/manager.js";

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

function extractTimeoutFromLabels(labels: IssueLabel[] | undefined, baseTimeout: number): number {
	const match = (labels ?? [])
		.map((l) => l.name ?? "")
		.find((name) => /^tars-timeout:\d+$/u.test(name));
	if (!match) return baseTimeout;
	const minutes = Number(match.slice("tars-timeout:".length));
	if (!Number.isFinite(minutes)) return baseTimeout;
	if (minutes < 5) {
		process.stderr.write(`[webhook] Label timeout ${minutes} is below minimum 5, clamped to 5.\n`);
		return 5;
	}
	if (minutes > 60) {
		process.stderr.write(`[webhook] Label timeout ${minutes} exceeds maximum 60, clamped to 60.\n`);
		return 60;
	}
	return minutes;
}

export interface WebhookHandlers {
	handleIssueEvent(payload: unknown): Promise<void>;
	handleCommentEvent(payload: unknown): Promise<void>;
}

export class GitHubIssueHandlers implements WebhookHandlers {
	private readonly octokit: Octokit;
	private readonly inFlight = new Set<string>();

	public constructor(
		private readonly deps: {
			sessionManager: SessionManager;
			workspaceManager: WorkspaceManager;
			executor: PiAgentExecutor;
			githubToken: string;
			githubUsername: string;
			autoStart: boolean;
			defaultBranch: string;
			sessionTimeoutMinutes: number;
			octokit?: Octokit;
		},
	) {
		this.octokit = deps.octokit ?? new Octokit({ auth: deps.githubToken });
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
		await this.runExecution(owner, repo, issue.number, undefined, extractTimeoutFromLabels(issue.labels, this.deps.sessionTimeoutMinutes));
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

		if (payload.sender.login === this.deps.githubUsername) {
			process.stdout.write(
				`[webhook] issue_comment ignored for ${payload.repository.name}#${payload.issue.number}: event from ${this.deps.githubUsername}\n`,
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

		// Only process comments on issues assigned to TARS
		if (!this.isAssignedToTars(payload.issue)) {
			process.stdout.write(
				`[webhook] issue_comment ignored for ${payload.repository.name}#${payload.issue.number}: not assigned to ${this.deps.githubUsername}\n`,
			);
			return;
		}

		const tarsLabels = ["tars-working", "tars-feedback-required", "tars-pr-created", "tars-complete"];
		const hasTarsLabel = hasAnyLabel(payload.issue.labels, tarsLabels);
		const isMentioned = payload.comment.body.includes(`@${this.deps.githubUsername}`);

		if (!hasTarsLabel && !isMentioned) {
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
			);
		}

		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-feedback-required");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-pr-created");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-complete");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-working");
		await this.addLabels(owner, repo, issueNumber, ["tars-working"]);
		await this.postComment(owner, repo, issueNumber, "Feedback received. Resuming work.");
		await this.runExecution(owner, repo, issueNumber, payload.comment.body, extractTimeoutFromLabels(payload.issue.labels, this.deps.sessionTimeoutMinutes));
	}

	private async runExecution(owner: string, repo: string, issueNumber: number, comment?: string, resolvedTimeout?: number): Promise<void> {
		const timeoutMinutes = resolvedTimeout ?? this.deps.sessionTimeoutMinutes;
		await this.deps.workspaceManager.createOrGetWorktree(owner, repo, issueNumber);

		let state = await this.deps.sessionManager.getSession(owner, repo, issueNumber);
		if (!state) {
			throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
		}
		process.stdout.write(
			`[webhook] execute repo=${owner}/${repo} issue=#${issueNumber} session=${state.sessionPath} timeout=${timeoutMinutes}m\n`,
		);

		state = await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "working");

		let result: ExecutionResult;
		try {
			result = await this.deps.executor.execute(state, comment, { timeoutMinutes });
		} catch (error) {
			if (error instanceof TimeoutError) {
				await this.handleTimeout(owner, repo, issueNumber, state, error);
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
			updatedState = await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "complete");
			process.stdout.write(`[webhook] marked complete ${repo}#${issueNumber}\n`);

			// Push branch so code is actually delivered
			await this.deps.workspaceManager.commitAndPush(owner, repo, issueNumber);

			// Create PR via GitHub API
			const prUrl = await this.createPR(owner, repo, issueNumber, state.title, result.summary);

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

		const pr = await this.octokit.pulls.create({
			owner,
			repo,
			title: `TARS: ${title}`,
			body: `Fixes #${issueNumber}\n\n${summary}`,
			head,
			base,
		});

		return pr.data.html_url;
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

	private async handleTimeout(
		owner: string,
		repo: string,
		issueNumber: number,
		state: SessionState,
		error: TimeoutError,
	): Promise<void> {
		process.stdout.write(`[webhook] timeout reached for ${repo}#${issueNumber}: ${error.message}\n`);

		const diffNames = await this.deps.workspaceManager.getDiffNames(owner, repo, issueNumber);
		const gitStatus = await this.deps.workspaceManager.getGitStatus(owner, repo, issueNumber);

		const elapsedMinutes = Math.round(error.elapsedMs / 60000);

		const body = [
			"**⏱️ Session timed out.**",
			"",
			`${error.message}.`,
			"",
			"TARS attempted the following before stopping:",
			`- ${state.title}`,
			"",
			diffNames.length > 0
				? `Files touched:\n${diffNames.map((name) => `- \`${name}\``).join("\n")}`
				: "No files were modified.",
			gitStatus ? `\n\nGit status:\n\`\`\`\n${gitStatus}\n\`\`\`` : "",
			"",
			"The session hit its configured time limit and stopped to avoid wasting resources. If more time is needed, remove and re-add the \`tars-working\` label or mention @tars-bot.",
		].join("\n");

		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-working");
		await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "failed");
		await this.addLabels(owner, repo, issueNumber, ["tars-failed"]);
		await this.postComment(owner, repo, issueNumber, body);
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
}
