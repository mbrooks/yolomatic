import { sessionKey } from "../../domain/session/model.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { SessionState } from "../../session/store.js";
import { EmptyRepositoryError } from "../../workspace/errors.js";
import { isAdmin, shouldIgnoreIssueEvent, shouldIgnoreCommentEvent, isStopCommand } from "../../domain/workflow/policy.js";
import { extractIssueNumberFromBranch } from "../../pr-review/session-invariant.js";
import { appendAdminLink } from "./comment-links.js";
import type { PriorDiscussionComment } from "../../executor/index.js";
import type { PRReviewPayload } from "./handle-pr-review.js";

/**
 * Minimal event-payload shape required to resolve issue context. Matches the
 * structural subset of {@link IssueEventPayload} and {@link CommentEventPayload}
 * needed by {@link resolveIssueContext}.
 */
interface IssueContextPayload {
	repository: { name: string; owner: { login: string } };
	issue: { number: number };
}

export interface ResolvedIssueContext {
	owner: string;
	repo: string;
	issueNumber: number;
	key: string;
	defaultBranch: string;
}

/**
 * Extracts owner/repo/issue number and resolves the default branch for an
 * issue-scoped webhook payload. Centralizes the context resolution duplicated
 * by the issue and comment handlers.
 */
export function resolveIssueContext(
	payload: IssueContextPayload,
	resolveDefaultBranch?: (owner: string, repo: string) => string,
	defaultBranch?: string,
): ResolvedIssueContext {
	const owner = payload.repository.owner.login;
	const repo = payload.repository.name;
	const issueNumber = payload.issue.number;
	return {
		owner,
		repo,
		issueNumber,
		key: issueSessionKey(owner, repo, issueNumber),
		defaultBranch: resolveDefaultBranch?.(owner, repo) ?? defaultBranch ?? "main",
	};
}

/** Structural payload shape accepted by {@link guardEvent} for issue events. */
interface IssueGuardPayload {
	action: string;
	issue: {
		assignee?: { login: string } | null;
		assignees?: { login: string }[];
		labels?: Array<{ name?: string }>;
		user?: { login: string };
	};
	sender: { login: string };
}

/** Structural payload shape accepted by {@link guardEvent} for comment events. */
interface CommentGuardPayload {
	action: string;
	comment: { body: string; user: { login: string; type?: string } };
	issue: {
		state?: string;
		labels?: Array<{ name?: string }>;
		assignee?: { login: string } | null;
		assignees?: { login: string }[];
		user?: { login: string };
	};
}

export type GuardEventResult =
	| { skip: true; reason: string }
	| { skip: false; isMentioned?: boolean; isFeedbackCommand?: boolean; isCreatedByYolomatic?: boolean };

/**
 * Applies the existing policy helpers ({@link shouldIgnoreIssueEvent} /
 * {@link shouldIgnoreCommentEvent}) and returns either a skip reason or a
 * pass-through result. Replaces the inline sender/bot/assignment re-checks
 * previously duplicated by the webhook handlers.
 */
export function guardEvent(
	kind: "issues",
	payload: IssueGuardPayload,
	githubUsername: string,
	inFlight: boolean,
): GuardEventResult;
export function guardEvent(
	kind: "issue_comment",
	payload: CommentGuardPayload,
	githubUsername: string,
): GuardEventResult;
export function guardEvent(
	kind: "issues" | "issue_comment",
	payload: IssueGuardPayload | CommentGuardPayload,
	githubUsername: string,
	inFlight = false,
): GuardEventResult {
	if (kind === "issues") {
		const check = shouldIgnoreIssueEvent(payload as IssueGuardPayload, githubUsername, inFlight);
		if (check.ignore) {
			return { skip: true, reason: check.reason };
		}
		return { skip: false };
	}
	const check = shouldIgnoreCommentEvent(payload as CommentGuardPayload, githubUsername);
	if (check.ignore) {
		return { skip: true, reason: check.reason };
	}
	return { skip: false, isMentioned: check.isMentioned, isFeedbackCommand: check.isFeedbackCommand, isCreatedByYolomatic: check.isCreatedByYolomatic };
}

export type PrepareIssueSessionResult =
	| { skip: true; kind: "status"; status: string }
	| { skip: true; kind: "draining" }
	| { skip: false; session: SessionState };

/**
 * Ensures a session exists for the issue and applies the draining-mode guard.
 * When `requirePending` is set (issue events), a non-pending session short-
 * circuits before the draining check, preserving the original handler order.
 * Returns either a skip reason or the resolved session.
 */
