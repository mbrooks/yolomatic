import type { HandleIssueEvent } from "../app/commands/handle-issue-event.js";
import type { HandleIssueComment } from "../app/commands/handle-issue-comment.js";
import type { HandlePRReview } from "../app/commands/handle-pr-review.js";
import type { GitHubEvent, GitHubEventStateStore, GitHubPollSubject, GitHubPollSubjectType } from "./model.js";

export interface GitHubEventDispatcherDeps {
	handleIssueEvent: HandleIssueEvent;
	handleIssueComment: HandleIssueComment;
	handlePRReview: HandlePRReview;
	eventStore?: GitHubEventStateStore;
	githubUsername?: string;
}

export class GitHubEventDispatcher {
	constructor(private readonly deps: GitHubEventDispatcherDeps) {}

	async dispatch(event: GitHubEvent): Promise<void> {
		if (this.deps.eventStore?.hasSeen(event.id)) {
			process.stdout.write(`[github-event] duplicate ignored id=${event.id}\n`);
			return;
		}

		switch (event.type) {
			case "issue":
				await this.deps.handleIssueEvent.execute(event.payload);
				break;
			case "issue_comment":
				await this.deps.handleIssueComment.execute(event.payload);
				break;
			case "pull_request_review":
			case "pull_request_review_comment":
				await this.deps.handlePRReview.execute(event.payload);
				break;
			case "pull_request":
				process.stdout.write(
					`[github-event] pull_request.${event.payload.action} repo=${event.owner}/${event.repo} pr=#${event.payload.pull_request.number}\n`,
				);
				break;
		}

		this.deps.eventStore?.markSeen(event);
		this.deps.eventStore?.updateLastEventReceivedAt(new Date().toISOString());
		const subject = pollingSubjectFromEvent(event, this.deps.githubUsername);
		if (subject) {
			this.deps.eventStore?.upsertPollingSubject?.(subject);
		}
	}
}

function pollingSubjectKey(owner: string, repo: string, subjectType: GitHubPollSubjectType, number: number): string {
	return `${owner}/${repo}:${subjectType}:${number}`;
}

function isAssignedTo(login: string | undefined, issue: { assignee?: { login: string } | null; assignees?: { login: string }[] }): boolean {
	if (!login) return true;
	if (issue.assignees?.some((assignee) => assignee.login === login)) return true;
	return issue.assignee?.login === login;
}

export function pollingSubjectFromEvent(event: GitHubEvent, githubUsername?: string): GitHubPollSubject | null {
	const createdAt = event.occurredAt;
	if (event.type === "issue") {
		if (!isAssignedTo(githubUsername, event.payload.issue)) return null;
		return {
			subjectKey: pollingSubjectKey(event.owner, event.repo, "issue", event.payload.issue.number),
			owner: event.owner,
			repo: event.repo,
			subjectType: "issue",
			number: event.payload.issue.number,
			lastActivityAt: event.occurredAt,
			lastCheckedAt: null,
			createdAt,
		};
	}
	if (event.type === "issue_comment" && !event.payload.issue.pull_request) {
		if (!isAssignedTo(githubUsername, event.payload.issue)) return null;
		return {
			subjectKey: pollingSubjectKey(event.owner, event.repo, "issue", event.payload.issue.number),
			owner: event.owner,
			repo: event.repo,
			subjectType: "issue",
			number: event.payload.issue.number,
			lastActivityAt: event.occurredAt,
			lastCheckedAt: null,
			createdAt,
		};
	}
	if (event.type === "pull_request") {
		return {
			subjectKey: pollingSubjectKey(event.owner, event.repo, "pull_request", event.payload.pull_request.number),
			owner: event.owner,
			repo: event.repo,
			subjectType: "pull_request",
			number: event.payload.pull_request.number,
			lastActivityAt: event.occurredAt,
			lastCheckedAt: null,
			createdAt,
		};
	}
	if (event.type === "pull_request_review" || event.type === "pull_request_review_comment") {
		return {
			subjectKey: pollingSubjectKey(event.owner, event.repo, "pull_request", event.payload.pull_request.number),
			owner: event.owner,
			repo: event.repo,
			subjectType: "pull_request",
			number: event.payload.pull_request.number,
			lastActivityAt: event.occurredAt,
			lastCheckedAt: null,
			createdAt,
		};
	}
	return null;
}
