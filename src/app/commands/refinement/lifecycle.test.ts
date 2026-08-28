import { describe, expect, it, beforeEach, vi } from "vitest";
import { RefinementLifecycle } from "./lifecycle.js";
import type { RefinementStore } from "../../../refinement/store.js";
import type { SessionRepository } from "../../../ports/session-repository.js";
import type { MetricsRecorder } from "../../../ports/metrics-recorder.js";
import type { Clock } from "../../../ports/clock.js";
import type { RefinementResult } from "../../../executor/index.js";

describe("RefinementLifecycle", () => {
	let store: ReturnType<typeof createStoreMock>;
	let sessions: ReturnType<typeof createSessionsMock>;
	let clock: Clock;
	let lifecycle: RefinementLifecycle;

	beforeEach(() => {
		store = createStoreMock();
		sessions = createSessionsMock();
		clock = { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 };
		lifecycle = new RefinementLifecycle({
			refinementStore: store as unknown as RefinementStore,
			sessions: sessions as unknown as SessionRepository,
			clock,
		});
	});

	it("marks an attempt stale with the stored reason", () => {
		lifecycle.markAttemptStale("att-1", "issue body changed during refinement");
		expect(store.updateAttempt).toHaveBeenCalledWith("att-1", {
			state: "stale",
			failureReason: "issue body changed during refinement",
		});
	});

	it("marks an attempt failed with the stored reason", () => {
		lifecycle.markAttemptFailed("att-1", "worker crashed");
		expect(store.updateAttempt).toHaveBeenCalledWith("att-1", {
			state: "failed",
			failureReason: "worker crashed",
		});
	});

	it("marks an attempt applied", () => {
		lifecycle.markAttemptApplied("att-1");
		expect(store.updateAttempt).toHaveBeenCalledWith("att-1", { state: "applied" });
	});

	it("records the worker result on the attempt", () => {
		const result: RefinementResult = {
			proposedTaskBody: "Body",
			summary: "Summary",
			investigation: "Investigation",
			proposedTitle: "Title",
		};
		lifecycle.recordAttemptResult("att-1", result);
		expect(store.updateAttempt).toHaveBeenCalledWith("att-1", {
			proposedTaskBody: "Body",
			proposedTitle: "Title",
			summary: "Summary",
			investigation: "Investigation",
		});
	});

	it("sets the attempt instruction source and commit from resolved skill", () => {
		lifecycle.setAttemptSource("att-1", {
			source: "repository-skill",
			content: "skill body",
			commit: "abc123",
		});
		expect(store.updateAttempt).toHaveBeenCalledWith("att-1", {
			instructionSource: "repository-skill",
			repoCommit: "abc123",
		});
	});

	it("sets the attempt source to prompt-defaults when no skill was found", () => {
		lifecycle.setAttemptSource("att-1", { source: "prompt-defaults", commit: "abc123" });
		expect(store.updateAttempt).toHaveBeenCalledWith("att-1", {
			instructionSource: "prompt-defaults",
			repoCommit: "abc123",
		});
	});

	it("fails the session with a reason and finished timestamp", async () => {
		await lifecycle.failSession("mbrooks", "yolomatic", 1, "issue is no longer open");
		expect(sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks", "yolomatic", 1, "failed",
			{
				summary: "issue is no longer open",
				staleReason: "issue is no longer open",
				taskFinishedAt: "2026-08-01T00:00:00.000Z",
			},
			"refinement",
		);
	});

	it("completes the session with the summary and finished timestamp", async () => {
		await lifecycle.completeSession("mbrooks", "yolomatic", 1, "Summary");
		expect(sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks", "yolomatic", 1, "complete",
			{
				summary: "Summary",
				taskFinishedAt: "2026-08-01T00:00:00.000Z",
			},
			"refinement",
		);
	});

	it("sets the session workspace path while staying in working status", async () => {
		await lifecycle.setSessionWorkspace("mbrooks", "yolomatic", 1, "/tmp/worktree");
		expect(sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks", "yolomatic", 1, "working",
			{ workspacePath: "/tmp/worktree" },
			"refinement",
		);
	});

	it("sets the session summary while staying in working status", async () => {
		await lifecycle.setSessionSummary("mbrooks", "yolomatic", 1, "Summary");
		expect(sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks", "yolomatic", 1, "working",
			{ summary: "Summary" },
			"refinement",
		);
	});

	it("repairs a working session to a terminal failure", async () => {
		sessions.get.mockResolvedValueOnce({ kind: "refinement", status: "working" });
		await lifecycle.ensureTerminalSession("mbrooks", "yolomatic", 1);
		expect(sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks", "yolomatic", 1, "failed",
			expect.objectContaining({
				summary: "refinement ended without a terminal outcome",
				staleReason: "refinement ended without a terminal outcome",
			}),
			"refinement",
		);
	});

	it("leaves an already-terminal session untouched", async () => {
		sessions.get.mockResolvedValueOnce({ kind: "refinement", status: "complete" });
		await lifecycle.ensureTerminalSession("mbrooks", "yolomatic", 1);
		expect(sessions.updateStatus).not.toHaveBeenCalled();
	});

	it("leaves a missing session untouched", async () => {
		sessions.get.mockResolvedValueOnce(null);
		await lifecycle.ensureTerminalSession("mbrooks", "yolomatic", 1);
		expect(sessions.updateStatus).not.toHaveBeenCalled();
	});

	it("cleanup records usage/metrics and ensures terminal state", async () => {
		sessions.get.mockResolvedValueOnce({ kind: "refinement", status: "complete" });
		const metrics = { record: vi.fn() } as unknown as MetricsRecorder;
		lifecycle = new RefinementLifecycle({
			refinementStore: store as unknown as RefinementStore,
			sessions: sessions as unknown as SessionRepository,
			clock,
			metrics,
		});
		const result: RefinementResult = {
			proposedTaskBody: "Body",
			summary: "Summary",
			investigation: "Investigation",
			usage: { available: true, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0.1 },
		};

		await lifecycle.cleanup({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 1,
			attemptId: "att-1",
			taskStartedAtMs: 0,
			metricStatus: "complete",
			result,
		});

		expect(store.updateAttempt).toHaveBeenCalledWith("att-1", expect.objectContaining({
			runtimeMs: expect.any(Number),
			tokenUsage: expect.objectContaining({ available: true, totalTokens: 2 }),
		}));
		expect(metrics.record).toHaveBeenCalledOnce();
		expect(sessions.get).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "refinement");
	});

	it("cleanup records unavailable token usage when the worker returned no result", async () => {
		sessions.get.mockResolvedValueOnce({ kind: "refinement", status: "failed" });
		await lifecycle.cleanup({
			owner: "mbrooks", repo: "yolomatic", issueNumber: 1,
			attemptId: "att-1", taskStartedAtMs: 0, metricStatus: "failed",
			result: undefined,
		});
		expect(store.updateAttempt).toHaveBeenCalledWith("att-1", expect.objectContaining({
			tokenUsage: { available: false, input: 0, output: 0, totalTokens: 0, cost: 0 },
		}));
	});

	it("cleanup repairs a working session to a terminal failure", async () => {
		sessions.get.mockResolvedValueOnce({ kind: "refinement", status: "working" });
		await lifecycle.cleanup({
			owner: "mbrooks", repo: "yolomatic", issueNumber: 1,
			attemptId: "att-1", taskStartedAtMs: 0, metricStatus: "failed",
			result: undefined,
		});
		expect(sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks", "yolomatic", 1, "failed",
			expect.objectContaining({ summary: "refinement ended without a terminal outcome" }),
			"refinement",
		);
	});

	it("cleanup skips attempt usage when no attempt was created", async () => {
		sessions.get.mockResolvedValueOnce({ kind: "refinement", status: "failed" });
		await lifecycle.cleanup({
			owner: "mbrooks", repo: "yolomatic", issueNumber: 1,
			attemptId: undefined, taskStartedAtMs: 0, metricStatus: "failed",
			result: undefined,
		});
		expect(store.updateAttempt).not.toHaveBeenCalled();
	});

	it("cleanup still records attempt usage when metrics recording throws", async () => {
		sessions.get.mockResolvedValueOnce({ kind: "refinement", status: "failed" });
		const metrics = { record: vi.fn(() => { throw new Error("boom"); }) } as unknown as MetricsRecorder;
		lifecycle = new RefinementLifecycle({
			refinementStore: store as unknown as RefinementStore,
			sessions: sessions as unknown as SessionRepository,
			clock,
			metrics,
		});
		await lifecycle.cleanup({
			owner: "mbrooks", repo: "yolomatic", issueNumber: 1,
			attemptId: "att-1", taskStartedAtMs: 0, metricStatus: "failed",
			result: undefined,
		});
		expect(store.updateAttempt).toHaveBeenCalledWith("att-1", expect.objectContaining({
			tokenUsage: { available: false, input: 0, output: 0, totalTokens: 0, cost: 0 },
		}));
	});

	function createStoreMock() {
		return {
			createAttempt: vi.fn((input: Record<string, unknown>) => ({ id: "att-1", ...input })),
			updateAttempt: vi.fn(),
			getLatestAttempt: vi.fn(() => null),
		};
	}

	function createSessionsMock() {
		return {
			get: vi.fn(async (): Promise<unknown> => null),
			updateStatus: vi.fn(async (_o: string, _r: string, _n: number, _s: string, _u: unknown, _k: string) => ({})),
		};
	}
});