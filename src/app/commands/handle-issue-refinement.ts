import type { GitHubService } from "../../ports/github-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { Clock } from "../../ports/clock.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { RefinementExecutionService } from "../../ports/execution-service.js";
import type { GitHubEventStateStore } from "../../github-events/model.js";
import type { RefinementStore } from "../../refinement/store.js";
import { fingerprintBody } from "../../refinement/fingerprint.js";
import { recordSessionLog, type SessionLogEntry } from "../../logging/session-log-store.js";
import { issueSessionKey } from "./workflow-helpers.js";
import { appendAdminLink, resolveAdminIssueUrl, resolveAdminSessionUrl } from "./comment-links.js";
import { isAdmin, parseIssueRefinementCommand } from "../../domain/workflow/policy.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { statSync } from "node:fs";
import { sessionStorageKey } from "../../session/store.js";
import type { MetricsRecorder } from "../../ports/metrics-recorder.js";

export interface IssueRefinementEventPayload {
	source?: "webhook" | "polling";
	action: string;
	issue: {
		number: number;
		state?: string;
		title?: string;
		body?: string | null;
		pull_request?: { url: string };
		labels?: Array<{ name?: string }>;
		assignee?: { login: string } | null;
		assignees?: { login: string }[];
		user?: { login: string };
	};
	comment: { id?: number; body: string; user: { login: string; type?: string } };
	repository: { name: string; owner: { login: string } };
	sender: { login: string };
}

export interface IssueRefinementInstructionPayload {
	source?: "webhook" | "polling";
	action: string;
	issue: {
		number: number;
		title: string;
		body: string | null;
		created_at?: string;
		labels?: Array<{ name?: string }>;
		assignee?: { login: string } | null;
		assignees?: { login: string }[];
		user?: { login: string };
	};
	repository: { name: string; owner: { login: string } };
	sender: { login: string };
}

export const ISSUE_REFINEMENT_STARTING_COMMENT = "Picked up by Yolomatic. Refining this issue. No implementation session will start.";

/**
 * Build the short automatic comment Yolomatic posts on newly opened issues.
 *
 * Lists the available commands (assign-to-Yolomatic, `/yolomatic feedback`,
 * `/yolomatic issue-refinement`, `/yolomatic stop`) and, when an admin issue
 * URL is provided, appends a one-line status-tracking link. The detailed
 * refinement explanation lives in README.md / design/issue-refinement.md and
 * is not duplicated here.
 */
export function buildNewIssueComment(githubUsername: string, adminIssueUrl?: string): string {
	const body = [
		"Yolomatic is available to work on this issue.",
		"",
		"- Assign the issue to `" + githubUsername + "` to start an implementation session and open a pull request.",
		"- `/yolomatic feedback` — once a session is active, steer it by posting a comment with this command (or by @-mentioning `" + githubUsername + "`). Prior non-trigger comments on the issue are gathered as background context for the next feedback pass.",
		"- `/yolomatic issue-refinement` — have an authorized maintainer ask Yolomatic to refine the issue body into a Proposed Task (no implementation or PR). Trailing text after the command is treated as a steering prompt that shapes the refinement pass.",
		"- `/yolomatic stop` — stop the active session (authorized maintainers only).",
	].join("\n");
	return appendAdminLink(body, adminIssueUrl);
}

export class HandleIssueRefinement {
	private readonly inFlight = new Set<string>();

	constructor(
		private readonly deps: {
			refinementStore: RefinementStore;
			sessions: SessionRepository;
			github: GitHubService;
			tasks: TaskControlService;
			workspaces: WorkspaceService;
			executor: RefinementExecutionService;
			clock: Clock;
			eventStore?: GitHubEventStateStore;
			adminGithubUsername?: string;
			githubUsername: string;
			defaultBranch?: string;
			resolveDefaultBranch?: (owner: string, repo: string) => string;
			isRepoManaged?: (owner: string, repo: string) => boolean;
			refinementEnabled?: boolean;
			issueNewCommentEnabled?: boolean;
			issueAdminLinkInCommentsEnabled?: boolean;
			adminBaseUrl?: string;
			resolveAdminBaseUrl?: () => string | undefined;
			resolveIssueAdminLinkInCommentsEnabled?: () => boolean | undefined;
			/** Optional recorder for per-execution metrics (runtime + token usage). */
			metrics?: MetricsRecorder;
		},
	) {}

