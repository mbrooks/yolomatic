import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { ExecutionService, LiveExecutionSession } from "../../ports/execution-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { Clock } from "../../ports/clock.js";
import type { ExecutionResult, PriorDiscussionComment } from "../../executor/index.js";
import { isExecutionEnvironmentBlocker } from "../../executor/index.js";
import type { SessionState } from "../../session/store.js";
import { sessionStorageKey } from "../../session/store.js";
import type { MetricsRecorder } from "../../ports/metrics-recorder.js";
import { FatalSystemError, SelfMonitor } from "../../self-monitor/index.js";
import { SelfEvolutionEngine } from "../../self-evolution/index.js";
import { validatePRSessionMapping } from "../../pr-review/session-invariant.js";
import { WorktreeBranchDivergedError } from "../../workspace/errors.js";
import { issueSessionKey, removeWorkflowLabels } from "./workflow-helpers.js";
import { ExecuteSessionDelivery } from "./execute-session-delivery.js";
import { ExecuteSessionReporter } from "./execute-session-reporter.js";
import { PRRecovery } from "./pr-recovery.js";
import { appendAdminLink, resolveAdminIssueUrl } from "./comment-links.js";

export interface ExecuteSessionDeps {
	sessions: SessionRepository;
	workspaces: WorkspaceService;
	executor: ExecutionService;
	github: GitHubService;
	tasks: TaskControlService;
	clock: Clock;
	defaultBranch?: string;
	resolveDefaultBranch?: (owner: string, repo: string) => string;
	githubUsername: string;
	selfReportEnabled: boolean;
	issueAdminLinkInCommentsEnabled?: boolean;
	adminBaseUrl?: string;
	resolveAdminBaseUrl?: () => string | undefined;
	resolveIssueAdminLinkInCommentsEnabled?: (owner: string, repo: string) => boolean | undefined;
	/** Optional recorder for per-execution metrics (runtime + token usage). */
	metrics?: MetricsRecorder;
}

export class ExecuteSession {
	private readonly reporter: ExecuteSessionReporter;
	private readonly delivery: ExecuteSessionDelivery;
	private readonly recovery: PRRecovery;

