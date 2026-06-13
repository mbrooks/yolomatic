import type { HandleIssueEvent, IssueEventPayload } from "../../app/commands/handle-issue-event.js";
import type { HandleIssueComment, CommentEventPayload } from "../../app/commands/handle-issue-comment.js";
import type { HandlePRReview, PRReviewPayload } from "../../app/commands/handle-pr-review.js";
import type { GitHubEvent } from "../../github-events/model.js";

export interface WebhookAdapterDeps {
	handleIssueEvent: HandleIssueEvent;
	handleIssueComment: HandleIssueComment;
	handlePRReview: HandlePRReview;
}

export async function dispatchWebhookEvent(
	event: string | undefined,
	payload: unknown,
	deps: WebhookAdapterDeps,
): Promise<void> {
	switch (event) {
		case "issues":
			await deps.handleIssueEvent.execute(payload as IssueEventPayload);
			break;
		case "issue_comment":
			await deps.handleIssueComment.execute(payload as CommentEventPayload);
			break;
		case "pull_request_review_comment":
		case "pull_request_review":
			await deps.handlePRReview.execute(payload as PRReviewPayload);
			break;
		default:
			process.stdout.write(`[webhook] ignored unsupported event=${event ?? "unknown"}\n`);
	}
}

function repoFromPayload(payload: {
	repository?: { name?: string; owner?: { login?: string } };
}): { owner: string; repo: string } {
	return {
		owner: payload.repository?.owner?.login ?? "unknown",
		repo: payload.repository?.name ?? "unknown",
	};
}

function eventTime(payload: { comment?: { created_at?: string; updated_at?: string }; review?: { submitted_at?: string }; issue?: { updated_at?: string; created_at?: string }; pull_request?: { updated_at?: string; created_at?: string } }): string {
	return (
		payload.comment?.updated_at ??
		payload.comment?.created_at ??
		payload.review?.submitted_at ??
		payload.issue?.updated_at ??
		payload.issue?.created_at ??
		payload.pull_request?.updated_at ??
		payload.pull_request?.created_at ??
		new Date().toISOString()
	);
}

export function normalizeWebhookEvent(event: string | undefined, rawPayload: unknown, delivery = "unknown"): GitHubEvent[] {
	const payload = rawPayload as Record<string, any>;
	const { owner, repo } = repoFromPayload(payload);
	const occurredAt = eventTime(payload);

	switch (event) {
		case "issues":
			return [{
				id: `webhook:${delivery}:issues:${payload.action}:${owner}/${repo}#${payload.issue?.number ?? "unknown"}:${occurredAt}`,
				type: "issue",
				source: "webhook",
				owner,
				repo,
				occurredAt,
				payload: payload as IssueEventPayload,
			}];
		case "issue_comment":
			return [{
				id: `github:issue_comment:${payload.comment?.id ?? `${delivery}:${occurredAt}`}`,
				type: "issue_comment",
				source: "webhook",
				owner,
				repo,
				occurredAt,
				payload: payload as CommentEventPayload,
			}];
		case "pull_request_review_comment":
			return [{
				id: `github:pull_request_review_comment:${payload.comment?.id ?? `${delivery}:${occurredAt}`}`,
				type: "pull_request_review_comment",
				source: "webhook",
				owner,
				repo,
				occurredAt,
				payload: payload as PRReviewPayload,
			}];
		case "pull_request_review":
			return [{
				id: `github:pull_request_review:${payload.review?.id ?? `${delivery}:${occurredAt}`}:${payload.action ?? "unknown"}`,
				type: "pull_request_review",
				source: "webhook",
				owner,
				repo,
				occurredAt,
				payload: payload as PRReviewPayload,
			}];
		case "pull_request":
			return [{
				id: `github:pull_request:${owner}/${repo}#${payload.pull_request?.number ?? "unknown"}:${payload.action ?? "unknown"}:${occurredAt}`,
				type: "pull_request",
				source: "webhook",
				owner,
				repo,
				occurredAt,
				payload: payload as GitHubEvent & any,
			} as GitHubEvent];
		default:
			return [];
	}
}