	isInFlight(owner: string, repo: string, issueNumber: number): boolean {
		return this.inFlight.has(issueSessionKey(owner, repo, issueNumber));
	}

	isAppliedBodyEdit(payload: { source?: "webhook" | "polling"; issue: { number: number; body?: string | null; pull_request?: { url: string } }; repository: { name: string; owner: { login: string } } }): boolean {
		if (payload.source !== "polling") return false;
		if (payload.issue.pull_request) return false;
		const { owner, repo, issueNumber } = this.resolveContext(payload);
		const attempt = this.deps.refinementStore.getLatestAttempt(owner, repo, issueNumber);
		if (!attempt || attempt.state !== "applied") return false;
		return attempt.proposedTaskBody === (payload.issue.body ?? "");
	}

	async restart(owner: string, repo: string, issueNumber: number): Promise<void> {
		const previous = this.deps.refinementStore.getLatestAttempt(owner, repo, issueNumber);
		if (!previous) {
			throw new Error(`No refinement attempt exists for ${owner}/${repo}#${issueNumber}`);
		}
		const issue = await this.deps.github.getIssue(owner, repo, issueNumber);
		if (!issue) {
			throw new Error(`Issue ${owner}/${repo}#${issueNumber} was not found`);
		}
		if (issue.state === "closed") {
			throw new Error(`Cannot restart refinement for closed issue ${owner}/${repo}#${issueNumber}`);
		}
		const requester = this.deps.adminGithubUsername?.trim() || previous.requester;
		const commandBody = previous.steeringPrompt
			? `/yolomatic issue-refinement ${previous.steeringPrompt}`
			: "/yolomatic issue-refinement";
		await this.execute(
			{
				action: "created",
				issue: {
					number: issueNumber,
					state: issue.state,
					title: issue.title ?? previous.originalTitle,
					body: issue.body ?? "",
					labels: [],
				},
				comment: {
					body: commandBody,
					user: { login: requester, type: "User" },
				},
				repository: { name: repo, owner: { login: owner } },
				sender: { login: requester },
			},
			previous.steeringPrompt,
		);
	}

	async postInstructions(payload: IssueRefinementInstructionPayload): Promise<void> {
		const { owner, repo, issueNumber } = this.resolveContext(payload);
		const issue = payload.issue;

		if (!this.isEligibleForInstructions(payload)) {
			return;
		}

		const existing = this.deps.refinementStore.getInstructionComment(owner, repo, issueNumber);
		if (existing) {
			process.stdout.write(`[refinement] instructions already recorded for ${owner}/${repo}#${issueNumber}\n`);
			return;
		}

		if (this.deps.issueNewCommentEnabled === false) {
			process.stdout.write(`[refinement] automatic new-issue comment disabled for ${owner}/${repo}#${issueNumber}\n`);
			return;
		}

		process.stdout.write(`[refinement] posting instructions for ${owner}/${repo}#${issueNumber}\n`);
		const comment = buildNewIssueComment(this.deps.githubUsername, this.adminIssueUrl(owner, repo, issueNumber));
		const commentId = await this.deps.github.postComment(owner, repo, issueNumber, comment);
		this.deps.refinementStore.recordInstructionComment(owner, repo, issueNumber, commentId);
		this.log(owner, repo, issueNumber, "info", "Posted issue-refinement instructions");
	}

