import type {
	GitHubPollingService,
	PollIssue,
	PollIssueComment,
	PollIssueEvent,
	PollPRReview,
	PollPRReviewComment,
	PollPullRequest,
} from "../ports/github-polling-service.js";
import type { GitHubEvent, GitHubEventStateStore, GitHubPollSubject } from "./model.js";

const POLL_OVERLAP_MS = 2 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const THREE_DAYS_MS = 72 * 60 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface GitHubPollingDeps {
	github: GitHubPollingService;
	dispatch(event: GitHubEvent): Promise<void>;
	eventStore: GitHubEventStateStore;
	githubUsername: string;
	intervalMs: number;
	shouldPollRepo?: (owner: string, repo: string) => boolean;
	now?: () => Date;
}

let pollIntervalId: NodeJS.Timeout | undefined;
let pollRunning = false;

function repoPayload(owner: string, repo: string) {
	return { name: repo, owner: { login: owner } };
}

function issueActionFor(issue: PollIssue, since: string): string {
	return Date.parse(issue.created_at) >= Date.parse(since) ? "opened" : "edited";
}

function senderFrom(login: string | undefined) {
	return { login: login || "unknown" };
}

export function pollingSubjectCheckIntervalMs(
	subject: Pick<GitHubPollSubject, "lastActivityAt">,
	now: Date,
	defaultIntervalMs: number,
): number {
	const idleMs = Math.max(0, now.getTime() - Date.parse(subject.lastActivityAt));
	if (idleMs >= THREE_DAYS_MS) return ONE_HOUR_MS;
	if (idleMs >= ONE_DAY_MS) return FIFTEEN_MINUTES_MS;
	return defaultIntervalMs;
}

export function isPollingSubjectDue(subject: GitHubPollSubject, now: Date, defaultIntervalMs: number): boolean {
	if (!subject.lastCheckedAt) return true;
	const intervalMs = pollingSubjectCheckIntervalMs(subject, now, defaultIntervalMs);
	return now.getTime() - Date.parse(subject.lastCheckedAt) >= intervalMs;
}

export function normalizePolledIssue(owner: string, repo: string, issue: PollIssue, since: string): GitHubEvent {
	const action = issueActionFor(issue, since);
	return {
		id: `github:issue:${owner}/${repo}#${issue.number}:${action}:${issue.updated_at}`,
		type: "issue",
		source: "polling",
		owner,
		repo,
		occurredAt: issue.updated_at,
		payload: {
			action,
			issue: {
				number: issue.number,
				title: issue.title,
				body: issue.body,
				labels: issue.labels,
				assignee: issue.assignee,
				assignees: issue.assignees,
				user: issue.user,
			},
			repository: repoPayload(owner, repo),
			sender: senderFrom(issue.user?.login),
		},
	};
}

export function normalizePolledIssueTimelineEvent(owner: string, repo: string, event: PollIssueEvent): GitHubEvent | null {
	if (event.event !== "assigned" && event.event !== "unassigned") return null;
	return {
		id: `github:issue_event:${event.id}:${event.event}`,
		type: "issue",
		source: "polling",
		owner,
		repo,
		occurredAt: event.created_at,
		payload: {
			action: event.event,
			issue: {
				number: event.issue.number,
				title: event.issue.title,
				body: event.issue.body,
				labels: event.issue.labels,
				assignee: event.issue.assignee,
				assignees: event.issue.assignees,
				user: event.issue.user,
			},
			repository: repoPayload(owner, repo),
			sender: senderFrom(event.actor?.login),
		},
	};
}

export function normalizePolledIssueComment(owner: string, repo: string, comment: PollIssueComment): GitHubEvent {
	return {
		id: `github:issue_comment:${comment.id}`,
		type: "issue_comment",
		source: "polling",
		owner,
		repo,
		occurredAt: comment.updated_at,
		payload: {
			action: "created",
			issue: {
				number: comment.issue.number,
				title: comment.issue.title,
				body: comment.issue.body,
				pull_request: comment.issue.pull_request,
				labels: comment.issue.labels,
				assignee: comment.issue.assignee,
				assignees: comment.issue.assignees,
				user: comment.issue.user,
			},
			comment: {
				id: comment.id,
				body: comment.body,
				user: comment.user,
			},
			repository: repoPayload(owner, repo),
			sender: senderFrom(comment.user.login),
		},
	};
}

