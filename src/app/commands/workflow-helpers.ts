import { sessionKey } from "../../domain/session/model.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { SessionState } from "../../session/store.js";

export function issueSessionKey(owner: string, repo: string, issueNumber: number): string {
	return sessionKey(owner, repo, issueNumber);
}

export async function removeWorkflowLabels(
	github: GitHubService,
	owner: string,
	repo: string,
	issueNumber: number,
): Promise<void> {
	await github.removeLabel(owner, repo, issueNumber, "tars-working");
	await github.removeLabel(owner, repo, issueNumber, "tars-feedback-required");
	await github.removeLabel(owner, repo, issueNumber, "tars-pr-created");
	await github.removeLabel(owner, repo, issueNumber, "tars-complete");
}

export async function markIssueWorking(
	github: GitHubService,
	owner: string,
	repo: string,
	issueNumber: number,
	message?: string,
): Promise<void> {
	await removeWorkflowLabels(github, owner, repo, issueNumber);
	await github.addLabels(owner, repo, issueNumber, ["tars-working"]);
	if (message) {
		await github.postComment(owner, repo, issueNumber, message);
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
		await github.postComment(owner, repo, commentIssueNumber, "Stopping TARS...");
		return "stopping";
	}

	const session = await sessions.get(owner, repo, sessionIssueNumber);
	if (session?.status === "working") {
		await sessions.cancelSession(owner, repo, sessionIssueNumber);
		await github.removeLabel(owner, repo, sessionIssueNumber, "tars-working");
		await github.addLabels(owner, repo, sessionIssueNumber, ["tars-cancelled"]);
		await github.postComment(owner, repo, commentIssueNumber, "Task cancelled by admin. TARS is idle.");
		return "cancelled";
	}

	await github.postComment(owner, repo, commentIssueNumber, "TARS is not currently working on this issue.");
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
	});
}
