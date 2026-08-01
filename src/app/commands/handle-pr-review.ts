import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { ExecutionService, LiveExecutionSession } from "../../ports/execution-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import { classifyComments } from "../../pr-review/classifier.js";
import { extractIssueNumberFromBranch, validatePRSessionMapping } from "../../pr-review/session-invariant.js";
import type { ExecutionResult } from "../../executor/index.js";
import { isExecutionEnvironmentBlocker, isRateLimitError } from "../../executor/index.js";
import { issueSessionKey, queueResumeOnBoot } from "./workflow-helpers.js";
import { ExecuteSessionReporter } from "./execute-session-reporter.js";

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
	private readonly reporter: ExecuteSessionReporter;

	constructor(
		private readonly deps: {
			sessions: SessionRepository;
			workspaces: WorkspaceService;
			executor: ExecutionService;
			github: GitHubService;
			tasks: TaskControlService;
			githubUsername: string;
			selfReportEnabled: boolean;
		},
	) {
		this.reporter = new ExecuteSessionReporter({
			github: deps.github,
			workspaces: deps.workspaces,
			sessions: deps.sessions,
			selfReportEnabled: deps.selfReportEnabled,
		});
	}

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

		const resolvedSession = await this.resolveSessionForPullRequest(owner, repo, prNumber, branch);
		if (!resolvedSession) {
			process.stdout.write(`[webhook] ${eventType} ignored: branch ${branch} is not associated with a Yeetomatic session\n`);
			return;
		}

		const { issueNumber, session } = resolvedSession;
		const inFlightKey = issueSessionKey(owner, repo, issueNumber);
		if (this.inFlight.has(inFlightKey)) {
			process.stdout.write(`[webhook] ${eventType} ignored: ${inFlightKey} is already being processed\n`);
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
					"**Yeetomatic stopped before execution.**",
					"",
					mappingError,
					"",
					"This protects the PR from being handled by the wrong issue worktree.",
				].join("\n"),
			);
			return;
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

		this.inFlight.add(inFlightKey);
		try {
			await this.processActionableReview(owner, repo, issueNumber, prNumber, session, comments, reviewBody);
		} finally {
			this.inFlight.delete(inFlightKey);
		}
	}

	private async resolveSessionForPullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		branch: string,
	): Promise<{ issueNumber: number; session: import("../../session/store.js").SessionState } | null> {
		const branchIssueNumber = extractIssueNumberFromBranch(branch);
		if (branchIssueNumber) {
			const session = await this.deps.sessions.get(owner, repo, branchIssueNumber);
			if (!session || session.prNumber !== prNumber) {
				return null;
			}
			return { issueNumber: branchIssueNumber, session };
		}

		const session = await this.deps.sessions.findSessionByPR(owner, repo, prNumber);
		if (!session) {
			return null;
		}

		return { issueNumber: session.issueNumber, session };
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
		const inFlightKey = issueSessionKey(owner, repo, issueNumber);
		const abortController = new AbortController();
		let resolveSession: ((session: LiveExecutionSession) => void) | undefined;
		const sessionPromise = new Promise<LiveExecutionSession>((resolve) => {
			resolveSession = resolve;
		});
		const registration = this.deps.tasks.register(
			inFlightKey,
			() => abortController.abort(),
			async (message) => {
				const session = await Promise.race([
					sessionPromise,
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error("steer timeout")), 5000)),
				]);
				await session.steer(message);
			},
		);
		if (registration === null) {
			const feedback = [...(reviewBody ? [reviewBody] : []), ...comments.map((comment) => comment.body)].join("\n\n");
			const steered = feedback ? await this.deps.tasks.steer(inFlightKey, feedback) : false;
			await this.deps.github.postPRComment(
				owner,
				repo,
				prNumber,
				steered ? "Review feedback was steered to the active Yeetomatic task." : "Yeetomatic is busy. Review feedback could not be steered.",
			);
			return;
		}

		const expectedRemoteHead = (await this.deps.github.getPullRequest(owner, repo, prNumber))?.head.sha;
		let result: ExecutionResult;
		try {
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "working");
			await this.deps.github.postPRComment(
				owner,
				repo,
				prNumber,
				`Picked up review feedback. Iteration ${(state.iterationCount ?? 0) + 1}.`,
			);
			const onActivity = () => {
				void this.deps.sessions.updateStatus(owner, repo, issueNumber, "working", {
					lastActivity: new Date().toISOString(),
				});
			};
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
				(session) => {
					resolveSession?.(session);
				},
				onActivity,
			);
		} catch (error) {
			if (abortController.signal.aborted) {
				process.stdout.write(`[webhook] PR review execution aborted for ${inFlightKey}\n`);
				await this.deps.sessions.cancelSession(owner, repo, issueNumber);
				await this.deps.github.postPRComment(owner, repo, prNumber, "Task cancelled by admin. Yeetomatic is idle.");
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			if (isRateLimitError(message)) {
				await this.deps.github.postPRComment(
					owner,
					repo,
					prNumber,
					[
						"**Build failed**",
						"",
						"Yeetomatic encountered a 429 rate-limit error from Ollama and auto-retry was exhausted. The session cannot continue until usage limits are reset or the model is switched.",
						"",
						`Error: ${message}`,
					].join("\n"),
				);
				await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed");
				throw error;
			}
			await this.deps.github.postPRComment(owner, repo, prNumber, `**Yeetomatic failed.**\n\nError: ${message}`);
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed");
			throw error;
		} finally {
			this.deps.tasks.unregister(inFlightKey, registration);
		}

		if (result.status === "working" && isExecutionEnvironmentBlocker(result.summary || result.rawResponse)) {
			result = {
				...result,
				status: "failed",
			};
		}

		await this.deps.sessions.incrementIterationCount(owner, repo, issueNumber);

		try {
			await this.reporter.handleExecutionResult({
				owner,
				repo,
				sessionIssueNumber: issueNumber,
				target: { kind: "pull_request", number: prNumber },
				result,
				context: "Addressing PR review feedback",
				state,
				expectedRemoteHead,
			});
		} catch (error) {
			if (result.status !== "complete") {
				throw error;
			}
			await this.reporter.handleDeliveryFailure(
				owner,
				repo,
				issueNumber,
				state,
				error,
				{ kind: "pull_request", number: prNumber },
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
		const lines = ["**Yeetomatic acknowledgement**"];
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