export function normalizePolledPullRequest(owner: string, repo: string, pr: PollPullRequest, since: string): GitHubEvent {
	const action = Date.parse(pr.created_at) >= Date.parse(since) ? "opened" : "synchronize";
	return {
		id: `github:pull_request:${owner}/${repo}#${pr.number}:${action}:${pr.updated_at}`,
		type: "pull_request",
		source: "polling",
		owner,
		repo,
		occurredAt: pr.updated_at,
		payload: {
			action,
			pull_request: {
				number: pr.number,
				head: pr.head,
				state: pr.state,
				merged: pr.merged,
				title: pr.title,
				body: pr.body,
			},
			repository: repoPayload(owner, repo),
			sender: senderFrom(pr.user?.login),
		},
	};
}

export function normalizePolledPRReview(owner: string, repo: string, review: PollPRReview): GitHubEvent {
	return {
		id: `github:pull_request_review:${review.id}`,
		type: "pull_request_review",
		source: "polling",
		owner,
		repo,
		occurredAt: review.submitted_at,
		payload: {
			action: "submitted",
			pull_request: {
				number: review.pull_request.number,
				head: review.pull_request.head,
				state: review.pull_request.state,
				merged: review.pull_request.merged,
			},
			repository: repoPayload(owner, repo),
			sender: senderFrom(review.user.login),
			review: {
				id: review.id,
				body: review.body,
				state: review.state,
				user: review.user,
			},
		},
	};
}

export function normalizePolledPRReviewComment(owner: string, repo: string, comment: PollPRReviewComment): GitHubEvent {
	return {
		id: `github:pull_request_review_comment:${comment.id}`,
		type: "pull_request_review_comment",
		source: "polling",
		owner,
		repo,
		occurredAt: comment.updated_at,
		payload: {
			action: "created",
			pull_request: {
				number: comment.pull_request.number,
				head: comment.pull_request.head,
				state: comment.pull_request.state,
				merged: comment.pull_request.merged,
			},
			repository: repoPayload(owner, repo),
			sender: senderFrom(comment.user.login),
			comment: {
				id: comment.id,
				body: comment.body,
				user: comment.user,
				path: comment.path,
				line: comment.line,
			},
		},
	};
}

