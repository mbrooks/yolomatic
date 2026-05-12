import type { HandleIssueEvent, IssueEventPayload } from "../../app/commands/handle-issue-event.js";
import type { HandleIssueComment, CommentEventPayload } from "../../app/commands/handle-issue-comment.js";
import type { HandlePRReview, PRReviewPayload } from "../../app/commands/handle-pr-review.js";

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