	async execute(payload: IssueRefinementEventPayload, steeringPrompt?: string): Promise<void> {
		const { owner, repo, issueNumber, key } = this.resolveContext(payload);

		if (payload.action !== "created") {
			process.stdout.write(`[refinement] ignored: action is ${payload.action}\n`);
			return;
		}

		const parsed = parseIssueRefinementCommand(payload.comment.body);
		if (!parsed.matched) {
			return;
		}
		const steering = steeringPrompt ?? parsed.steeringPrompt;

		process.stdout.write(`[refinement] command received for ${owner}/${repo}#${issueNumber}\n`);
		this.log(
			owner,
			repo,
			issueNumber,
			"info",
			`Refinement command received from @${payload.sender.login}`,
			steering ? { steeringPrompt: steering } : undefined,
		);

		if (payload.comment.user.login === this.deps.githubUsername) {
			process.stdout.write(`[refinement] ignored: comment from ${this.deps.githubUsername}\n`);
			return;
		}

		if (payload.comment.user.type === "Bot") {
			process.stdout.write(`[refinement] ignored: bot comment\n`);
			return;
		}

		if (payload.issue.pull_request) {
			process.stdout.write(`[refinement] ignored: comment is on a pull request\n`);
			return;
		}

		if (payload.issue.state === "closed") {
			process.stdout.write(`[refinement] ignored: issue is closed\n`);
			return;
		}

		if (this.deps.isRepoManaged && !this.deps.isRepoManaged(owner, repo)) {
			process.stdout.write(`[refinement] ignored: repository not managed\n`);
			return;
		}

		if (this.deps.refinementEnabled === false) {
			process.stdout.write(`[refinement] ignored: refinement disabled\n`);
			return;
		}

		const authorized =
			isAdmin(payload.sender.login, this.deps.adminGithubUsername) ||
			(await this.deps.github.isCollaborator(owner, repo, payload.sender.login));
		if (!authorized) {
			process.stdout.write(`[refinement] ignored: ${payload.sender.login} is not a repository collaborator\n`);
			this.log(owner, repo, issueNumber, "warn", `Refinement rejected: @${payload.sender.login} is not a repository collaborator`);
			await this.deps.github.postComment(owner, repo, issueNumber, this.withAdminLink(owner, repo, issueNumber, "Only repository collaborators can run issue refinement."));
			return;
		}

		if (this.inFlight.has(key)) {
			process.stdout.write(`[refinement] ignored: ${key} is already being refined\n`);
			await this.deps.github.postComment(owner, repo, issueNumber, this.withAdminLink(owner, repo, issueNumber, "Refinement is already running for this issue."));
			return;
		}

		if (this.deps.tasks.isActive(key)) {
			process.stdout.write(`[refinement] ignored: ${key} has an active implementation task\n`);
			this.log(owner, repo, issueNumber, "warn", "Refinement skipped: an implementation task is active");
			await this.deps.github.postComment(owner, repo, issueNumber, this.withAdminLink(owner, repo, issueNumber, "Yolomatic is currently working on this issue. Refinement cannot overlap with implementation."));
			return;
		}

		const activeImplementation = await this.deps.sessions.get(owner, repo, issueNumber, "implementation");
		const activeRefinement = await this.deps.sessions.get(owner, repo, issueNumber, "refinement");
		const activeSession = [activeImplementation, activeRefinement].find((session) => session?.status === "working");
		if (activeSession) {
			process.stdout.write(`[refinement] ignored: ${key} has an active ${activeSession.kind ?? "implementation"} session\n`);
			this.log(owner, repo, issueNumber, "warn", `Refinement skipped: an active ${activeSession.kind ?? "implementation"} session exists`);
			await this.deps.github.postComment(
				owner,
				repo,
				issueNumber,
				this.withAdminLink(owner, repo, issueNumber, "Yolomatic is currently working on this issue. Refinement cannot overlap with implementation."),
			);
			return;
		}

		this.inFlight.add(key);
		const registration = this.deps.tasks.register(
			key,
			() => {},
			async () => {},
		);
		if (registration === null) {
			this.inFlight.delete(key);
			process.stdout.write(`[refinement] ignored: ${key} task key is already claimed\n`);
			this.log(owner, repo, issueNumber, "warn", "Refinement skipped: task key is already claimed");
			await this.deps.github.postComment(owner, repo, issueNumber, this.withAdminLink(owner, repo, issueNumber, "Yolomatic is currently active on this issue. Refinement cannot overlap with implementation."));
			return;
		}

		let attemptId: string | undefined;
		let worktreePath: string | undefined;
		let sessionStarted = false;
		let refinementResult: import("../../executor/index.js").RefinementResult | undefined;
		let metricStatus: string = "failed";
		let taskStartedAtMs = 0;

		try {
			const title = payload.issue.title ?? "";
			const body = payload.issue.body ?? "";
			const taskStartedAt = this.deps.clock.now().toISOString();
			taskStartedAtMs = this.deps.clock.now().getTime();
			await this.deps.sessions.createSession(
				owner,
				repo,
				issueNumber,
				title,
				body,
				this.deps.workspaces.getWorktreePath(owner, repo, issueNumber),
				"refinement",
				payload.issue.labels?.map((label) => label.name).filter((name): name is string => !!name),
			);
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "working", {
				kind: "refinement",
				title,
				body,
				branch: `yolomatic/refinement-issue-${issueNumber}`,
				prNumber: undefined,
				prUrl: undefined,
				seeded: false,
				summary: undefined,
				iterationCount: undefined,
				restartCount: undefined,
				restartedFrom: undefined,
				staleDetectedAt: undefined,
				staleReason: undefined,
				archivedAt: undefined,
				resumeOnBoot: undefined,
				queuedComments: undefined,
				taskStartedAt,
				taskFinishedAt: undefined,
				totalExecutionTimeMs: undefined,
			}, "refinement");
			sessionStarted = true;

			process.stdout.write(`[refinement] starting for ${owner}/${repo}#${issueNumber}\n`);
			await this.deps.github.postComment(owner, repo, issueNumber, this.withAdminSessionLink(owner, repo, issueNumber, ISSUE_REFINEMENT_STARTING_COMMENT));
			this.log(owner, repo, issueNumber, "info", "Refinement started");

			const issue = await this.deps.github.getIssue(owner, repo, issueNumber);
			if (!issue || issue.state === "closed") {
				process.stdout.write(`[refinement] ignored: issue is no longer open\n`);
				await this.failSession(owner, repo, issueNumber, "issue is no longer open");
				return;
			}

			const fingerprint = fingerprintBody(body);

			attemptId = this.deps.refinementStore.createAttempt({
				owner,
				repo,
				issueNumber,
				commandCommentId: payload.comment.id,
				requester: payload.sender.login,
				originalTitle: title,
				originalBody: body,
				originalBodyFingerprint: fingerprint,
				instructionSource: "prompt-defaults",
				state: "running",
				steeringPrompt: steering || undefined,
			}).id;
			this.log(owner, repo, issueNumber, "info", "Created refinement attempt", { attemptId });

			worktreePath = await this.deps.workspaces.createRefinementWorktree!(owner, repo, issueNumber);
			this.log(owner, repo, issueNumber, "info", "Prepared refinement worktree", { worktreePath });

			const skillInfo = await this.resolveSkill(owner, repo, worktreePath);
			this.deps.refinementStore.updateAttempt(attemptId, {
				instructionSource: skillInfo.source,
				repoCommit: skillInfo.commit,
			});
			this.log(
				owner,
				repo,
				issueNumber,
				"info",
				skillInfo.source === "repository-skill" ? "Using repository issue-refinement skill" : "Using built-in issue-refinement prompt defaults",
				skillInfo.commit ? { commit: skillInfo.commit } : undefined,
			);

			const state = await this.deps.sessions.updateStatus(owner, repo, issueNumber, "working", {
				workspacePath: worktreePath,
			}, "refinement");
			const result = await this.deps.executor.executeRefinement(state, skillInfo.content, steering);
			refinementResult = result;
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "working", { summary: result.summary }, "refinement");

