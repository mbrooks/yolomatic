import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import { isAdmin, isStopCommand, shouldIgnoreCommentEvent } from "../../domain/workflow/policy.js";
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
		const key = `${owner}/${repo}#${issueNumber}`;

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
			const mappedIssueNumber = extractIssueNumberFromBranch(pr.head.ref);
			if (!mappedIssueNumber) {
				await this.deps.github.postComment(
					owner,
					repo,
					issueNumber,
					[
						"**TARS stopped.**",
						"",
						`PR #${issueNumber} head branch \`${pr.head.ref}\` is not a TARS issue branch.`,
					].join("\n"),
				);
				return;
			}

			const isStopCommand = payload.comment.body.trim().toLowerCase() === "/tars stop";
			if (isStopCommand) {
				if (!isAdmin(payload.sender.login, this.deps.adminGithubUsername)) {
					await this.deps.github.postComment(owner, repo, issueNumber, "Only admins can stop TARS.");
					return;
				}
				const inFlightKey = `${owner}/${repo}#${mappedIssueNumber}`;
				const cancelled = this.deps.tasks.cancel(inFlightKey);
				if (cancelled) {
					await this.deps.github.postComment(owner, repo, issueNumber, "Stopping TARS...");
					return;
				}
				const session = await this.deps.sessions.get(owner, repo, mappedIssueNumber);
				if (session && session.status === "working") {
					await this.deps.sessions.cancelSession(owner, repo, mappedIssueNumber);
					await this.deps.github.removeLabel(owner, repo, mappedIssueNumber, "tars-working");
					await this.deps.github.addLabels(owner, repo, mappedIssueNumber, ["tars-cancelled"]);
					await this.deps.github.postComment(owner, repo, issueNumber, "Task cancelled by admin. TARS is idle.");
				} else {
					await this.deps.github.postComment(owner, repo, issueNumber, "TARS is not currently working on this issue.");
				}
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
			const wasActive = this.deps.tasks.isActive(key);
			const cancelled = this.deps.tasks.cancel(key);
			if (cancelled) {
				await this.deps.github.postComment(owner, repo, issueNumber, "Stopping TARS...");
				return;
			}
			const session = await this.deps.sessions.get(owner, repo, issueNumber);
			if (session && session.status === "working") {
				await this.deps.sessions.cancelSession(owner, repo, issueNumber);
				await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-working");
				await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-cancelled"]);
				await this.deps.github.postComment(owner, repo, issueNumber, "Task cancelled by admin. TARS is idle.");
				process.stdout.write(`[webhook] stopped ${key} (not in-flight)\n`);
			} else {
				await this.deps.github.postComment(owner, repo, issueNumber, "TARS is not currently working on this issue.");
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
		const hasTarsLabel =
			(payload.issue.labels ?? []).some(
				(l) => l.name && ["tars-working", "tars-feedback-required", "tars-pr-created", "tars-complete", "tars"].includes(l.name),
			);
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
				const queued = [...(session.queuedComments ?? []), payload.comment.body];
				await this.deps.sessions.updateStatus(owner, repo, issueNumber, session.status, {
					resumeOnBoot: true,
					queuedComments: queued,
				});
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

		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-feedback-required");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-pr-created");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-complete");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-working");
		await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-working"]);
		await this.deps.github.postComment(owner, repo, issueNumber, "Feedback received. Resuming work.");
		await this.executor.run(session, payload.comment.body);
	}
}
