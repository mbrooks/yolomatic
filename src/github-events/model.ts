import type { IssueEventPayload } from "../app/commands/handle-issue-event.js";
import type { CommentEventPayload } from "../app/commands/handle-issue-comment.js";
import type { PRReviewPayload } from "../app/commands/handle-pr-review.js";

export type GitHubEventSource = "webhook" | "polling";

export type GitHubEvent =
	| {
			id: string;
			type: "issue";
			source: GitHubEventSource;
			owner: string;
			repo: string;
			occurredAt: string;
			payload: IssueEventPayload;
	  }
	| {
			id: string;
			type: "issue_comment";
			source: GitHubEventSource;
			owner: string;
			repo: string;
			occurredAt: string;
			payload: CommentEventPayload;
	  }
	| {
			id: string;
			type: "pull_request_review" | "pull_request_review_comment";
			source: GitHubEventSource;
			owner: string;
			repo: string;
			occurredAt: string;
			payload: PRReviewPayload;
	  }
	| {
			id: string;
			type: "pull_request";
			source: GitHubEventSource;
			owner: string;
			repo: string;
			occurredAt: string;
			payload: {
				action: string;
				pull_request: {
					number: number;
					head: { ref: string };
					state: string;
					merged: boolean;
					title?: string;
					body?: string | null;
				};
				repository: { name: string; owner: { login: string } };
				sender: { login: string };
			};
	  };

export interface GitHubEventStateStore {
	getLastEventReceivedAt(): string | null;
	initializeLastEventReceivedAt(value: string): void;
	updateLastEventReceivedAt(value: string): void;
	hasSeen(eventId: string): boolean;
	markSeen(event: GitHubEvent): void;
	upsertPollingSubject?(subject: GitHubPollSubject): void;
	listPollingSubjects?(): GitHubPollSubject[];
	markPollingSubjectChecked?(subjectKey: string, checkedAt: string): void;
}

export type GitHubPollSubjectType = "issue" | "pull_request";

export interface GitHubPollSubject {
	subjectKey: string;
	owner: string;
	repo: string;
	subjectType: GitHubPollSubjectType;
	number: number;
	lastActivityAt: string;
	lastCheckedAt: string | null;
	createdAt: string;
}