			this.deps.refinementStore.updateAttempt(attemptId, {
				proposedTaskBody: result.proposedTaskBody,
				proposedTitle: result.proposedTitle,
				summary: result.summary,
				investigation: result.investigation,
			});
			this.log(owner, repo, issueNumber, "info", "Refinement worker returned a proposed task", {
				summary: result.summary,
				bodyLength: result.proposedTaskBody.length,
			});

			const currentIssue = await this.deps.github.getIssue(owner, repo, issueNumber);
			if (!currentIssue || currentIssue.state === "closed") {
				const reason = "issue closed during refinement";
				this.deps.refinementStore.updateAttempt(attemptId, { state: "stale", failureReason: reason });
				await this.failSession(owner, repo, issueNumber, reason);
				this.log(owner, repo, issueNumber, "warn", "Refinement marked stale: issue closed during refinement");
				await this.deps.github.postComment(owner, repo, issueNumber, this.withAdminLink(owner, repo, issueNumber, "The issue changed during refinement. Please run `/yolomatic issue-refinement` again."));
				return;
			}
			const currentFingerprint = fingerprintBody(currentIssue.body ?? "");
			if (currentFingerprint !== fingerprint) {
				const reason = "issue body changed during refinement";
				this.deps.refinementStore.updateAttempt(attemptId, { state: "stale", failureReason: reason });
				await this.failSession(owner, repo, issueNumber, reason);
				this.log(owner, repo, issueNumber, "warn", "Refinement marked stale: issue body changed during refinement");
				await this.deps.github.postComment(owner, repo, issueNumber, this.withAdminLink(owner, repo, issueNumber, "The issue body changed during refinement. Please run `/yolomatic issue-refinement` again."));
				return;
			}
			if (currentIssue.title !== undefined && currentIssue.title !== title) {
				const reason = "issue title changed during refinement";
				this.deps.refinementStore.updateAttempt(attemptId, { state: "stale", failureReason: reason });
				await this.failSession(owner, repo, issueNumber, reason);
				this.log(owner, repo, issueNumber, "warn", "Refinement marked stale: issue title changed during refinement");
				await this.deps.github.postComment(owner, repo, issueNumber, this.withAdminLink(owner, repo, issueNumber, "The issue title changed during refinement. Please run `/yolomatic issue-refinement` again."));
				return;
			}

