import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { GitHubService, IssueComment } from "../../ports/github-service.js";
import type { GitHubEventSource } from "../../github-events/model.js";
import { commentTriggersFeedback, hasYeetomaticVisibleLabel, isStopCommand, parseIssueRefinementCommand } from "../../domain/workflow/policy.js";
import type { PriorDiscussionComment } from "../../executor/index.js";
import { formatPriorDiscussion } from "../../executor/index.js";
import {
	issueSessionKey,
	startIssueExecution,
	handleAdminStop,
	resolveIssueContext,
	guardEvent,
	prepareIssueSession,
	routePRTimelineComment,
} from "./workflow-helpers.js";
import { ExecuteSession, type ExecuteSessionDeps } from "./execute-session.js";
import type { HandleIssueRefinement } from "./handle-issue-refinement.js";
import { appendAdminLink, resolveAdminIssueUrl } from "./comment-links.js";

export interface CommentEventPayload {
	source?: GitHubEventSource;
	action: string;
	issue: {
		number: number;
		state?: string;
		title?: string;
		body?: string | null;
		pull_request?: { url: string };
		labels?: Array<{ name?: string }>;
		assignee?: { login: string } | null;
		assignees?: { login: string }[];
		user?: { login: string };
	};
	comment: { id?: number; body: string; user: { login: string; type?: string }; created_at?: string };
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
			defaultBranch?: string;
			resolveDefaultBranch?: (owner: string, repo: string) => string;
			githubUsername: string;
			adminGithubUsername?: string;
			executor: ExecuteSessionDeps;
			refinement?: HandleIssueRefinement;
			prReview?: { execute: (payload: import("./handle-pr-review.js").PRReviewPayload) => Promise<void> };
			issueAdminLinkInCommentsEnabled?: boolean;
			adminBaseUrl?: string;
			resolveAdminBaseUrl?: () => string | undefined;
			resolveIssueAdminLinkInCommentsEnabled?: () => boolean | undefined;
		},
	) {
		this.executor = new ExecuteSession(deps.executor);
	}

	private adminIssueUrl(owner: string, repo: string, issueNumber: number): string | undefined {
		const adminBaseUrl = this.deps.resolveAdminBaseUrl?.() ?? this.deps.adminBaseUrl;
		const issueAdminLinkInCommentsEnabled =
			this.deps.resolveIssueAdminLinkInCommentsEnabled?.() ?? this.deps.issueAdminLinkInCommentsEnabled;
		return resolveAdminIssueUrl(adminBaseUrl, issueAdminLinkInCommentsEnabled, owner, repo, issueNumber);
	}

	async execute(payload: CommentEventPayload): Promise<void> {
		if (payload.action !== "created") {
			process.stdout.write(`[webhook] issue_comment action ignored: ${payload.action}\n`);
			return;
		}

		const ctx = resolveIssueContext(payload, this.deps.resolveDefaultBranch, this.deps.defaultBranch);
		const { owner, repo, issueNumber, key } = ctx;

		if (payload.comment.user.login === this.deps.githubUsername) {
			process.stdout.write(`[webhook] issue_comment ignored for ${repo}#${issueNumber}: comment from ${this.deps.githubUsername}\n`);
			return;
		}

		if (payload.comment.user.type === "Bot") {
			process.stdout.write(`[webhook] issue_comment ignored for ${repo}#${issueNumber}: bot comment\n`);
			return;
		}

		const refinement = parseIssueRefinementCommand(payload.comment.body);
		if (refinement.matched && this.deps.refinement) {
			await this.deps.refinement.execute(payload, refinement.steeringPrompt);
			return;
		}

		// PR timeline comments route through PR review handler
		if (await routePRTimelineComment(
			{
				github: this.deps.github,
				sessions: this.deps.sessions,
				tasks: this.deps.tasks,
				adminGithubUsername: this.deps.adminGithubUsername,
				prReview: this.deps.prReview,
			},
			payload,
			owner,
			repo,
			issueNumber,
		)) {
			return;
		}

		// Handle admin stop command
		if (isStopCommand(payload.comment.body)) {
			const result = await handleAdminStop(
				this.deps.github,
				this.deps.tasks,
				this.deps.sessions,
				payload.sender.login,
				this.deps.adminGithubUsername,
				owner,
				repo,
				issueNumber,
				issueNumber,
			);
			if (result === "not-admin") {
				process.stdout.write(`[webhook] issue_comment ignored for ${repo}#${issueNumber}: /yeetomatic stop from non-admin\n`);
			} else {
				process.stdout.write(`[webhook] issue_comment stop command for ${repo}#${issueNumber} from admin\n`);
			}
			if (result === "cancelled") {
				process.stdout.write(`[webhook] stopped ${key} (not in-flight)\n`);
			}
			return;
		}

		const guard = guardEvent("issue_comment", payload, this.deps.githubUsername);
		if (guard.skip) {
			process.stdout.write(`[webhook] issue_comment ignored for ${repo}#${issueNumber}: ${guard.reason}\n`);
			return;
		}

		if (guard.isMentioned) {
			process.stdout.write(`[webhook] issue_comment accepted for ${repo}#${issueNumber}: mentioned\n`);
		} else if (guard.isFeedbackCommand) {
			process.stdout.write(`[webhook] issue_comment accepted for ${repo}#${issueNumber}: /yeetomatic feedback command\n`);
		} else {
			process.stdout.write(`[webhook] issue_comment accepted for ${repo}#${issueNumber}\n`);
		}

		// Auto-label on mention so future comments carry the routing-marker label.
		// The label is no longer part of the comment gate; this only refreshes the
		// routing marker.
		const hasYeetomaticLabel = hasYeetomaticVisibleLabel(payload.issue.labels);
		if (guard.isMentioned && !hasYeetomaticLabel) {
			await this.deps.github.addLabels(owner, repo, issueNumber, ["yeetomatic"]);
			process.stdout.write(`[webhook] added yeetomatic label to ${owner}/${repo}#${issueNumber}\n`);
		}

		// Gather prior non-trigger comments as background context for the
		// feedback/steering prompt. Degrades gracefully to the triggering comment
		// alone when the read fails or returns nothing.
		const priorComments = await this.gatherPriorContext(owner, repo, issueNumber, payload.comment);

		// If Yeetomatic is actively executing, steer the comment (with prior
		// context) instead of starting a new run.
		if (this.deps.tasks.isActive(key)) {
			const steered = await this.deps.tasks.steer(key, composeSteerMessage(payload.comment.body, priorComments));
			if (steered) {
				process.stdout.write(`[webhook] steered comment on active execution ${key}\n`);
				await this.deps.github.postComment(owner, repo, issueNumber, "Steering comment received.");
				return;
			}
			process.stdout.write(`[webhook] could not steer comment for ${key}\n`);
			await this.deps.github.postComment(owner, repo, issueNumber, "Yeetomatic is busy. Comment could not be steered.");
			return;
		}

		const prepared = await prepareIssueSession(
			{
				sessions: this.deps.sessions,
				workspaces: this.deps.workspaces,
				github: this.deps.github,
				tasks: this.deps.tasks,
			},
			{
				owner,
				repo,
				issueNumber,
				title: payload.issue.title ?? "",
				body: payload.issue.body ?? "",
				labels: payload.issue.labels?.map((l) => l.name).filter((n): n is string => !!n),
				defaultBranch: ctx.defaultBranch,
			},
			{ commentBodies: [payload.comment.body] },
		);

		if (prepared.skip) {
			process.stdout.write(`[webhook] comment ignored: draining mode for ${key}\n`);
			return;
		}

		const session = prepared.session;
		if (session.status === "paused") {
			process.stdout.write(`[webhook] comment ignored: ${key} is paused\n`);
			await this.deps.github.postComment(owner, repo, issueNumber, this.withLink(owner, repo, issueNumber, "Yeetomatic is paused on this issue. It will resume when unpaused."));
			return;
		}

		await startIssueExecution(
			this.executor,
			this.deps.github,
			owner,
			repo,
			issueNumber,
			session,
			"Feedback received. Resuming work.",
			payload.comment.body,
			this.adminIssueUrl(owner, repo, issueNumber),
			priorComments,
		);
	}

	private async gatherPriorContext(
		owner: string,
		repo: string,
		issueNumber: number,
		triggerComment: { id?: number; body: string; created_at?: string },
	): Promise<PriorDiscussionComment[]> {
		try {
			const comments = await this.deps.github.listIssueComments(owner, repo, issueNumber);
			return selectPriorContextComments(comments, triggerComment, this.deps.githubUsername);
		} catch (error) {
			process.stdout.write(
				`[webhook] listIssueComments failed for ${owner}/${repo}#${issueNumber}: ${
					error instanceof Error ? error.message : String(error)
				}\n`,
			);
			return [];
		}
	}

	private withLink(owner: string, repo: string, issueNumber: number, body: string): string {
		return appendAdminLink(body, this.adminIssueUrl(owner, repo, issueNumber));
	}
}