export async function prepareIssueSession(
	deps: {
		sessions: SessionRepository;
		workspaces: WorkspaceService;
		github: GitHubService;
		tasks: TaskControlService;
	},
	ctx: {
		owner: string;
		repo: string;
		issueNumber: number;
		title: string;
		body: string;
		labels: string[] | undefined;
		defaultBranch: string;
	},
	options: { requirePending?: boolean; commentBodies?: string[] } = {},
): Promise<PrepareIssueSessionResult> {
	const refinement = await deps.sessions.get(ctx.owner, ctx.repo, ctx.issueNumber, "refinement");
	if (refinement?.kind === "refinement" && refinement.status === "working") {
		return { skip: true, kind: "status", status: refinement.status };
	}

	const session = await ensureSessionExists(
		deps.sessions,
		deps.workspaces,
		deps.github,
		ctx.owner,
		ctx.repo,
		ctx.issueNumber,
		ctx.title,
		ctx.body,
		ctx.labels,
		ctx.defaultBranch,
	);

	if (options.requirePending && session.status !== "pending") {
		return { skip: true, kind: "status", status: session.status };
	}

	if (await handleDrainingMode(deps.tasks, deps.sessions, deps.github, session, options.commentBodies)) {
		return { skip: true, kind: "draining" };
	}

	return { skip: false, session };
}

/** Structural payload shape accepted by {@link routePRTimelineComment}. */
interface PRTimelineCommentPayload {
	action: string;
	issue: {
		number: number;
		pull_request?: { url: string };
	};
	comment: { id?: number; body: string; user: { login: string; type?: string } };
	repository: { name: string; owner: { login: string } };
	sender: { login: string };
}

/**
 * Routes PR timeline comments to the PR review handler (or admin stop command).
 * Returns `true` when the payload was a PR timeline comment that has been
 * fully handled (the caller should return immediately); `false` when the
 * payload is not a PR timeline comment and the caller should continue.
 */
