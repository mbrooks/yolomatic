import type { PRReviewHandler } from "../pr-review/handler.js";
import { extractIssueNumberFromBranch } from "../pr-review/session-invariant.js";
import { SessionWorkflow } from "../session/workflow.js";
import { GitHubClient } from "../github/client.js";
import { IssueExecutionService } from "./execution-service.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { AdminCommandService } from "../admin-commands/service.js";

interface IssueLabel {
	name?: string;
}

export interface CommentPayload {
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

const TARS_WORKFLOW_LABELS = ["tars-working", "tars-feedback-required", "tars-pr-created", "tars-complete"];

function hasLabel(labels: IssueLabel[] | undefined, label: string): boolean {
	return (labels ?? []).some((item) => item.name === label);
}

function hasAnyLabel(labels: IssueLabel[] | undefined, searchLabels: string[]): boolean {
	return (labels ?? []).some((item) => item.name && searchLabels.includes(item.name));
}

export class IssueCommentService {
	public constructor(
		private readonly deps: {
			workflow: SessionWorkflow;
			workspaceManager: WorkspaceManager;
			executionService: IssueExecutionService;
			github: GitHubClient;
			prReviewHandler: PRReviewHandler;
			adminCommands: AdminCommandService;
			githubUsername: string;
		},
	) {}

	async handleCommentEvent(payload: CommentPayload): Promise<void> {
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

		if (payload.comment.user.type === "Bot") {
			process.stdout.write(
				`[webhook] issue_comment ignored for ${payload.repository.name}#${payload.issue.number}: bot comment\n`,
			);
			return;
		}

		const owner = payload.repository.owner.login;
		const repo = payload.repository.name;

		if (payload.issue.pull_request) {
			await this.handlePullRequestTimelineComment(payload, owner, repo);
			return;
		}

		const issueNumber = payload.issue.number;
		const isStopCommand = payload.comment.body.trim().toLowerCase() === "/tars stop";
		if (isStopCommand) {
			await this.deps.adminCommands.handleStopCommand({
				owner,
				repo,
				issueNumber,
				commentTargetNumber: issueNumber,
				senderLogin: payload.sender.login,
			});
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

		if (isMentioned && !hasTarsLabel) {
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars"]);
			process.stdout.write(`[webhook] added tars label to ${owner}/${repo}#${issueNumber}\n`);
		}

		process.stdout.write(`[webhook] resuming ${owner}/${repo}#${issueNumber} from comment\n`);

		let session = await this.deps.workflow.getSession(owner, repo, issueNumber);
		if (!session) {
			const worktree = await this.deps.workspaceManager.createOrGetWorktree(owner, repo, issueNumber);
			session = await this.deps.workflow.createSession(
				owner,
				repo,
				issueNumber,
				payload.issue.title ?? "",
				payload.issue.body ?? "",
				worktree.path,
				payload.issue.labels?.map((label) => label.name).filter((name): name is string => !!name),
			);
		}

		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-feedback-required");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-pr-created");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-complete");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-working");
		await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-working"]);
		await this.deps.github.createComment(owner, repo, issueNumber, "Feedback received. Resuming work.");
		await this.deps.executionService.executeIssue(owner, repo, issueNumber, payload.comment.body);
	}

	private isAssignedToTars(issue: { assignee?: { login: string } | null; assignees?: { login: string }[] }): boolean {
		if (issue.assignees && issue.assignees.some((assignee) => assignee.login === this.deps.githubUsername)) return true;
		if (issue.assignee?.login === this.deps.githubUsername) return true;
		return false;
	}

	private async handlePullRequestTimelineComment(payload: CommentPayload, owner: string, repo: string): Promise<void> {
		const prNumber = payload.issue.number;
		const pullRequest = await this.deps.github.getPullRequest(owner, repo, prNumber);
		const branchIssueNumber = extractIssueNumberFromBranch(pullRequest.head.ref);
		const mappedSession = branchIssueNumber ? null : await this.deps.workflow.findSessionByPR(owner, repo, prNumber);
		const issueNumber = branchIssueNumber ?? mappedSession?.issueNumber;
		if (!issueNumber) {
			process.stdout.write(
				`[webhook] issue_comment ignored for ${owner}/${repo}#${prNumber}: PR branch ${pullRequest.head.ref} is not associated with a TARS session\n`,
			);
			return;
		}

		const isStopCommand = payload.comment.body.trim().toLowerCase() === "/tars stop";
		if (isStopCommand) {
			await this.deps.adminCommands.handleStopCommand({
				owner,
				repo,
				issueNumber,
				commentTargetNumber: prNumber,
				senderLogin: payload.sender.login,
			});
			return;
		}

		await this.deps.prReviewHandler.handlePullRequestReviewCommentEvent({
			action: payload.action,
			pull_request: {
				number: prNumber,
				head: {
					ref: pullRequest.head.ref,
				},
				state: pullRequest.state,
				merged: pullRequest.merged,
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
}
