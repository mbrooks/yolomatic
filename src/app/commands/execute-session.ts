import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { ExecutionService } from "../../ports/execution-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { Clock } from "../../ports/clock.js";
import type { ExecutionResult } from "../../executor/index.js";
import type { SessionState } from "../../session/store.js";
import { FatalSystemError, SelfMonitor } from "../../self-monitor/index.js";
import { SelfEvolutionEngine } from "../../self-evolution/index.js";
import { validatePRSessionMapping } from "../../pr-review/session-invariant.js";
import { issueSessionKey, removeWorkflowLabels } from "./workflow-helpers.js";
import { ExecuteSessionDelivery } from "./execute-session-delivery.js";
import { ExecuteSessionReporter } from "./execute-session-reporter.js";

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
}

export class ExecuteSession {
	private readonly reporter: ExecuteSessionReporter;
	private readonly delivery: ExecuteSessionDelivery;

	constructor(private readonly deps: ExecuteSessionDeps) {
		this.reporter = new ExecuteSessionReporter({
			github: deps.github,
			workspaces: deps.workspaces,
			sessions: deps.sessions,
			selfReportEnabled: deps.selfReportEnabled,
		});
		this.delivery = new ExecuteSessionDelivery({
			sessions: deps.sessions,
			workspaces: deps.workspaces,
			github: deps.github,
			defaultBranch: deps.defaultBranch,
			resolveDefaultBranch: deps.resolveDefaultBranch,
			reporter: this.reporter,
		});
	}

	async run(state: SessionState, comment?: string): Promise<void> {
		const { owner, repo, issueNumber } = state;
		const key = issueSessionKey(owner, repo, issueNumber);

		await this.deps.workspaces.createOrGetWorktree(owner, repo, issueNumber);

		let current = await this.deps.sessions.get(owner, repo, issueNumber);
		if (!current) {
			throw new Error(`No session for ${key}`);
		}

		const preflightError = await this.validateSessionBeforeExecution(current);
		if (preflightError) {
			process.stdout.write(`[execute] execution blocked for ${key}: ${preflightError}\n`);
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed", { summary: preflightError });
			await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-failed"]);
			await this.deps.github.postComment(
				owner,
				repo,
				issueNumber,
				[
					"**TARS stopped before execution.**",
					"",
					preflightError,
					"",
					"This protects the task from being handled by the wrong issue worktree.",
				].join("\n"),
			);
			return;
		}

		current = await this.deps.sessions.updateStatus(owner, repo, issueNumber, "working");

		const abortController = new AbortController();
		let resolveSession: ((session: AgentSession) => void) | undefined;
		const sessionPromise = new Promise<AgentSession>((resolve) => {
			resolveSession = resolve;
		});

		this.deps.tasks.register(
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

		const sessionStatus = current.status;
		const onActivity = () => {
			void this.deps.sessions.updateStatus(owner, repo, issueNumber, sessionStatus, {
				lastActivity: new Date().toISOString(),
			});
		};

		let result: ExecutionResult;
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
				);
			} finally {
				const durationMs = Date.now() - taskStartedAt;
				current = await this.deps.sessions.updateStatus(owner, repo, issueNumber, sessionStatus, {
					taskFinishedAt: new Date().toISOString(),
					totalExecutionTimeMs: priorExecutionTimeMs + durationMs,
				});
			}
		} catch (error) {
			if (abortController.signal.aborted) {
				process.stdout.write(`[execute] execution aborted for ${key}\n`);
				await this.deps.sessions.cancelSession(owner, repo, issueNumber);
				await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);
				await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-cancelled"]);
				await this.deps.github.postComment(owner, repo, issueNumber, "Task cancelled by admin. TARS is idle.");
				return;
			}

			if (error instanceof FatalSystemError && this.deps.selfReportEnabled) {
				const issueUrl = await this.fileSelfReport(error);
				await this.deps.github.postComment(
					owner,
					repo,
					issueNumber,
					`⛔ TARS stopped due to a fatal system error. A bug report has been filed in \`mbrooks/tars\`: ${issueUrl}`,
				);
				await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed");
				await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);
				await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-failed"]);
				process.stdout.write(`[execute] fatal system error self-reported for ${repo}#${issueNumber}: ${issueUrl}\n`);
				return;
			}

			if (process.env.TARS_SELF_EVOLUTION_ENABLED === "true") {
				try {
					const engine = new SelfEvolutionEngine({
						github: this.deps.github,
						repoPath: process.cwd(),
						selfReportRepo: { owner: "mbrooks", repo: "tars" },
					});
					await engine.handleError(error as Error);
				} catch (seError) {
					process.stdout.write(
						`[execute] self-evolution error: ${seError instanceof Error ? seError.message : String(seError)}\n`,
					);
				}
			}

			const context = comment ? "Resuming from comment" : "Processing issue";
			await this.reporter.postFailureComment(owner, repo, issueNumber, error, context);
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed");
			await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-failed"]);
			throw error;
		} finally {
			this.deps.tasks.unregister(key);
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

		await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);

		if (result.status === "waiting-feedback") {
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "waiting-feedback");
			process.stdout.write(`[execute] waiting for feedback on ${repo}#${issueNumber}\n`);
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-feedback-required"]);
			await this.deps.github.postComment(
				owner,
				repo,
				issueNumber,
				[
					"Need clarification:",
					result.summary || "TARS needs more information before continuing.",
				].join("\n\n"),
			);
			return;
		}

		if (result.status === "complete") {
			await this.delivery.deliverCompletion(current, result);
			return;
		}

		if (result.status === "cancelled") {
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "cancelled");
			process.stdout.write(`[execute] marked cancelled ${repo}#${issueNumber}\n`);
			await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-cancelled"]);
			await this.deps.github.postComment(
				owner,
				repo,
				issueNumber,
				[
					"Task cancelled by admin.",
					"",
					result.summary || "TARS has stopped working on this issue.",
					"",
					"TARS is idle and ready for the next task.",
				].join("\n"),
			);
			return;
		}

		if (result.status === "failed") {
			const context = comment ? "Resuming from comment" : "Processing issue";
			await this.reporter.postFailureComment(owner, repo, issueNumber, new Error(result.summary), context);
			await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed");
			await removeWorkflowLabels(this.deps.github, owner, repo, issueNumber);
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-failed"]);
			return;
		}

		await this.deps.sessions.updateStatus(owner, repo, issueNumber, "working");
		process.stdout.write(`[execute] left in working state ${repo}#${issueNumber}\n`);
		await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-working"]);
		await this.deps.github.postComment(
			owner,
			repo,
			issueNumber,
			[
				"TARS is still working on this issue.",
				"",
				result.summary || "Execution is in progress.",
			].join("\n"),
		);
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

	private async fileSelfReport(error: FatalSystemError): Promise<string> {
		const body = SelfMonitor.formatBugReportBody(error.evidence);
		const title = SelfMonitor.getIssueTitle(error.evidence);
		return this.deps.github.fileSelfReport(title, body, ["tars-self-report", "bug"]);
	}
}
