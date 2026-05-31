import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import { hasTarsVisibleLabel, isAdmin, isStopCommand, shouldIgnoreCommentEvent } from "../../domain/workflow/policy.js";
import { issueSessionKey, markIssueWorking, queueResumeOnBoot, stopSessionByAdmin } from "./workflow-helpers.js";
import { extractIssueNumberFromBranch } from "../../pr-review/session-invariant.js";
import type { HandlePRReview, PRReviewPayload } from "./handle-pr-review.js";
import { ExecuteSession, type ExecuteSessionDeps } from "./execute-session.js";

export interface CommentEventPayload {
	action: string;
	issue: {
		number: number;
		title?: string;
		body?: string | null;
		pull_request?: { url: string };
		labels?: Array<{ name?: string }>;
		assignee?: { login: string } | null;
		assignees?: { login: string }[];
		user?: { login: string };
	};
	comment: { id?: number; body: string; user: { login: string; type?: string } };
	repository: { name: string; owner: { login: string } };
	sender: { login: string };
}

export class HandleIssueComment {
	private readonly executor: ExecuteSession;

	constructor(
		private readonly deps: {
			sessions: SessionRepository;
			workspaces: WorkspaceService;
			tasks: TaskControlService;
			github: GitHubService;
			autoStart: boolean;
			githubUsername: string;
			adminGithubUsername?: string;
			executor: ExecuteSessionDeps;
			prReview?: HandlePRReview;
		},
	) {
		this.executor = new ExecuteSession(deps.executor);
	}

