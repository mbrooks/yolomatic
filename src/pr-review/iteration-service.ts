import type { PiAgentExecutor } from "../executor/index.js";
import { GitHubClient, type ReviewCommentSnapshot } from "../github/client.js";
import { SessionWorkflow } from "../session/workflow.js";
import type { TaskController } from "../task-controller.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { generateCommitMessage } from "../workspace/manager.js";
import { classifyComments } from "./classifier.js";
import { extractIssueNumberFromBranch, validatePRSessionMapping } from "./session-invariant.js";

export interface PullRequestPayload {
	action: string;
	pull_request: {
		number: number;
		head: {
			ref: string;
		};
		state: string;
		merged: boolean;
	};
	repository: {
		name: string;
		owner: {
			login: string;
		};
	};
	sender: {
		login: string;
	};
	comment?: {
		id: number;
		body: string;
		user: {
			login: string;
		};
		path?: string;
		line?: number | null;
	};
	review?: {
		id: number;
		body: string | null;
		state: string;
		user: {
			login: string;
		};
	};
}

export class PRReviewIterationService {
	private readonly inFlight = new Set<string>();

	public constructor(
		private readonly deps: {
			workflow: SessionWorkflow;
			workspaceManager: WorkspaceManager;
			executor: PiAgentExecutor;
			github: GitHubClient;
			githubUsername: string;
			maxIterations: number;
			taskController?: TaskController;
		},
	) {}

	async handlePullRequestReviewCommentEvent(payload: PullRequestPayload): Promise<void> {
		await this.processPREvent(payload, "pull_request_review_comment");
	}

	async handlePullRequestReviewEvent(payload: PullRequestPayload): Promise<void> {
		if (payload.action !== "submitted" && payload.action !== "edited") {
			process.stdout.write(`[webhook] pull_request_review action ignored: ${payload.action}\n`);
			return;
		}
		await this.processPREvent(payload, "pull_request_review");
	}

	private async processPREvent(payload: PullRequestPayload, eventType: string): Promise<void> {
		const owner = payload.repository.owner.login;
		const repo = payload.repository.name;
		const prNumber = payload.pull_request.number;
		const branch = payload.pull_request.head.ref;

		if (payload.sender.login === this.deps.githubUsername) {
			process.stdout.write(`[webhook] ${eventType} ignored: event from ${this.deps.githubUsername}\n`);
			return;
		}

		if (payload.pull_request.state !== "open") {
			process.stdout.write(`[webhook] ${eventType} ignored: PR #${prNumber} is not open\n`);
			return;
		}

		if (payload.pull_request.merged) {
			process.stdout.write(`[webhook] ${eventType} ignored: PR #${prNumber} is already merged\n`);
			return;
		}

		const resolvedSession = await this.resolveSessionForPullRequest(owner, repo, prNumber, branch);
		if (!resolvedSession) {
			process.stdout.write(`[webhook] ${eventType} ignored: branch ${branch} is not associated with a TARS session\n`);
			return;
		}

		const { issueNumber, session, branchIssueNumber } = resolvedSession;
		const inFlightKey = `${owner}/${repo}#${issueNumber}`;
		if (this.inFlight.has(inFlightKey)) {
			process.stdout.write(`[webhook] ${eventType} ignored: ${inFlightKey} is already being processed\n`);
			return;
		}

		if (!session) {
			process.stdout.write(`[webhook] ${eventType} ignored: no session for ${inFlightKey}\n`);
			const canonicalNote = branchIssueNumber
				? (await this.deps.workflow.findSessionByPR(owner, repo, prNumber))
					? ` Stored PR mapping points to ${owner}/${repo}#${issueNumber}; refusing to guess.`
					: ""
				: "";
			await this.deps.github.createComment(
				owner,
				repo,
				prNumber,
				[
					"**TARS stopped.**",
					"",
					`PR #${prNumber} maps to branch \`${branch}\`, but no session exists for ${owner}/${repo}#${issueNumber}.`,
					`TARS will not create a new session from a PR comment because that can target the wrong branch.${canonicalNote}`,
				].join("\n"),
			);
			return;
		}

		const mappingError = validatePRSessionMapping(session, prNumber, branch);
		if (mappingError) {
			process.stdout.write(`[webhook] ${eventType} ignored: ${mappingError}\n`);
			await this.deps.workflow.markFailed(owner, repo, issueNumber, { summary: mappingError });
			await this.deps.github.createComment(
				owner,
				repo,
				prNumber,
				[
					"**TARS stopped before execution.**",
					"",
					mappingError,
					"",
					"This protects the PR from being handled by the wrong issue worktree.",
				].join("\n"),
			);
			return;
		}

		if (!session.prNumber || !session.prUrl) {
			await this.deps.workflow.associatePR(owner, repo, issueNumber, prNumber, `https://github.com/${owner}/${repo}/pull/${prNumber}`);
		}

		const { comments, reviewBody } = await this.fetchReviewComments(owner, repo, prNumber, payload);
		const classification = classifyComments([...(reviewBody ? [reviewBody] : []), ...comments.map((comment) => comment.body)]);
		process.stdout.write(`[webhook] ${eventType} PR #${prNumber} (issue #${issueNumber}) classified as ${classification}\n`);

		if (classification === "discussion") {
			await this.replyToPRReview(owner, repo, prNumber, comments, reviewBody);
			return;
		}

		const iterationCount = session.iterationCount ?? 0;
		if (iterationCount >= this.deps.maxIterations) {
			process.stdout.write(`[webhook] ${eventType} PR #${prNumber} ignored: max iterations (${this.deps.maxIterations}) reached\n`);
			await this.deps.github.createComment(
				owner,
				repo,
				prNumber,
				`Maximum iteration limit (${this.deps.maxIterations}) reached. Human intervention required.`,
			);
			return;
		}

		this.inFlight.add(inFlightKey);
		try {
			await this.processActionableReview(owner, repo, issueNumber, prNumber, session.labels, comments, reviewBody);
		} finally {
			this.inFlight.delete(inFlightKey);
		}
	}

