import type { Clock } from "../../../ports/clock.js";
import type { MetricsRecorder } from "../../../ports/metrics-recorder.js";
import type { SessionRepository } from "../../../ports/session-repository.js";
import type { RefinementStore, RefinementTokenUsage } from "../../../refinement/store.js";
import type { RefinementResult } from "../../../executor/index.js";
import type { TokenUsage } from "../../../executor/usage.js";
import type { RefinementSkillInfo } from "./skill-resolver.js";
import { sessionStorageKey } from "../../../session/store.js";

/**
 * Owned transitions and cleanup for a refinement run. The orchestration
 * façade delegates session status transitions, attempt state transitions, and
 * the terminal cleanup (metrics, attempt usage, and terminal-state repair)
 * here so the repeated failure/stale completion paths are centralized. Each
 * method preserves the historical comment text, stored reasons, and
 * transition ordering. Worktree removal stays in the façade's `finally` so it
 * runs after task unregister/in-flight clear, matching the historical order.
 */
export class RefinementLifecycle {
	constructor(
		private readonly deps: {
			refinementStore: RefinementStore;
			sessions: SessionRepository;
			clock: Clock;
			metrics?: MetricsRecorder;
		},
	) {}

	markAttemptStale(attemptId: string, reason: string): void {
		this.deps.refinementStore.updateAttempt(attemptId, { state: "stale", failureReason: reason });
	}

	markAttemptFailed(attemptId: string, reason: string): void {
		this.deps.refinementStore.updateAttempt(attemptId, { state: "failed", failureReason: reason });
	}

	markAttemptApplied(attemptId: string): void {
		this.deps.refinementStore.updateAttempt(attemptId, { state: "applied" });
	}

	recordAttemptResult(attemptId: string, result: RefinementResult): void {
		this.deps.refinementStore.updateAttempt(attemptId, {
			proposedTaskBody: result.proposedTaskBody,
			proposedTitle: result.proposedTitle,
			summary: result.summary,
			investigation: result.investigation,
		});
	}

	setAttemptSource(attemptId: string, skill: RefinementSkillInfo): void {
		this.deps.refinementStore.updateAttempt(attemptId, {
			instructionSource: skill.source,
			repoCommit: skill.commit,
		});
	}

	async failSession(owner: string, repo: string, issueNumber: number, reason: string): Promise<void> {
		await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed", {
			summary: reason,
			staleReason: reason,
			taskFinishedAt: this.deps.clock.now().toISOString(),
		}, "refinement");
	}

	async completeSession(owner: string, repo: string, issueNumber: number, summary: string): Promise<void> {
		await this.deps.sessions.updateStatus(owner, repo, issueNumber, "complete", {
			summary,
			taskFinishedAt: this.deps.clock.now().toISOString(),
		}, "refinement");
	}

	async setSessionWorkspace(owner: string, repo: string, issueNumber: number, workspacePath: string): Promise<void> {
		await this.deps.sessions.updateStatus(owner, repo, issueNumber, "working", {
			workspacePath,
		}, "refinement");
	}

	async setSessionSummary(owner: string, repo: string, issueNumber: number, summary: string): Promise<void> {
		await this.deps.sessions.updateStatus(owner, repo, issueNumber, "working", {
			summary,
		}, "refinement");
	}

	async ensureTerminalSession(owner: string, repo: string, issueNumber: number): Promise<void> {
		const session = await this.deps.sessions.get(owner, repo, issueNumber, "refinement");
		if (session?.kind === "refinement" && session.status === "working") {
			await this.failSession(owner, repo, issueNumber, "refinement ended without a terminal outcome");
		}
	}

	async cleanup(input: {
		owner: string;
		repo: string;
		issueNumber: number;
		attemptId: string | undefined;
		taskStartedAtMs: number;
		metricStatus: string;
		result: { usage?: TokenUsage } | undefined;
	}): Promise<void> {
		this.recordMetric(input);
		this.recordAttemptUsage(input.attemptId, input.taskStartedAtMs, input.result);
		await this.ensureTerminalSession(input.owner, input.repo, input.issueNumber);
	}

	private recordMetric(input: {
		owner: string;
		repo: string;
		issueNumber: number;
		taskStartedAtMs: number;
		metricStatus: string;
		result: { usage?: TokenUsage } | undefined;
	}): void {
		const recorder = this.deps.metrics;
		if (!recorder) return;
		const durationMs = this.deps.clock.now().getTime() - input.taskStartedAtMs;
		const usage = input.result?.usage ?? {
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
				sessionKey: sessionStorageKey(input.owner, input.repo, input.issueNumber, "refinement"),
				owner: input.owner,
				repo: input.repo,
				issueNumber: input.issueNumber,
				kind: "refinement",
				status: input.metricStatus,
				startedAt: new Date(input.taskStartedAtMs).toISOString(),
				finishedAt: new Date(input.taskStartedAtMs + durationMs).toISOString(),
				durationMs,
				tokenUsage: usage,
			});
		} catch (error) {
			process.stdout.write(
				`[refinement] metrics record failed for ${input.owner}/${input.repo}#${input.issueNumber}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}

	private recordAttemptUsage(
		attemptId: string | undefined,
		taskStartedAtMs: number,
		result: { usage?: TokenUsage } | undefined,
	): void {
		if (!attemptId) return;
		const durationMs = this.deps.clock.now().getTime() - taskStartedAtMs;
		const usage = result?.usage;
		const tokenUsage: RefinementTokenUsage = usage
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
}