			if (result.proposedTaskBody.length > 65535) {
				const reason = "proposed task body exceeds GitHub size limit";
				this.deps.refinementStore.updateAttempt(attemptId, { state: "failed", failureReason: reason });
				await this.failSession(owner, repo, issueNumber, reason);
				this.log(owner, repo, issueNumber, "warn", "Refinement failed: proposed task body exceeds GitHub size limit");
				await this.deps.github.postComment(owner, repo, issueNumber, this.withAdminLink(owner, repo, issueNumber, "Refinement produced a body that is too large for GitHub. Please run the command again with a narrower request."));
				return;
			}

			const proposedTitle = result.proposedTitle?.trim() ?? "";
			const applyTitle = proposedTitle.length > 0 && proposedTitle !== title;
			if (applyTitle && proposedTitle.length > 256) {
				const reason = "proposed title exceeds GitHub size limit";
				this.deps.refinementStore.updateAttempt(attemptId, { state: "failed", failureReason: reason });
				await this.failSession(owner, repo, issueNumber, reason);
				this.log(owner, repo, issueNumber, "warn", "Refinement failed: proposed title exceeds GitHub size limit");
				await this.deps.github.postComment(owner, repo, issueNumber, this.withAdminLink(owner, repo, issueNumber, "Refinement produced a title that is too long for GitHub. Please run the command again with a narrower request."));
				return;
			}