	private async resolveSessionForPullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		branch: string,
	): Promise<{ issueNumber: number; session: Awaited<ReturnType<SessionWorkflow["getSession"]>>; branchIssueNumber: number | null } | null> {
		const branchIssueNumber = extractIssueNumberFromBranch(branch);
		if (branchIssueNumber) {
			const session = await this.deps.workflow.getSession(owner, repo, branchIssueNumber);
			return { issueNumber: branchIssueNumber, session, branchIssueNumber };
		}

		const session = await this.deps.workflow.findSessionByPR(owner, repo, prNumber);
		if (!session) {
			return null;
		}

		return { issueNumber: session.issueNumber, session, branchIssueNumber: null };
	}

	private async fetchReviewComments(
		owner: string,
		repo: string,
		prNumber: number,
		payload: PullRequestPayload,
	): Promise<{ comments: ReviewCommentSnapshot[]; reviewBody?: string }> {
		const comments: ReviewCommentSnapshot[] = [];
		let reviewBody: string | undefined;

		if (payload.comment) {
			comments.push({
				id: payload.comment.id,
				body: payload.comment.body,
				user: payload.comment.user,
				path: payload.comment.path,
				line: payload.comment.line,
			});
		}

		if (payload.review) {
			if (payload.review.body) {
				reviewBody = payload.review.body;
			}
			if (payload.review.id) {
				try {
					const reviewComments = await this.deps.github.listReviewComments(owner, repo, prNumber, payload.review.id);
					for (const comment of reviewComments) {
						if (!comments.some((existing) => existing.id === comment.id)) {
							comments.push(comment);
						}
					}
				} catch {
					// proceed with partial context
				}
			}
		}

		return { comments, reviewBody };
	}

	private async processActionableReview(
		owner: string,
		repo: string,
		issueNumber: number,
		prNumber: number,
		labels: string[] | undefined,
		comments: ReviewCommentSnapshot[],
		reviewBody?: string,
	): Promise<void> {
		await this.deps.workflow.markWorking(owner, repo, issueNumber);
		await this.deps.workspaceManager.createOrGetWorktree(owner, repo, issueNumber);
		await this.deps.github.createComment(
			owner,
			repo,
			prNumber,
			`Picked up review feedback. Iteration ${(await this.currentIteration(owner, repo, issueNumber)) + 1}/${this.deps.maxIterations}.`,
		);

		const inFlightKey = `${owner}/${repo}#${issueNumber}`;
		const abortController = new AbortController();
		this.deps.taskController?.register(inFlightKey, () => abortController.abort());

		let result: import("../executor/index.js").ExecutionResult;
		try {
			const state = await this.deps.workflow.getSession(owner, repo, issueNumber);
			if (!state) {
				throw new Error(`No session for ${owner}/${repo}#${issueNumber}`);
			}
			result = await this.deps.executor.execute(
				state,
				undefined,
				{
					comments: comments.map((comment) => ({
						body: comment.body,
						user: comment.user.login,
						path: comment.path,
						line: comment.line ?? undefined,
					})),
					reviewBody,
				},
				abortController.signal,
			);
		} catch (error) {
			if (abortController.signal.aborted) {
				process.stdout.write(`[webhook] PR review execution aborted for ${inFlightKey}\n`);
				await this.deps.workflow.markCancelled(owner, repo, issueNumber);
				await this.deps.github.createComment(owner, repo, prNumber, "Task cancelled by admin. TARS is idle.");
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			await this.deps.github.createComment(owner, repo, prNumber, `**TARS failed.**\n\nError: ${message}`);
			await this.deps.workflow.markFailed(owner, repo, issueNumber);
			throw error;
		} finally {
			this.deps.taskController?.unregister(inFlightKey);
		}

		await this.deps.workflow.incrementIterationCount(owner, repo, issueNumber);

		if (result.status === "cancelled") {
			await this.deps.workflow.markCancelled(owner, repo, issueNumber);
			await this.deps.github.createComment(
				owner,
				repo,
				prNumber,
				[
					"Task cancelled by admin.",
					"",
					result.summary || "TARS has stopped working on this review.",
					"",
					"TARS is idle and ready for the next task.",
				].join("\n"),
			);
			return;
		}

		if (result.status === "complete") {
			const pushed = await this.deps.workspaceManager.commitAndPush(
				owner,
				repo,
				issueNumber,
				generateCommitMessage(labels, issueNumber, result.summary),
			);
			await this.deps.workflow.markComplete(owner, repo, issueNumber);
			await this.deps.github.createComment(
				owner,
				repo,
				prNumber,
				pushed
					? [
						"**TARS iteration complete.**",
						"",
						"Changes pushed to the PR branch.",
						"",
						"Summary:",
						result.summary || "No summary provided.",
					].join("\n")
					: [
						"**TARS iteration complete.**",
						"",
						"No changes were needed.",
						"",
						"Summary:",
						result.summary || "No summary provided.",
					].join("\n"),
			);
			return;
		}

		if (result.status === "waiting-feedback") {
			await this.deps.workflow.markWaitingFeedback(owner, repo, issueNumber);
			await this.deps.github.createComment(
				owner,
				repo,
				prNumber,
				[
					"Need clarification:",
					result.summary || "TARS needs more information before continuing.",
				].join("\n\n"),
			);
			return;
		}

		await this.deps.workflow.markWorking(owner, repo, issueNumber);
		await this.deps.github.createComment(
			owner,
			repo,
			prNumber,
			[
				"TARS is still working on the review feedback.",
				"",
				result.summary || "Execution is in progress.",
			].join("\n"),
		);
	}

	private async currentIteration(owner: string, repo: string, issueNumber: number): Promise<number> {
		const session = await this.deps.workflow.getSession(owner, repo, issueNumber);
		return session?.iterationCount ?? 0;
	}

	private async replyToPRReview(
		owner: string,
		repo: string,
		prNumber: number,
		comments: ReviewCommentSnapshot[],
		reviewBody?: string,
	): Promise<void> {
		const lines = ["**TARS acknowledgement**"];
		if (reviewBody) {
			lines.push("");
			lines.push("Acknowledged the review comment.");
		}
		if (comments.length > 0) {
			lines.push("");
			lines.push("Acknowledged the following review comments:");
			for (const comment of comments) {
				lines.push(`- @${comment.user.login}: ${comment.body.trim()}`);
			}
		}
		lines.push("");
		lines.push("No code changes required based on the current feedback.");
		await this.deps.github.createComment(owner, repo, prNumber, lines.join("\n"));
	}
}