export async function routePRTimelineComment(
	deps: {
		github: GitHubService;
		sessions: SessionRepository;
		tasks: TaskControlService;
		adminGithubUsername?: string;
		prReview?: { execute: (payload: PRReviewPayload) => Promise<void> } | undefined;
	},
	payload: PRTimelineCommentPayload,
	owner: string,
	repo: string,
	issueNumber: number,
): Promise<boolean> {
	if (!payload.issue.pull_request) {
		return false;
	}

	const pr = await deps.github.getPullRequest(owner, repo, issueNumber);
	if (!pr) {
		process.stdout.write(`[webhook] issue_comment ignored for ${repo}#${issueNumber}: could not fetch PR\n`);
		return true;
	}
	const branchIssueNumber = extractIssueNumberFromBranch(pr.head.ref);
	const mappedSession = branchIssueNumber ? null : await deps.sessions.findSessionByPR(owner, repo, issueNumber);
	const mappedIssueNumber = branchIssueNumber ?? mappedSession?.issueNumber;
	if (!mappedIssueNumber) {
		process.stdout.write(
			`[webhook] issue_comment ignored for ${owner}/${repo}#${issueNumber}: PR branch ${pr.head.ref} is not associated with a Yolomatic session\n`,
		);
		return true;
	}

	if (isStopCommand(payload.comment.body)) {
		await handleAdminStop(
			deps.github,
			deps.tasks,
			deps.sessions,
			payload.sender.login,
			deps.adminGithubUsername,
			owner,
			repo,
			mappedIssueNumber,
			issueNumber,
		);
		return true;
	}

	if (deps.prReview) {
		await deps.prReview.execute({
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
	return true;
}

export function issueSessionKey(owner: string, repo: string, issueNumber: number): string {
	return sessionKey(owner, repo, issueNumber);
}

export async function removeWorkflowLabels(
	github: GitHubService,
	owner: string,
	repo: string,
	issueNumber: number,
): Promise<void> {
	await github.removeLabel(owner, repo, issueNumber, "yolomatic-working");
	await github.removeLabel(owner, repo, issueNumber, "yolomatic-feedback-required");
	await github.removeLabel(owner, repo, issueNumber, "yolomatic-pr-created");
	await github.removeLabel(owner, repo, issueNumber, "yolomatic-complete");
}

export async function markIssueWorking(
	github: GitHubService,
	owner: string,
	repo: string,
	issueNumber: number,
	message?: string,
	adminIssueUrl?: string,
): Promise<void> {
	await removeWorkflowLabels(github, owner, repo, issueNumber);
	await github.addLabels(owner, repo, issueNumber, ["yolomatic-working"]);
	if (message) {
		await github.postComment(owner, repo, issueNumber, appendAdminLink(message, adminIssueUrl));
	}
}

export async function stopSessionByAdmin(
	sessions: SessionRepository,
	github: GitHubService,
	tasks: TaskControlService,
	owner: string,
	repo: string,
	sessionIssueNumber: number,
	commentIssueNumber = sessionIssueNumber,
): Promise<"stopping" | "cancelled" | "idle"> {
	const key = issueSessionKey(owner, repo, sessionIssueNumber);
	if (tasks.cancel(key)) {
		await github.postComment(owner, repo, commentIssueNumber, "Stopping Yolomatic...");
		return "stopping";
	}

	const session = await sessions.get(owner, repo, sessionIssueNumber, "implementation");
	if (session?.status === "working") {
		await sessions.cancelSession(owner, repo, sessionIssueNumber);
		await github.removeLabel(owner, repo, sessionIssueNumber, "yolomatic-working");
		await github.addLabels(owner, repo, sessionIssueNumber, ["yolomatic-cancelled"]);
		await github.postComment(owner, repo, commentIssueNumber, "Task cancelled by admin. Yolomatic is idle.");
		return "cancelled";
	}

	await github.postComment(owner, repo, commentIssueNumber, "Yolomatic is not currently working on this issue.");
	return "idle";
}

export async function queueResumeOnBoot(
	sessions: SessionRepository,
	session: SessionState,
	commentBodies: string[],
): Promise<void> {
	const queued = [...(session.queuedComments ?? []), ...commentBodies];
	await sessions.updateStatus(session.owner, session.repo, session.issueNumber, session.status, {
		resumeOnBoot: true,
		queuedComments: queued,
	}, session.kind ?? "implementation");
}

export async function ensureSessionExists(
	sessions: SessionRepository,
	workspaces: WorkspaceService,
	github: GitHubService,
	owner: string,
	repo: string,
	issueNumber: number,
	title: string,
	body: string,
	labels: string[] | undefined,
	defaultBranch: string,
): Promise<SessionState> {
	let session = await sessions.get(owner, repo, issueNumber, "implementation");
	if (session) {
		return session;
	}

	let worktree: { path: string; branch: string };
	try {
		worktree = await workspaces.createOrGetWorktree(owner, repo, issueNumber);
	} catch (error) {
		if (error instanceof EmptyRepositoryError) {
			await github.initializeEmptyRepo(owner, repo, defaultBranch);
			worktree = await workspaces.createOrGetWorktree(owner, repo, issueNumber);
		} else {
			throw error;
		}
	}

	session = await sessions.createSession(
		owner,
		repo,
		issueNumber,
		title,
		body,
		worktree.path,
		"implementation",
		labels ?? [],
	);
	return session;
}

export async function handleDrainingMode(
	tasks: TaskControlService,
	sessions: SessionRepository,
	github: GitHubService,
	session: SessionState,
	commentBodies?: string[],
): Promise<boolean> {
	if (!tasks.isDraining()) {
		return false;
	}

	if (commentBodies && commentBodies.length > 0) {
		await queueResumeOnBoot(sessions, session, commentBodies);
		await github.postComment(
			session.owner,
			session.repo,
			session.issueNumber,
			"Deploy in progress. Feedback will be processed after restart.",
		);
	} else {
		await sessions.updateStatus(session.owner, session.repo, session.issueNumber, "pending", {
			resumeOnBoot: true,
		}, session.kind ?? "implementation");
		await github.postComment(
			session.owner,
			session.repo,
			session.issueNumber,
			"Deploy in progress. Task will resume after restart.",
		);
	}

	return true;
}

export async function startIssueExecution(
	executor: { run: (session: SessionState, commentBody?: string, priorComments?: PriorDiscussionComment[]) => Promise<void> },
	github: GitHubService,
	owner: string,
	repo: string,
	issueNumber: number,
	session: SessionState,
	message: string,
	commentBody?: string,
	adminIssueUrl?: string,
	priorComments?: PriorDiscussionComment[],
): Promise<void> {
	await markIssueWorking(github, owner, repo, issueNumber, message, adminIssueUrl);
	await executor.run(session, commentBody, priorComments);
}

export async function handleAdminStop(
	github: GitHubService,
	tasks: TaskControlService,
	sessions: SessionRepository,
	senderLogin: string,
	adminGithubUsername: string | undefined,
	owner: string,
	repo: string,
	sessionIssueNumber: number,
	commentIssueNumber: number,
): Promise<"not-admin" | "stopping" | "cancelled" | "idle"> {
	if (!isAdmin(senderLogin, adminGithubUsername)) {
		await github.postComment(owner, repo, commentIssueNumber, "Only admins can stop Yolomatic.");
		return "not-admin";
	}
	return stopSessionByAdmin(sessions, github, tasks, owner, repo, sessionIssueNumber, commentIssueNumber);
}