			await this.deps.github.updateIssueBody(owner, repo, issueNumber, result.proposedTaskBody);
			if (applyTitle) {
				await this.deps.github.updateIssueTitle(owner, repo, issueNumber, proposedTitle);
			}
			this.deps.refinementStore.updateAttempt(attemptId, { state: "applied" });
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "complete", {
				summary: result.summary,
				taskFinishedAt: this.deps.clock.now().toISOString(),
			}, "refinement");
			metricStatus = "complete";
			this.log(owner, repo, issueNumber, "info", "Applied refined issue body");
			const completionBody = applyTitle
				? `Issue refined at the request of @${payload.sender.login}. The issue title and body now contain the Proposed Task. No implementation session was started.`
				: `Issue refined at the request of @${payload.sender.login}. The issue body now contains the Proposed Task. No implementation session was started.`;
			await this.deps.github.postComment(
				owner,
				repo,
				issueNumber,
				this.withAdminLink(owner, repo, issueNumber, completionBody),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[refinement] failed for ${key}: ${message}\n`);
			if (attemptId) {
				this.deps.refinementStore.updateAttempt(attemptId, { state: "failed", failureReason: message });
			}
			if (sessionStarted) {
				await this.failSession(owner, repo, issueNumber, message);
			}
			this.log(owner, repo, issueNumber, "error", `Refinement failed: ${message}`);
			await this.deps.github.postComment(owner, repo, issueNumber, this.withAdminLink(owner, repo, issueNumber, `Refinement failed: ${message}`));
		} finally {
			if (sessionStarted) {
				this.recordRefinementMetric(owner, repo, issueNumber, taskStartedAtMs, metricStatus, refinementResult);
				this.recordAttemptUsage(attemptId, taskStartedAtMs, refinementResult);
				await this.ensureTerminalSession(owner, repo, issueNumber);
			}
			this.deps.tasks.unregister(key, registration);
			this.inFlight.delete(key);
			if (worktreePath) {
				await this.deps.workspaces.removeRefinementWorktree!(worktreePath);
				this.log(owner, repo, issueNumber, "info", "Removed refinement worktree");
			}
			this.log(owner, repo, issueNumber, "info", "Refinement finished");
		}
	}

	/**
	 * Record a per-refinement metric when a recorder is configured. Called from
	 * the `finally` so runtime is captured for both successful and failed
	 * refinements. Token usage comes from the refinement result when the
	 * worker returned one; otherwise usage is recorded as unavailable.
	 */
	private recordRefinementMetric(
		owner: string,
		repo: string,
		issueNumber: number,
		taskStartedAtMs: number,
		status: string,
		result: { usage?: import("../../executor/usage.js").TokenUsage } | undefined,
	): void {
		const recorder = this.deps.metrics;
		if (!recorder) return;
		const durationMs = this.deps.clock.now().getTime() - taskStartedAtMs;
		const usage = result?.usage ?? {
			available: false,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: 0,
		};
		try {
			recorder.record({
				sessionKey: sessionStorageKey(owner, repo, issueNumber, "refinement"),
				owner,
				repo,
				issueNumber,
				kind: "refinement",
				status,
				startedAt: new Date(taskStartedAtMs).toISOString(),
				finishedAt: new Date(taskStartedAtMs + durationMs).toISOString(),
				durationMs,
				tokenUsage: usage,
			});
		} catch (error) {
			process.stdout.write(
				`[refinement] metrics record failed for ${owner}/${repo}#${issueNumber}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}

	/**
	 * Persist the refinement runtime and token usage on the durable refinement
	 * attempt so the per-issue refinement history can report them. Called from
	 * the `finally` for any attempt that was created, regardless of outcome.
	 * Token usage comes from the refinement result when the worker returned one;
	 * otherwise it is recorded as unavailable. Best-effort: a failure here must
	 * not regress the refinement outcome.
	 */
	private recordAttemptUsage(
		attemptId: string | undefined,
		taskStartedAtMs: number,
		result: { usage?: import("../../executor/usage.js").TokenUsage } | undefined,
	): void {
		if (!attemptId) return;
		const durationMs = this.deps.clock.now().getTime() - taskStartedAtMs;
		const usage = result?.usage;
		const tokenUsage: import("../../refinement/store.js").RefinementTokenUsage = usage
			? {
					available: usage.available,
					input: usage.input,
					output: usage.output,
					totalTokens: usage.totalTokens,
					cost: usage.cost,
				}
			: { available: false, input: 0, output: 0, totalTokens: 0, cost: 0 };
		try {
			this.deps.refinementStore.updateAttempt(attemptId, { runtimeMs: durationMs, tokenUsage });
		} catch (error) {
			process.stdout.write(
				`[refinement] attempt usage record failed for ${attemptId}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}

	private resolveContext(payload: { repository: { name: string; owner: { login: string } }; issue: { number: number } }) {
		const owner = payload.repository.owner.login;
		const repo = payload.repository.name;
		const issueNumber = payload.issue.number;
		return { owner, repo, issueNumber, key: issueSessionKey(owner, repo, issueNumber) };
	}

	private log(
		owner: string,
		repo: string,
		issueNumber: number,
		level: SessionLogEntry["level"],
		message: string,
		details?: Record<string, unknown>,
	): void {
		recordSessionLog(sessionStorageKey(owner, repo, issueNumber, "refinement"), { level, message, details });
	}

	private adminIssueUrl(owner: string, repo: string, issueNumber: number): string | undefined {
		const adminBaseUrl = this.deps.resolveAdminBaseUrl?.() ?? this.deps.adminBaseUrl;
		const issueAdminLinkInCommentsEnabled =
			this.deps.resolveIssueAdminLinkInCommentsEnabled?.() ?? this.deps.issueAdminLinkInCommentsEnabled;
		return resolveAdminIssueUrl(adminBaseUrl, issueAdminLinkInCommentsEnabled, owner, repo, issueNumber);
	}

	private adminSessionUrl(owner: string, repo: string, issueNumber: number): string | undefined {
		const adminBaseUrl = this.deps.resolveAdminBaseUrl?.() ?? this.deps.adminBaseUrl;
		const issueAdminLinkInCommentsEnabled =
			this.deps.resolveIssueAdminLinkInCommentsEnabled?.() ?? this.deps.issueAdminLinkInCommentsEnabled;
		return resolveAdminSessionUrl(adminBaseUrl, issueAdminLinkInCommentsEnabled, owner, repo, issueNumber, "refinement");
	}

	private withAdminSessionLink(owner: string, repo: string, issueNumber: number, body: string): string {
		return appendAdminLink(body, this.adminSessionUrl(owner, repo, issueNumber));
	}

	private withAdminLink(owner: string, repo: string, issueNumber: number, body: string): string {
		return appendAdminLink(body, this.adminIssueUrl(owner, repo, issueNumber));
	}

	private isEligibleForInstructions(payload: IssueRefinementInstructionPayload): boolean {
		const { owner, repo, issueNumber } = this.resolveContext(payload);
		const issue = payload.issue;

		if (payload.action !== "opened") {
			return false;
		}

		if (this.deps.isRepoManaged && !this.deps.isRepoManaged(owner, repo)) {
			return false;
		}

		if (this.deps.refinementEnabled === false) {
			return false;
		}

		if (payload.source === "polling") {
			const baseline = this.deps.eventStore?.getRepoPollBaseline?.(owner, repo);
			if (!baseline) {
				return false;
			}
			const createdAt = payload.issue.created_at ? Date.parse(payload.issue.created_at) : NaN;
			if (Number.isNaN(createdAt) || createdAt <= Date.parse(baseline)) {
				return false;
			}
		}

		if (issue.user?.login === this.deps.githubUsername) {
			return false;
		}

		if (issue.assignee?.login === this.deps.githubUsername || issue.assignees?.some((a) => a.login === this.deps.githubUsername)) {
			return false;
		}

		return true;
	}

	private async resolveSkill(owner: string, repo: string, worktreePath: string): Promise<{
		source: "repository-skill" | "prompt-defaults";
		content?: string;
		commit?: string;
	}> {
		const skillPath = path.join(worktreePath, ".pi/skills/issue-refinement/SKILL.md");
		try {
			statSync(skillPath);
			const content = readFileSync(skillPath, "utf-8");
			const commit = await this.getCommit(worktreePath);
			return { source: "repository-skill", content, commit };
		} catch {
			return { source: "prompt-defaults", commit: await this.getCommit(worktreePath) };
		}
	}

	private async getCommit(worktreePath: string): Promise<string | undefined> {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFile);
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
			return stdout.trim();
		} catch {
			return undefined;
		}
	}

	private async failSession(
		owner: string,
		repo: string,
		issueNumber: number,
		reason: string,
	): Promise<void> {
		await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed", {
			summary: reason,
			staleReason: reason,
			taskFinishedAt: this.deps.clock.now().toISOString(),
		}, "refinement");
	}

	private async ensureTerminalSession(owner: string, repo: string, issueNumber: number): Promise<void> {
		const session = await this.deps.sessions.get(owner, repo, issueNumber, "refinement");
		if (session?.kind === "refinement" && session.status === "working") {
			await this.failSession(owner, repo, issueNumber, "refinement ended without a terminal outcome");
		}
	}
}