	constructor(private readonly deps: ExecuteSessionDeps) {
		this.reporter = new ExecuteSessionReporter({
			github: deps.github,
			workspaces: deps.workspaces,
			sessions: deps.sessions,
			selfReportEnabled: deps.selfReportEnabled,
			issueAdminLinkInCommentsEnabled: deps.issueAdminLinkInCommentsEnabled,
			adminBaseUrl: deps.adminBaseUrl,
			resolveAdminBaseUrl: deps.resolveAdminBaseUrl,
			resolveIssueAdminLinkInCommentsEnabled: deps.resolveIssueAdminLinkInCommentsEnabled,
		});
		this.delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			executor: deps.executor,
			defaultBranch: deps.defaultBranch,
			resolveDefaultBranch: deps.resolveDefaultBranch,
			reporter: this.reporter,
			issueAdminLinkInCommentsEnabled: deps.issueAdminLinkInCommentsEnabled,
			adminBaseUrl: deps.adminBaseUrl,
			resolveAdminBaseUrl: deps.resolveAdminBaseUrl,
			resolveIssueAdminLinkInCommentsEnabled: deps.resolveIssueAdminLinkInCommentsEnabled,
		});
		this.recovery = new PRRecovery({ github: deps.github, sessions: deps.sessions });
	}

	private resolveDefaultBranch(owner: string, repo: string): string {
		return this.deps.resolveDefaultBranch?.(owner, repo) ?? this.deps.defaultBranch ?? "main";
	}

	async run(state: SessionState, comment?: string, priorComments?: PriorDiscussionComment[]): Promise<void> {
		const { owner, repo, issueNumber } = state;
		const key = issueSessionKey(owner, repo, issueNumber);
		const abortController = new AbortController();
		let resolveSession: ((session: LiveExecutionSession) => void) | undefined;
		const sessionPromise = new Promise<LiveExecutionSession>((resolve) => {
			resolveSession = resolve;
		});
		const registration = this.deps.tasks.register(
			key,
			() => abortController.abort(),
			async (msg) => {
				const session = await Promise.race([
					sessionPromise,
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error("steer timeout")), 5000)),
				]);
				await session.steer(msg);
			},
		);

		if (registration === null) {
			const steered = comment ? await this.deps.tasks.steer(key, comment) : false;
			process.stdout.write(
				`[execute] duplicate execution ignored for ${key}${steered ? "; feedback steered to active task" : ""}\n`,
			);
			return;
		}

		try {
			await this.deps.workspaces.createOrGetWorktree(owner, repo, issueNumber);

			let current = await this.deps.sessions.get(owner, repo, issueNumber);
			if (!current) {
				throw new Error(`No session for ${key}`);
			}

			const preflightError = await this.validateSessionBeforeExecution(current);
			if (preflightError) {
				await this.failBeforeExecution(current, key, preflightError);
				return;
			}

			const syncError = await this.syncWorkspace(current);
			if (syncError) {
				await this.failBeforeExecution(current, key, syncError);
				return;
			}

			current = await this.deps.sessions.updateStatus(owner, repo, issueNumber, "working");

			const sessionStatus = current.status;
			const onActivity = () => {
				void this.deps.sessions.updateStatus(owner, repo, issueNumber, sessionStatus, {
					lastActivity: new Date().toISOString(),
				});
			};

			let result: ExecutionResult;
			let metricResult: ExecutionResult | undefined = undefined;
			try {
				current = await this.deps.sessions.updateStatus(owner, repo, issueNumber, "working", {
					taskStartedAt: new Date().toISOString(),
					taskFinishedAt: undefined,
				});
				const taskStartedAt = new Date(current.taskStartedAt!).getTime();
				const priorExecutionTimeMs = current.totalExecutionTimeMs ?? 0;
				try {
					result = await this.deps.executor.execute(
						current,
						comment,
						abortController.signal,
						(session) => {
							resolveSession?.(session);
						},
						onActivity,
						priorComments,
					);
					metricResult = result;
				} finally {
					const durationMs = Date.now() - taskStartedAt;
					current = await this.deps.sessions.updateStatus(owner, repo, issueNumber, sessionStatus, {
						taskFinishedAt: new Date().toISOString(),
						totalExecutionTimeMs: priorExecutionTimeMs + durationMs,
					});
					this.recordMetric(current, taskStartedAt, durationMs, metricResult, abortController.signal.aborted);
				}
			} catch (error) {
				if (abortController.signal.aborted) {
					process.stdout.write(`[execute] execution aborted for ${key}\n`);
					await this.deps.sessions.cancelSession(owner, repo, issueNumber);
					await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);
					await this.deps.github.addLabels(owner, repo, issueNumber, ["yolomatic-cancelled"]);
					await this.deps.github.postComment(owner, repo, issueNumber, this.withLink(owner, repo, issueNumber, "Task cancelled by admin. Yolomatic is idle."));
					return;
				}

				if (error instanceof FatalSystemError && this.deps.selfReportEnabled) {
					const issueUrl = await this.fileSelfReport(error);
					await this.deps.github.postComment(
						owner,
						repo,
						issueNumber,
						this.withLink(owner, repo, issueNumber, `⛔ Yolomatic stopped due to a fatal system error. A bug report has been filed in \`mbrooks/yolomatic\`: ${issueUrl}`),
					);
					await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed");
					await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);
					await this.deps.github.addLabels(owner, repo, issueNumber, ["yolomatic-failed"]);
					process.stdout.write(`[execute] fatal system error self-reported for ${repo}#${issueNumber}: ${issueUrl}\n`);
					return;
				}

				if (process.env.YOLO_SELF_EVOLUTION_ENABLED === "true") {
					try {
						const engine = new SelfEvolutionEngine({
							github: this.deps.github,
							repoPath: process.cwd(),
							selfReportRepo: { owner: "mbrooks", repo: "yolomatic" },
						});
						await engine.handleError(error as Error);
					} catch (seError) {
						process.stdout.write(
							`[execute] self-evolution error: ${seError instanceof Error ? seError.message : String(seError)}\n`,
						);
					}
				}

				const context = comment ? "Resuming from comment" : "Processing issue";
				await this.reporter.handleExecutionFailure({
					owner,
					repo,
					sessionIssueNumber: issueNumber,
					target: { kind: "issue", number: issueNumber },
					error,
					context,
				});
				throw error;
			}

			if (result.status === "working" && isExecutionEnvironmentBlocker(result.summary || result.rawResponse)) {
				result = {
					...result,
					status: "failed",
				};
			}

			const postExecState = await this.deps.sessions.get(owner, repo, issueNumber);
			if (postExecState?.status === "paused") {
				process.stdout.write(`[execute] ${key} paused during execution; suppressing result transitions\n`);
				return;
			}

			process.stdout.write(`[execute] result repo=${repo} issue=#${issueNumber} status=${result.status}\n`);

			if (!current.seeded && !comment) {
				await this.deps.sessions.markSeeded(owner, repo, issueNumber);
			}

			if (result.status === "complete") {
				await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);
				await this.delivery.deliverCompletion(current, result);
				return;
			}

			if (result.status === "waiting-feedback") {
				process.stdout.write(`[execute] waiting for feedback on ${repo}#${issueNumber}\n`);
			} else if (result.status === "cancelled") {
				process.stdout.write(`[execute] marked cancelled ${repo}#${issueNumber}\n`);
			} else if (result.status === "working") {
				process.stdout.write(`[execute] left in working state ${repo}#${issueNumber}\n`);
			}

			await this.reporter.handleExecutionResult({
				owner,
				repo,
				sessionIssueNumber: issueNumber,
				target: { kind: "issue", number: issueNumber },
				result,
				context: comment ? "Resuming from comment" : "Processing issue",
				state: current,
			});
		} finally {
			this.deps.tasks.unregister(key, registration);
		}
	}

	private async validateSessionBeforeExecution(state: SessionState): Promise<string | null> {
		if (!state.workspacePath.endsWith(`issue-${state.issueNumber}`)) {
			return [
				`Session ${state.owner}/${state.repo}#${state.issueNumber} points to unexpected workspace '${state.workspacePath}'.`,
				`Expected a path ending in 'issue-${state.issueNumber}'.`,
			].join(" ");
		}
		if (state.prNumber === undefined) {
			return null;
		}
		const pr = await this.deps.github.getPullRequest(state.owner, state.repo, state.prNumber);
		if (!pr) {
			return null;
		}
		return validatePRSessionMapping(state, state.prNumber, pr.head.ref);
	}

	/**
	 * Refresh the worktree from origin and ensure no credentials leak into the
	 * worker. Returns an error string when the session must not launch, or
	 * null when the workspace is ready for the worker.
	 */
	private async syncWorkspace(state: SessionState): Promise<string | null> {
		const { owner, repo, issueNumber } = state;
		const attempt = async (): Promise<string | null> => {
			try {
				await this.deps.workspaces.syncWorktree(owner, repo, issueNumber);
				return null;
			} catch (error) {
				if (error instanceof WorktreeBranchDivergedError) {
					return "diverged";
				}
				return error instanceof Error ? error.message : String(error);
			}
		};

		const firstError = await attempt();
		if (firstError === null) {
			return null;
		}
		if (firstError !== "diverged") {
			return this.formatSyncError(firstError);
		}

		// The branch diverged from origin. Reconcile the durable PR association:
		// reuse a preserved, validated PR or discover exactly one open PR with the
		// deterministic issue head/base before updating the branch.
		const defaultBranch = this.resolveDefaultBranch(owner, repo);
		const recovery = await this.recovery.recover(state, defaultBranch);
		if (!recovery.ok) {
			return this.formatSyncError(
				`Branch yolomatic/issue-${issueNumber} diverged from origin and PR recovery failed: ${recovery.reason}`,
			);
		}

		try {
			await this.deps.github.updatePullRequestBranch(owner, repo, recovery.pr.number);
		} catch (error) {
			return this.formatSyncError(
				error instanceof Error ? error.message : String(error),
			);
		}

		const retryError = await attempt();
		if (retryError === null) {
			return null;
		}
		return this.formatSyncError(retryError === "diverged" ? "Branch still diverged after update-branch." : retryError);
	}

	private formatSyncError(message: string): string {
		return [
			"Control-plane workspace sync failed for this session.",
			message,
			"",
			"Yolomatic will not launch a worker on a stale or credential-bearing workspace.",
		].join("\n");
	}

	/**
	 * Record a per-execution metric when a recorder is configured. Called from
	 * the inner `finally` so runtime is captured even when the executor throws
	 * or the run is aborted. Token usage comes from {@link ExecutionResult.usage}
	 * when the run produced a result; otherwise usage is recorded as
	 * unavailable so the dashboard can render "unknown" without breaking
	 * aggregates.
	 */
	private recordMetric(
		state: SessionState,
		taskStartedAtMs: number,
		durationMs: number,
		result: ExecutionResult | undefined,
		aborted: boolean,
	): void {
		const recorder = this.deps.metrics;
		if (!recorder) return;
		const kind = state.kind ?? "implementation";
		const status = result?.status ?? (aborted ? "cancelled" : "failed");
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
				sessionKey: sessionStorageKey(state.owner, state.repo, state.issueNumber, kind),
				owner: state.owner,
				repo: state.repo,
				issueNumber: state.issueNumber,
				kind,
				status,
				startedAt: new Date(taskStartedAtMs).toISOString(),
				finishedAt: new Date(taskStartedAtMs + durationMs).toISOString(),
				durationMs,
				tokenUsage: usage,
			});
		} catch (error) {
			// Metrics recording must never regress session execution.
			process.stdout.write(
				`[execute] metrics record failed for ${state.owner}/${state.repo}#${state.issueNumber}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}

	private async failBeforeExecution(state: SessionState, key: string, message: string): Promise<void> {
		const { owner, repo, issueNumber } = state;
		process.stdout.write(`[execute] execution blocked for ${key}: ${message}\n`);
		await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed", { summary: message });
		await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);
		await this.deps.github.addLabels(owner, repo, issueNumber, ["yolomatic-failed"]);
		await this.deps.github.postComment(
			owner,
			repo,
			issueNumber,
			this.withLink(owner, repo, issueNumber, [
				"**Yolomatic stopped before execution.**",
				"",
				message,
				"",
				"This protects the task from being handled by the wrong issue worktree.",
			].join("\n")),
		);
	}

	private adminIssueUrl(owner: string, repo: string, issueNumber: number): string | undefined {
		const adminBaseUrl = this.deps.resolveAdminBaseUrl?.() ?? this.deps.adminBaseUrl;
		const issueAdminLinkInCommentsEnabled =
			this.deps.resolveIssueAdminLinkInCommentsEnabled?.(owner, repo) ?? this.deps.issueAdminLinkInCommentsEnabled;
		return resolveAdminIssueUrl(adminBaseUrl, issueAdminLinkInCommentsEnabled, owner, repo, issueNumber);
	}

	private withLink(owner: string, repo: string, issueNumber: number, body: string): string {
		return appendAdminLink(body, this.adminIssueUrl(owner, repo, issueNumber));
	}

	private async fileSelfReport(error: FatalSystemError): Promise<string> {
		const body = SelfMonitor.formatBugReportBody(error.evidence);
		const title = SelfMonitor.getIssueTitle(error.evidence);
		return this.deps.github.fileSelfReport(title, body, ["yolomatic-self-report", "bug"]);
	}
}
