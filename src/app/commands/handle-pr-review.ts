import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { ExecutionService } from "../../ports/execution-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import { classifyComments } from "../../pr-review/classifier.js";
import { generateCommitMessage } from "../../workspace/manager.js";
import { extractIssueNumberFromBranch, validatePRSessionMapping } from "../../pr-review/session-invariant.js";
import type { ExecutionResult } from "../../executor/index.js";
import { issueSessionKey, queueResumeOnBoot } from "./workflow-helpers.js";

export interface PRReviewPayload {
	action: string;
	pull_request: {
		number: number;
		head: { ref: string };
		state: string;
		merged: boolean;
	};
	repository: { name: string; owner: { login: string } };
	sender: { login: string };
	comment?: { id: number; body: string; user: { login: string }; path?: string; line?: number | null };
	review?: { id: number; body: string | null; state: string; user: { login: string } };
}

export class HandlePRReview {
	private inFlight = new Set<string>();

	constructor(
		private readonly deps: {
			sessions: SessionRepository;
			workspaces: WorkspaceService;
			executor: ExecutionService;
			github: GitHubService;
			tasks: TaskControlService;
			githubUsername: string;
			maxIterations: number;
		},
	) {}

	async execute(payload: PRReviewPayload): Promise<void> {
		if (payload.action !== "created" && payload.action !== "submitted" && payload.action !== "edited") {
			process.stdout.write(`[webhook] pull_request_review action ignored: ${payload.action}\n`);
			return;
		}
		await this.processPREvent(payload);
	}

