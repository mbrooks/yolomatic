import { Octokit } from "@octokit/rest";

import type { PiAgentExecutor } from "../executor/index.js";
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

export interface WebhookHandlers {
	handleIssueEvent(payload: unknown): Promise<void>;
	handleCommentEvent(payload: unknown): Promise<void>;
}

export class GitHubIssueHandlers implements WebhookHandlers {
	private readonly octokit: Octokit;

	public constructor(
		private readonly deps: {
			sessionManager: SessionManager;
			workspaceManager: WorkspaceManager;
			executor: PiAgentExecutor;
			githubToken: string;
			githubUsername: string;
			autoStart: boolean;
			defaultBranch: string;
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
			const state = await this.deps.sessionManager.getSession(repo, issue.number);
			if (state && (state.status === "working" || state.status === "waiting-feedback")) {
				await this.deps.sessionManager.updateStatus(repo, issue.number, "pending");
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

		const workspace = await this.deps.workspaceManager.ensureWorkspace(owner, repo);

		await this.deps.sessionManager.createSession(
			owner,
			repo,
			issue.number,
			issue.title,
			issue.body ?? "",
			workspace.path,
		);

		if (!this.deps.autoStart) {
			process.stdout.write(`[webhook] auto-start disabled for ${repo}#${issue.number}\n`);
			return;
		}

		process.stdout.write(`[webhook] auto-starting ${repo}#${issue.number}\n`);
		await this.addLabels(owner, repo, issue.number, ["tars-working"]);
		await this.postComment(owner, repo, issue.number, "Picked up by TARS. Working on it...");
		await this.runExecution(owner, repo, issue.number);
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
		if (!hasTarsLabel) {
			process.stdout.write(
				`[webhook] issue_comment ignored for ${payload.repository.name}#${payload.issue.number}: no tars label\n`,
			);
			return;
		}

		const owner = payload.repository.owner.login;
		const repo = payload.repository.name;
		const issueNumber = payload.issue.number;
		process.stdout.write(`[webhook] resuming ${owner}/${repo}#${issueNumber} from comment\n`);

		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-feedback-required");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-pr-created");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-complete");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-working");
		await this.addLabels(owner, repo, issueNumber, ["tars-working"]);
		await this.postComment(owner, repo, issueNumber, "Feedback received. Resuming work.");
		await this.runExecution(owner, repo, issueNumber, payload.comment.body);
	}

	private async runExecution(owner: string, repo: string, issueNumber: number, comment?: string): Promise<void> {
		let state = await this.deps.sessionManager.getSession(repo, issueNumber);
		if (!state) {
			throw new Error(`No session found for ${repo}-issue-${issueNumber}`);
		}
		process.stdout.write(
			`[webhook] execute repo=${owner}/${repo} issue=#${issueNumber} session=${state.sessionPath}\n`,
		);

		await this.deps.workspaceManager.getOrCreateBranch(owner, repo, issueNumber);
		state = await this.deps.sessionManager.updateStatus(repo, issueNumber, "working");

		const result = await this.deps.executor.execute(state, comment);
		process.stdout.write(
			`[webhook] execution result repo=${repo} issue=#${issueNumber} status=${result.status}\n`,
		);
		let updatedState: SessionState;

		if (!state.seeded && !comment) {
			await this.deps.sessionManager.markSeeded(repo, issueNumber);
		}

		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-working");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-feedback-required");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-complete");
		await this.safeRemoveLabel(owner, repo, issueNumber, "tars-pr-created");

		if (result.status === "waiting-feedback") {
			updatedState = await this.deps.sessionManager.updateStatus(repo, issueNumber, "waiting-feedback");
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
			updatedState = await this.deps.sessionManager.updateStatus(repo, issueNumber, "complete");
			process.stdout.write(`[webhook] marked complete ${repo}#${issueNumber}\n`);

			// Push branch so code is actually delivered
			await this.deps.workspaceManager.commitAndPushBranch(owner, repo, issueNumber);

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

		updatedState = await this.deps.sessionManager.updateStatus(repo, issueNumber, "working");
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

	private async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
		await this.octokit.issues.createComment({
			owner,
			repo,
			issue_number: issueNumber,
			body,
		});
	}
}