export async function tickGitHubPolling(deps: GitHubPollingDeps): Promise<void> {
	const now = deps.now?.() ?? new Date();
	const lastReceivedAt = deps.eventStore.getLastEventReceivedAt();
	if (!lastReceivedAt) {
		deps.eventStore.initializeLastEventReceivedAt(now.toISOString());
		process.stdout.write(`[github-poll] initialized last_event_received_at=${now.toISOString()}\n`);
		return;
	}

	const since = new Date(Math.max(0, Date.parse(lastReceivedAt) - POLL_OVERLAP_MS)).toISOString();
	const repos = await deps.github.listAccessibleRepositories();
	const events: GitHubEvent[] = [];

	for (const repo of repos) {
		if (deps.shouldPollRepo && !deps.shouldPollRepo(repo.owner, repo.repo)) {
			continue;
		}
		try {
			const [issues, issueEvents, comments, prs, reviews, reviewComments] = await Promise.all([
				deps.github.listIssuesUpdatedSince(repo.owner, repo.repo, since),
				deps.github.listIssueEventsSince(repo.owner, repo.repo, since),
				deps.github.listIssueCommentsSince(repo.owner, repo.repo, since),
				deps.github.listPullRequestsUpdatedSince(repo.owner, repo.repo, since),
				deps.github.listPRReviewsSince(repo.owner, repo.repo, since),
				deps.github.listPRReviewCommentsSince(repo.owner, repo.repo, since),
			]);
			events.push(
				...issues.filter((issue) => !issue.pull_request).map((issue) => normalizePolledIssue(repo.owner, repo.repo, issue, since)),
				...issueEvents
					.map((event) => normalizePolledIssueTimelineEvent(repo.owner, repo.repo, event))
					.filter((event): event is GitHubEvent => event !== null),
				...comments.map((comment) => normalizePolledIssueComment(repo.owner, repo.repo, comment)),
				...prs.map((pr) => normalizePolledPullRequest(repo.owner, repo.repo, pr, since)),
				...reviews.map((review) => normalizePolledPRReview(repo.owner, repo.repo, review)),
				...reviewComments.map((comment) => normalizePolledPRReviewComment(repo.owner, repo.repo, comment)),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[github-poll] failed ${repo.owner}/${repo.repo}: ${message}\n`);
		}
	}

	events.push(...await collectDueSubjectEvents(deps, now));
	events.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
	for (const event of events) {
		await deps.dispatch(event);
	}
}

async function collectDueSubjectEvents(deps: GitHubPollingDeps, now: Date): Promise<GitHubEvent[]> {
	const subjects = deps.eventStore.listPollingSubjects?.() ?? [];
	const dueSubjects = subjects.filter((subject) => isPollingSubjectDue(subject, now, deps.intervalMs));
	const events: GitHubEvent[] = [];

	for (const subject of dueSubjects) {
		try {
			const since = new Date(Math.max(0, Date.parse(subject.lastActivityAt) - POLL_OVERLAP_MS)).toISOString();
			if (subject.subjectType === "issue") {
				const [issues, issueEvents, comments] = await Promise.all([
					deps.github.listIssuesUpdatedSince(subject.owner, subject.repo, since),
					deps.github.listIssueEventsSince(subject.owner, subject.repo, since),
					deps.github.listIssueCommentsSince(subject.owner, subject.repo, since),
				]);
				events.push(
					...issues
						.filter((issue) => !issue.pull_request && issue.number === subject.number)
						.map((issue) => normalizePolledIssue(subject.owner, subject.repo, issue, since)),
					...issueEvents
						.filter((event) => event.issue.number === subject.number)
						.map((event) => normalizePolledIssueTimelineEvent(subject.owner, subject.repo, event))
						.filter((event): event is GitHubEvent => event !== null),
					...comments
						.filter((comment) => comment.issue.number === subject.number && !comment.issue.pull_request)
						.map((comment) => normalizePolledIssueComment(subject.owner, subject.repo, comment)),
				);
			} else {
				const [prs, reviews, reviewComments] = await Promise.all([
					deps.github.listPullRequestsUpdatedSince(subject.owner, subject.repo, since),
					deps.github.listPRReviewsSince(subject.owner, subject.repo, since),
					deps.github.listPRReviewCommentsSince(subject.owner, subject.repo, since),
				]);
				events.push(
					...prs
						.filter((pr) => pr.number === subject.number)
						.map((pr) => normalizePolledPullRequest(subject.owner, subject.repo, pr, since)),
					...reviews
						.filter((review) => review.pull_request.number === subject.number)
						.map((review) => normalizePolledPRReview(subject.owner, subject.repo, review)),
					...reviewComments
						.filter((comment) => comment.pull_request.number === subject.number)
						.map((comment) => normalizePolledPRReviewComment(subject.owner, subject.repo, comment)),
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[github-poll] failed subject ${subject.subjectKey}: ${message}\n`);
		} finally {
			deps.eventStore.markPollingSubjectChecked?.(subject.subjectKey, now.toISOString());
		}
	}

	return events;
}

export function startGitHubPolling(deps: GitHubPollingDeps): void {
	process.stdout.write(`[github-poll] Starting GitHub polling (interval=${deps.intervalMs}ms)\n`);
	pollIntervalId = setInterval(() => {
		if (pollRunning) return;
		pollRunning = true;
		void tickGitHubPolling(deps).finally(() => {
			pollRunning = false;
		});
	}, deps.intervalMs);
	pollIntervalId.unref?.();
}

export function stopGitHubPolling(): void {
	if (pollIntervalId) {
		clearInterval(pollIntervalId);
		pollIntervalId = undefined;
	}
}