	private async processPREvent(payload: PRReviewPayload): Promise<void> {
		const owner = payload.repository.owner.login;
		const repo = payload.repository.name;
		const prNumber = payload.pull_request.number;
		const branch = payload.pull_request.head.ref;
		const eventType = payload.comment ? "pull_request_review_comment" : "pull_request_review";

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

		const issueNumber = extractIssueNumberFromBranch(branch);
		if (!issueNumber) {
			process.stdout.write(`[webhook] ${eventType} ignored: branch ${branch} is not a TARS branch\n`);
			return;
		}

		const inFlightKey = issueSessionKey(owner, repo, issueNumber);
		if (this.inFlight.has(inFlightKey)) {
			process.stdout.write(`[webhook] ${eventType} ignored: ${inFlightKey} is already being processed\n`);
			return;
		}

		const session = await this.deps.sessions.get(owner, repo, issueNumber);
		if (!session) {
			process.stdout.write(`[webhook] ${eventType} ignored: no session for ${inFlightKey}\n`);
			const sessionForPR = await this.deps.sessions.findSessionByPR(owner, repo, prNumber);
			const canonicalNote = sessionForPR
				? ` Stored PR mapping points to ${owner}/${repo}#${sessionForPR.issueNumber}; refusing to guess.`
				: "";
			await this.deps.github.postPRComment(
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
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed", { summary: mappingError });
			await this.deps.github.postPRComment(
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
			const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
			await this.deps.sessions.associatePR(owner, repo, issueNumber, prNumber, prUrl);
		}

		const { comments, reviewBody } = await this.fetchReviewComments(owner, repo, prNumber, payload);
		const commentBodies = [...(reviewBody ? [reviewBody] : []), ...comments.map((c) => c.body)];
		const classification = classifyComments(commentBodies);

		process.stdout.write(`[webhook] ${eventType} PR #${prNumber} (issue #${issueNumber}) classified as ${classification}\n`);

		if (classification === "discussion") {
			await this.replyToPRReview(owner, repo, prNumber, comments, reviewBody);
			return;
		}

		if (this.deps.tasks.isDraining()) {
			process.stdout.write(`[webhook] ${eventType} ignored: draining mode for ${inFlightKey}\n`);
			const commentBodies = [...(reviewBody ? [reviewBody] : []), ...comments.map((c) => c.body)];
			if (commentBodies.length > 0) {
				await queueResumeOnBoot(this.deps.sessions, session, commentBodies);
			}
			await this.deps.github.postPRComment(owner, repo, prNumber, "Deploy in progress. Review feedback will be processed after restart.");
			return;
		}

		const iterationCount = session.iterationCount ?? 0;
		if (iterationCount >= this.deps.maxIterations) {
			process.stdout.write(`[webhook] ${eventType} PR #${prNumber} ignored: max iterations (${this.deps.maxIterations}) reached\n`);
			await this.deps.github.postPRComment(owner, repo, prNumber, `Maximum iteration limit (${this.deps.maxIterations}) reached. Human intervention required.`);
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
		payload: PRReviewPayload,
	): Promise<{ comments: Array<{ id: number; body: string; user: string; path?: string; line?: number | null }>; reviewBody?: string }> {
		const comments: Array<{ id: number; body: string; user: string; path?: string; line?: number | null }> = [];
		let reviewBody: string | undefined;

		if (payload.comment) {
			comments.push({
				id: payload.comment.id,
				body: payload.comment.body,
				user: payload.comment.user.login,
				path: payload.comment.path,
				line: payload.comment.line,
			});
		}

		if (payload.review) {
			if (payload.review.body) {
				reviewBody = payload.review.body;
			}
			if (payload.review.id) {
				const reviewComments = await this.deps.github.listReviewComments(owner, repo, prNumber, payload.review.id);
				for (const rc of reviewComments) {
					if (!comments.some((c) => c.id === rc.id)) {
						comments.push({
							id: rc.id,
							body: rc.body,
							user: rc.user?.login ?? "",
							path: rc.path,
							line: rc.line,
						});
					}
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
		state: import("../../session/store.js").SessionState,
		comments: Array<{ id: number; body: string; user: string; path?: string; line?: number | null }>,
		reviewBody?: string,
	): Promise<void> {
		await this.deps.sessions.updateStatus(owner, repo, issueNumber, "working");
		await this.deps.workspaces.createOrGetWorktree(owner, repo, issueNumber);
		await this.deps.github.postPRComment(
			owner,
			repo,
			prNumber,
			`Picked up review feedback. Iteration ${(state.iterationCount ?? 0) + 1}/${this.deps.maxIterations}.`,
		);

		const inFlightKey = issueSessionKey(owner, repo, issueNumber);
		const abortController = new AbortController();
		this.deps.tasks.register(inFlightKey, () => abortController.abort());

		let result: ExecutionResult;
		try {
			result = await this.deps.executor.executePRReview(
				state,
				{
					comments: comments.map((c) => ({
						body: c.body,
						user: c.user,
						path: c.path,
						line: c.line ?? undefined,
					})),
					reviewBody,
				},
				abortController.signal,
			);
		} catch (error) {
			if (abortController.signal.aborted) {
				process.stdout.write(`[webhook] PR review execution aborted for ${inFlightKey}\n`);
				await this.deps.sessions.cancelSession(owner, repo, issueNumber);
				await this.deps.github.postPRComment(owner, repo, prNumber, "Task cancelled by admin. TARS is idle.");
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			await this.deps.github.postPRComment(owner, repo, prNumber, `**TARS failed.**\n\nError: ${message}`);
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed");
			throw error;
		} finally {
			this.deps.tasks.unregister(inFlightKey);
		}

		await this.deps.sessions.incrementIterationCount(owner, repo, issueNumber);

		if (result.status === "cancelled") {
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "cancelled");
			await this.deps.github.postPRComment(
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
			const pushed = await this.deps.workspaces.commitAndPush(
				owner,
				repo,
				issueNumber,
				generateCommitMessage(state.labels, issueNumber, result.summary),
			);
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "complete");
			if (pushed) {
				await this.deps.github.postPRComment(
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
				await this.deps.github.postPRComment(
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
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "waiting-feedback");
			await this.deps.github.postPRComment(
				owner,
				repo,
				prNumber,
				[
					"Need clarification:",
					result.summary || "TARS needs more information before continuing.",
				].join("\n\n"),
			);
		} else {
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "working");
			await this.deps.github.postPRComment(
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
		comments: Array<{ id: number; body: string; user: string }>,
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
				lines.push(`- @${comment.user}: ${comment.body.trim()}`);
			}
		}
		lines.push("");
		lines.push("No code changes required based on the current feedback.");
		await this.deps.github.postPRComment(owner, repo, prNumber, lines.join("\n"));
	}
}
