import { Octokit } from "@octokit/rest";

import type { PiAgentExecutor } from "../executor/index.js";
import type { SessionManager } from "../session/manager.js";
import type { SessionState } from "../session/store.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { generateCommitMessage } from "../workspace/manager.js";
import { classifyComments } from "./classifier.js";
import type { TaskController } from "../task-controller.js";
import {
	extractIssueNumberFromBranch,
	validatePRSessionMapping,
} from "./session-invariant.js";

export interface PRReviewComment {
	id: number;
	body: string;
	user: { login: string };
	path?: string;
	line?: number | null;
}

interface PullRequestPayload {
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

export interface PRReviewHandlerDeps {
	sessionManager: SessionManager;
	workspaceManager: WorkspaceManager;
	executor: PiAgentExecutor;
	githubToken: string;
	githubUsername: string;
	maxIterations: number;
	octokit?: Octokit;
	taskController?: TaskController;
}

export class PRReviewHandler {
	private readonly octokit: Octokit;
	private readonly inFlight = new Set<string>();

	public constructor(private readonly deps: PRReviewHandlerDeps) {
		this.octokit = deps.octokit ?? new Octokit({ auth: deps.githubToken });
	}

	private extractIssueNumber(branch: string): number | null {
		return extractIssueNumberFromBranch(branch);
	}

	async handlePullRequestReviewCommentEvent(rawPayload: unknown): Promise<void> {
		const payload = rawPayload as PullRequestPayload;
		if (payload.action !== "created") {
			process.stdout.write(`[webhook] pull_request_review_comment action ignored: ${payload.action}\n`);
			return;
		}
		await this.processPREvent(payload, "pull_request_review_comment");
	}