/**
 * Composes the message steered into an active execution: the triggering
 * feedback comment preceded by a delimited "Prior discussion" section when
 * prior context is available.
 */
export function composeSteerMessage(triggerBody: string, priorComments: PriorDiscussionComment[]): string {
	const section = formatPriorDiscussion(priorComments);
	if (section.length === 0) {
		return triggerBody;
	}
	return `${section}\n${triggerBody.trim()}`;
}

/**
 * Selects prior non-trigger comments to include as feedback context.
 *
 * A comment is included when it:
 * - is not the triggering comment itself (by id when available),
 * - was authored by someone other than the configured Yeetomatic account,
 * - does not itself trigger feedback (no mention of the configured account or
 *   `@yeetomatic`, and no `/yeetomatic feedback` command), and
 * - is older than the triggering comment (by `created_at`, falling back to
 *   comment `id` ordering when timestamps tie or are unavailable).
 *
 * Comments are returned in chronological order (by `created_at` then `id`).
 */
export function selectPriorContextComments(
	comments: IssueComment[],
	trigger: { id?: number; body: string; created_at?: string },
	githubUsername: string,
): PriorDiscussionComment[] {
	const triggerId = trigger.id;
	const triggerTs = parseTimestamp(trigger.created_at);

	const selected = comments.filter((comment) => {
		if (triggerId !== undefined && comment.id === triggerId) {
			return false;
		}
		if (comment.author === githubUsername) {
			return false;
		}
		if (commentTriggersFeedback(comment.body, githubUsername)) {
			return false;
		}
		return isOlderThan(comment, triggerId, triggerTs);
	});

	return selected
		.map((comment) => ({ author: comment.author, body: comment.body }));
}

function parseTimestamp(value: string | undefined): number {
	if (!value) return NaN;
	const ms = new Date(value).getTime();
	return Number.isFinite(ms) ? ms : NaN;
}

function isOlderThan(
	comment: IssueComment,
	triggerId: number | undefined,
	triggerTs: number,
): boolean {
	const commentTs = parseTimestamp(comment.created_at);
	if (!Number.isNaN(triggerTs) && !Number.isNaN(commentTs)) {
		if (commentTs !== triggerTs) {
			return commentTs < triggerTs;
		}
		// Timestamps tie: fall back to id ordering.
	}
	if (triggerId !== undefined) {
		return comment.id < triggerId;
	}
	// Cannot establish ordering relative to the trigger; exclude to be safe.
	return false;
}
