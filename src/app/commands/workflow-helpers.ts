import { sessionKey } from "../../domain/session/model.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { SessionState } from "../../session/store.js";
import { EmptyRepositoryError } from "../../workspace/errors.js";
import { isAdmin } from "../../domain/workflow/policy.js";

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
	let session = await sessions.get(owner, repo, issueNumber);
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
		});
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
	executor: { run: (session: SessionState, commentBody?: string) => Promise<void> },
	github: GitHubService,
	owner: string,
	repo: string,
	issueNumber: number,
	session: SessionState,
	message: string,
	commentBody?: string,
): Promise<void> {
	await markIssueWorking(github, owner, repo, issueNumber, message);
	await executor.run(session, commentBody);
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
		await github.postComment(owner, repo, commentIssueNumber, "Only admins can stop TARS.");
		return "not-admin";
	}
	return stopSessionByAdmin(sessions, github, tasks, owner, repo, sessionIssueNumber, commentIssueNumber);
}