	async handlePullRequestReviewEvent(rawPayload: unknown): Promise<void> {
		const payload = rawPayload as PullRequestPayload;
		if (payload.action !== "submitted" && payload.action !== "edited") {
			process.stdout.write(`[webhook] pull_request_review action ignored: ${ payload.action }\n`);
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
			process.stdout.write(`[webhook] ${ eventType } ignored: event from ${ this.deps.githubUsername }\n`);
			return;
		}

		if (payload.pull_request.state !== "open") {
			process.stdout.write(`[webhook] ${ eventType } ignored: PR #${ prNumber } is not open\n`);
			return;
		}

		if (payload.pull_request.merged) {
			process.stdout.write(`[webhook] ${ eventType } ignored: PR #${ prNumber } is already merged\n`);
			return;
		}

		const issueNumber = this.extractIssueNumber(branch);
		if (!issueNumber) {
			process.stdout.write(`[webhook] ${ eventType } ignored: branch ${ branch } is not a TARS branch\n`);
			return;
		}

		const inFlightKey = `${ owner }/${ repo }#${ issueNumber }`;
		if (this.inFlight.has(inFlightKey)) {
			process.stdout.write(`[webhook] ${ eventType } ignored: ${ inFlightKey } is already being processed\n`);
			return;
		}

		const session = await this.deps.sessionManager.getSession(owner, repo, issueNumber);
		if (!session) {
			process.stdout.write(`[webhook] ${ eventType } ignored: no session for ${ inFlightKey }\n`);
			const sessionForPR = await this.deps.sessionManager.findSessionByPR(owner, repo, prNumber);
			const canonicalNote = sessionForPR
				? ` Stored PR mapping points to ${owner}/${repo}#${sessionForPR.issueNumber}; refusing to guess.`
				: "";
			await this.postPRComment(
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
			process.stdout.write(`[webhook] ${ eventType } ignored: ${mappingError}\n`);
			await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "failed", {
				summary: mappingError,
			});
			await this.postPRComment(
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

		// Sync PR association if not already tracked
		if (!session.prNumber || !session.prUrl) {
			const prUrl = `https://github.com/${ owner }/${ repo }/pull/${ prNumber }`;
			await this.deps.sessionManager.associatePR(owner, repo, issueNumber, prNumber, prUrl);
		}

		// Fetch review comments for context
		const { comments, reviewBody } = await this.fetchReviewComments(owner, repo, prNumber, payload);

		// Classify comments
		const commentBodies = [
			...(reviewBody ? [reviewBody] : []),
			...comments.map((c) => c.body),
		];
		const classification = classifyComments(commentBodies);

		process.stdout.write(
			`[webhook] ${ eventType } PR #${ prNumber } (issue #${ issueNumber }) classified as ${ classification }\n`,
		);

		if (classification === "discussion") {
			await this.replyToPRReview(owner, repo, prNumber, comments, reviewBody);
			return;
		}

		// Check iteration limit
		const iterationCount = session.iterationCount ?? 0;
		if (iterationCount >= this.deps.maxIterations) {
			process.stdout.write(
				`[webhook] ${ eventType } PR #${ prNumber } ignored: max iterations (${ this.deps.maxIterations }) reached\n`,
			);
			await this.postPRComment(
				owner,
				repo,
				prNumber,
				`Maximum iteration limit (${ this.deps.maxIterations }) reached. Human intervention required.`,
			);
			return;
		}

		this.inFlight.add(inFlightKey);
		try {
			await this.processActionableReview(owner, repo, issueNumber, prNumber, session, comments, reviewBody);
		} finally {
			this.inFlight.delete(inFlightKey);
		}
	}

	private async fetchReviewComments(
		owner: string,
		repo: string,
		prNumber: number,
		payload: PullRequestPayload,
	): Promise<{ comments: PRReviewComment[]; reviewBody?: string }> {
		const comments: PRReviewComment[] = [];
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
			// For submitted reviews, fetch all review comments
			if (payload.review.id) {
				try {
					const { data: reviewComments } = await this.octokit.pulls.listReviewComments({
						owner,
						repo,
						pull_number: prNumber,
						review_id: payload.review.id,
					});
					for (const rc of reviewComments) {
						if (!comments.some((c) => c.id === rc.id)) {
							comments.push({
								id: rc.id,
								body: rc.body ?? "",
								user: { login: rc.user?.login ?? "" },
								path: rc.path,
								line: rc.line,
							});
						}
					}
				} catch {
					// If fetching review comments fails, proceed with what we have
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
		state: SessionState,
		comments: PRReviewComment[],
		reviewBody?: string,
	): Promise<void> {
		await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "working");
		await this.deps.workspaceManager.createOrGetWorktree(owner, repo, issueNumber);

		await this.postPRComment(
			owner,
			repo,
			prNumber,
			`Picked up review feedback. Iteration ${ (state.iterationCount ?? 0) + 1 }/${ this.deps.maxIterations }.`,
		);

		const inFlightKey = `${owner}/${repo}#${issueNumber}`;
		const abortController = new AbortController();
		this.deps.taskController?.register(inFlightKey, () => abortController.abort());

		let result: import("../executor/index.js").ExecutionResult;
		try {
			result = await this.deps.executor.execute(state, undefined, {
				comments: comments.map((c) => ({
					body: c.body,
					user: c.user.login,
					path: c.path,
					line: c.line ?? undefined,
				})),
				reviewBody,
			}, abortController.signal);
		} catch (error) {
			if (abortController.signal.aborted) {
				process.stdout.write(`[webhook] PR review execution aborted for ${inFlightKey}\n`);
				await this.deps.sessionManager.cancelSession(owner, repo, issueNumber);
				await this.postPRComment(owner, repo, prNumber, "Task cancelled by admin. TARS is idle.");
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			await this.postPRComment(owner, repo, prNumber, `**TARS failed.**\n\nError: ${ message }`);
			await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "failed");
			throw error;
		} finally {
			this.deps.taskController?.unregister(inFlightKey);
		}

		await this.deps.sessionManager.incrementIterationCount(owner, repo, issueNumber);

		if (result.status === "cancelled") {
			await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "cancelled");
			await this.postPRComment(
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
				generateCommitMessage(state.labels, issueNumber, result.summary),
			);
			await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "complete");
			if (pushed) {
				await this.postPRComment(
					owner,
					repo,
					prNumber,
					[
						"**TARS iteration complete.**",
						"",
						"Changes pushed to the PR branch.",
						"",
						"Summary:",
						result.summary || "No summary provided.",
					].join("\n"),
				);
			} else {
				await this.postPRComment(
					owner,
					repo,
					prNumber,
					[
						"**TARS iteration complete.**",
						"",
						"No changes were needed.",
						"",
						"Summary:",
						result.summary || "No summary provided.",
					].join("\n"),
				);
			}
		} else if (result.status === "waiting-feedback") {
			await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "waiting-feedback");
			await this.postPRComment(
				owner,
				repo,
				prNumber,
				[
					"Need clarification:",
					result.summary || "TARS needs more information before continuing.",
				].join("\n\n"),
			);
		} else {
			await this.deps.sessionManager.updateStatus(owner, repo, issueNumber, "working");
			await this.postPRComment(
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
	}

	private async replyToPRReview(
		owner: string,
		repo: string,
		prNumber: number,
		comments: PRReviewComment[],
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
				lines.push(`- @${ comment.user.login }: ${ comment.body.trim() }`);
			}
		}
		lines.push("");
		lines.push("No code changes required based on the current feedback.");

		await this.postPRComment(owner, repo, prNumber, lines.join("\n"));
	}

	private async postPRComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
		await this.octokit.issues.createComment({
			owner,
			repo,
			issue_number: prNumber,
			body,
		});
	}
}
