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
import { isAdmin } from "../../domain/workflow/policy.js";
import {
	evaluateRefinementRequest,
	evaluateRefinementPreConflict,
	evaluateRefinementSessionConflict,
	evaluateRefinementRegistrationConflict,
	type RefinementConflictDecision,
} from "./refinement/admission.js";
import { evaluateProposalApplicability } from "./refinement/proposal-policy.js";
import { FilesystemSkillResolver, type RefinementSkillInfo, type RefinementSkillResolver } from "./refinement/skill-resolver.js";
import { RefinementLifecycle } from "./refinement/lifecycle.js";
import { sessionStorageKey } from "../../session/store.js";
import type { MetricsRecorder } from "../../ports/metrics-recorder.js";
import type { RefinementResult } from "../../executor/index.js";

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
		"Learn more: https://github.com/mbrooks/yolomatic",
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
	private readonly lifecycle: RefinementLifecycle;
	private readonly skillResolver: RefinementSkillResolver;

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
			resolveIssueNewCommentEnabled?: (owner: string, repo: string) => boolean | undefined;
			resolveIssueAdminLinkInCommentsEnabled?: (owner: string, repo: string) => boolean | undefined;
			/** Optional recorder for per-execution metrics (runtime + token usage). */
			metrics?: MetricsRecorder;
			/** Optional boundary for resolving the repository skill and commit. */
			skillResolver?: RefinementSkillResolver;
		},
	) {
		this.lifecycle = new RefinementLifecycle({
			refinementStore: deps.refinementStore,
			sessions: deps.sessions,
			clock: deps.clock,
			metrics: deps.metrics,
		});
		this.skillResolver = deps.skillResolver ?? new FilesystemSkillResolver();
	}

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

		const issueNewCommentEnabled =
			this.deps.resolveIssueNewCommentEnabled?.(owner, repo) ?? this.deps.issueNewCommentEnabled;
		if (issueNewCommentEnabled === false) {
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

		const request = evaluateRefinementRequest({
			action: payload.action,
			commentBody: payload.comment.body,
			commentUserLogin: payload.comment.user.login,
			commentUserType: payload.comment.user.type,
			issuePullRequest: payload.issue.pull_request,
			issueState: payload.issue.state,
			isRepoManaged: this.deps.isRepoManaged ? this.deps.isRepoManaged(owner, repo) : true,
			refinementEnabled: this.deps.refinementEnabled,
			githubUsername: this.deps.githubUsername,
			senderLogin: payload.sender.login,
			owner,
			repo,
			issueNumber,
		});

		const steering = steeringPrompt ?? request.steeringPrompt;
		const commandLogDetails = steering ? { steeringPrompt: steering } : undefined;

		if (request.outcome === "ignore") {
			if (request.commandStdout) process.stdout.write(`${request.commandStdout}\n`);
			if (request.commandLog) {
				this.log(owner, repo, issueNumber, request.commandLog.level, request.commandLog.message, commandLogDetails);
			}
			if (request.stdout) process.stdout.write(`${request.stdout}\n`);
			return;
		}

		process.stdout.write(`${request.commandStdout}\n`);
		this.log(
			owner,
			repo,
			issueNumber,
			request.commandLog!.level,
			request.commandLog!.message,
			commandLogDetails,
		);

		const authorized =
			isAdmin(payload.sender.login, this.deps.adminGithubUsername) ||
			(await this.deps.github.isCollaborator(owner, repo, payload.sender.login));

		const preConflict = evaluateRefinementPreConflict({
			authorized,
			alreadyInFlight: this.inFlight.has(key),
			taskActive: this.deps.tasks.isActive(key),
			senderLogin: payload.sender.login,
			key,
		});
		if (preConflict.outcome === "reject") {
			this.emitConflict(owner, repo, issueNumber, preConflict);
			return;
		}

		const activeImplementation = await this.deps.sessions.get(owner, repo, issueNumber, "implementation");
		const activeRefinement = await this.deps.sessions.get(owner, repo, issueNumber, "refinement");
		const activeSession = [activeImplementation, activeRefinement].find((session) => session?.status === "working");

		const sessionConflict = evaluateRefinementSessionConflict({
			activeSessionKind: activeSession?.kind,
			key,
		});
		if (sessionConflict.outcome === "reject") {
			this.emitConflict(owner, repo, issueNumber, sessionConflict);
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
			const regConflict = evaluateRefinementRegistrationConflict({ taskRegistered: false, key });
			this.emitConflict(owner, repo, issueNumber, regConflict);
			return;
		}

		let attemptId: string | undefined;
		let worktreePath: string | undefined;
		let sessionStarted = false;
		let refinementResult: RefinementResult | undefined;
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
				await this.lifecycle.failSession(owner, repo, issueNumber, "issue is no longer open");
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

			const skillInfo: RefinementSkillInfo = await this.skillResolver.resolveSkill(worktreePath);
			this.lifecycle.setAttemptSource(attemptId, skillInfo);
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
			await this.lifecycle.setSessionSummary(owner, repo, issueNumber, result.summary);

			this.lifecycle.recordAttemptResult(attemptId, result);
			this.log(owner, repo, issueNumber, "info", "Refinement worker returned a proposed task", {
				summary: result.summary,
				bodyLength: result.proposedTaskBody.length,
			});

			const currentIssue = await this.deps.github.getIssue(owner, repo, issueNumber);
			const proposal = evaluateProposalApplicability({
				currentIssue,
				originalTitle: title,
				originalBodyFingerprint: fingerprint,
				proposedTaskBody: result.proposedTaskBody,
				proposedTitle: result.proposedTitle,
			});

			if (proposal.outcome === "stale" || proposal.outcome === "failed") {
				if (proposal.outcome === "stale") {
					this.lifecycle.markAttemptStale(attemptId, proposal.reason);
				} else {
					this.lifecycle.markAttemptFailed(attemptId, proposal.reason);
				}
				await this.lifecycle.failSession(owner, repo, issueNumber, proposal.reason);
				this.log(owner, repo, issueNumber, "warn", proposal.logMessage);
				await this.deps.github.postComment(owner, repo, issueNumber, this.withAdminLink(owner, repo, issueNumber, proposal.comment));
				return;
			}

			await this.deps.github.updateIssueBody(owner, repo, issueNumber, result.proposedTaskBody);
			if (proposal.applyTitle) {
				await this.deps.github.updateIssueTitle(owner, repo, issueNumber, proposal.proposedTitle);
			}
			this.lifecycle.markAttemptApplied(attemptId);
			await this.lifecycle.completeSession(owner, repo, issueNumber, result.summary);
			metricStatus = "complete";
			this.log(owner, repo, issueNumber, "info", "Applied refined issue body");
			const completionBody = proposal.applyTitle
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
				this.lifecycle.markAttemptFailed(attemptId, message);
			}
			if (sessionStarted) {
				await this.lifecycle.failSession(owner, repo, issueNumber, message);
			}
			this.log(owner, repo, issueNumber, "error", `Refinement failed: ${message}`);
			await this.deps.github.postComment(owner, repo, issueNumber, this.withAdminLink(owner, repo, issueNumber, `Refinement failed: ${message}`));
		} finally {
			if (sessionStarted) {
				await this.lifecycle.cleanup({
					owner,
					repo,
					issueNumber,
					attemptId,
					taskStartedAtMs,
					metricStatus,
					result: refinementResult,
				});
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
			this.deps.resolveIssueAdminLinkInCommentsEnabled?.(owner, repo) ?? this.deps.issueAdminLinkInCommentsEnabled;
		return resolveAdminIssueUrl(adminBaseUrl, issueAdminLinkInCommentsEnabled, owner, repo, issueNumber);
	}

	private adminSessionUrl(owner: string, repo: string, issueNumber: number): string | undefined {
		const adminBaseUrl = this.deps.resolveAdminBaseUrl?.() ?? this.deps.adminBaseUrl;
		const issueAdminLinkInCommentsEnabled =
			this.deps.resolveIssueAdminLinkInCommentsEnabled?.(owner, repo) ?? this.deps.issueAdminLinkInCommentsEnabled;
		return resolveAdminSessionUrl(adminBaseUrl, issueAdminLinkInCommentsEnabled, owner, repo, issueNumber, "refinement");
	}

	private withAdminSessionLink(owner: string, repo: string, issueNumber: number, body: string): string {
		return appendAdminLink(body, this.adminSessionUrl(owner, repo, issueNumber));
	}

	private withAdminLink(owner: string, repo: string, issueNumber: number, body: string): string {
		return appendAdminLink(body, this.adminIssueUrl(owner, repo, issueNumber));
	}

	private async emitConflict(owner: string, repo: string, issueNumber: number, decision: RefinementConflictDecision): Promise<void> {
		if (decision.outcome !== "reject") return;
		if (decision.stdout) process.stdout.write(`${decision.stdout}\n`);
		if (decision.log) this.log(owner, repo, issueNumber, decision.log.level, decision.log.message);
		if (decision.comment) {
			await this.deps.github.postComment(owner, repo, issueNumber, this.withAdminLink(owner, repo, issueNumber, decision.comment));
		}
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
}