	async execute(payload: CommentEventPayload): Promise<void> {
		if (payload.action !== "created") {
			process.stdout.write(`[webhook] issue_comment action ignored: ${payload.action}\n`);
			return;
		}

		const owner = payload.repository.owner.login;
		const repo = payload.repository.name;
		const issueNumber = payload.issue.number;
		const key = issueSessionKey(owner, repo, issueNumber);

		if (payload.comment.user.login === this.deps.githubUsername) {
			process.stdout.write(`[webhook] issue_comment ignored for ${repo}#${issueNumber}: comment from ${this.deps.githubUsername}\n`);
			return;
		}

		if (payload.comment.user.type === "Bot") {
			process.stdout.write(`[webhook] issue_comment ignored for ${repo}#${issueNumber}: bot comment\n`);
			return;
		}

		// PR timeline comments route through PR review handler
		if (payload.issue.pull_request) {
			const pr = await this.deps.github.getPullRequest(owner, repo, issueNumber);
			if (!pr) {
				process.stdout.write(`[webhook] issue_comment ignored for ${repo}#${issueNumber}: could not fetch PR\n`);
				return;
			}
			const branchIssueNumber = extractIssueNumberFromBranch(pr.head.ref);
			const mappedSession = branchIssueNumber ? null : await this.deps.sessions.findSessionByPR(owner, repo, issueNumber);
			const mappedIssueNumber = branchIssueNumber ?? mappedSession?.issueNumber;
			if (!mappedIssueNumber) {
				process.stdout.write(
					`[webhook] issue_comment ignored for ${owner}/${repo}#${issueNumber}: PR branch ${pr.head.ref} is not associated with a TARS session\n`,
				);
				return;
			}

			if (isStopCommand(payload.comment.body)) {
				if (!isAdmin(payload.sender.login, this.deps.adminGithubUsername)) {
					await this.deps.github.postComment(owner, repo, issueNumber, "Only admins can stop TARS.");
					return;
				}
				await stopSessionByAdmin(
					this.deps.sessions,
					this.deps.github,
					this.deps.tasks,
					owner,
					repo,
					mappedIssueNumber,
					issueNumber,
				);
				return;
			}

			if (this.deps.prReview) {
				await this.deps.prReview.execute({
					action: payload.action,
					pull_request: {
						number: issueNumber,
						head: pr.head,
						state: pr.state,
						merged: pr.merged,
					},
					repository: payload.repository,
					sender: payload.sender,
					comment: {
						id: payload.comment.id ?? 0,
						body: payload.comment.body,
						user: payload.comment.user,
					},
				} as PRReviewPayload);
			}
			return;
		}

		// Handle admin stop command
		if (isStopCommand(payload.comment.body)) {
			if (!isAdmin(payload.sender.login, this.deps.adminGithubUsername)) {
			process.stdout.write(`[webhook] issue_comment ignored for ${repo}#${issueNumber}: /tars stop from non-admin\n`);
			await this.deps.github.postComment(owner, repo, issueNumber, "Only admins can stop TARS.");
			return;
		}
		process.stdout.write(`[webhook] issue_comment stop command for ${repo}#${issueNumber} from admin\n`);
		const stopResult = await stopSessionByAdmin(
			this.deps.sessions,
			this.deps.github,
			this.deps.tasks,
			owner,
			repo,
			issueNumber,
		);
		if (stopResult === "cancelled") {
			process.stdout.write(`[webhook] stopped ${key} (not in-flight)\n`);
		}
		return;
	}

		const check = shouldIgnoreCommentEvent(payload, this.deps.githubUsername);
		if (check.ignore) {
			process.stdout.write(`[webhook] issue_comment ignored for ${repo}#${issueNumber}: ${check.reason}\n`);
			return;
		}

		if (check.isMentioned) {
			process.stdout.write(`[webhook] issue_comment accepted for ${repo}#${issueNumber}: mentioned\n`);
		} else if (check.isCreatedByTars) {
			process.stdout.write(`[webhook] issue_comment accepted for ${repo}#${issueNumber}: created by ${this.deps.githubUsername}\n`);
		} else {
			process.stdout.write(`[webhook] issue_comment accepted for ${repo}#${issueNumber}: has tars label\n`);
		}

		// Auto-label on mention so future comments pass via label gate
		const hasTarsLabel = hasTarsVisibleLabel(payload.issue.labels);
		if (check.isMentioned && !hasTarsLabel) {
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars"]);
			process.stdout.write(`[webhook] added tars label to ${owner}/${repo}#${issueNumber}\n`);
		}

		// If TARS is actively executing, steer the comment instead of starting a new run
		if (this.deps.tasks.isActive(key)) {
			const steered = await this.deps.tasks.steer(key, payload.comment.body);
			if (steered) {
				process.stdout.write(`[webhook] steered comment on active execution ${key}\n`);
				await this.deps.github.postComment(owner, repo, issueNumber, "Steering comment received.");
				return;
			}
			process.stdout.write(`[webhook] could not steer comment for ${key}\n`);
			await this.deps.github.postComment(owner, repo, issueNumber, "TARS is busy. Comment could not be steered.");
			return;
		}

		if (this.deps.tasks.isDraining()) {
			process.stdout.write(`[webhook] comment ignored: draining mode for ${key}\n`);
			const session = await this.deps.sessions.get(owner, repo, issueNumber);
			if (session) {
				await queueResumeOnBoot(this.deps.sessions, session, [payload.comment.body]);
			}
			await this.deps.github.postComment(owner, repo, issueNumber, "Deploy in progress. Feedback will be processed after restart.");
			return;
		}

		let session = await this.deps.sessions.get(owner, repo, issueNumber);
		if (session && session.status === "paused") {
			process.stdout.write(`[webhook] comment ignored: ${key} is paused\n`);
			await this.deps.github.postComment(owner, repo, issueNumber, "TARS is paused on this issue. It will resume when unpaused.");
			return;
		}

		if (!session) {
			const worktree = await this.deps.workspaces.createOrGetWorktree(owner, repo, issueNumber);
			session = await this.deps.sessions.createSession(
				owner,
				repo,
				issueNumber,
				payload.issue.title ?? "",
				payload.issue.body ?? "",
				worktree.path,
				payload.issue.labels?.map((l) => l.name).filter((n): n is string => !!n),
			);
		}

		await markIssueWorking(this.deps.github, owner, repo, issueNumber, "Feedback received. Resuming work.");
		await this.executor.run(session, payload.comment.body);
	}
}
