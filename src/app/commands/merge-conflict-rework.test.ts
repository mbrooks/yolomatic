import { describe, expect, it, vi } from "vitest";

import { MergeConflictReworkService } from "./merge-conflict-rework.js";
import type { ExecutionResult } from "../../executor/index.js";
import type { SessionState } from "../../session/store.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { ExecutionService } from "../../ports/execution-service.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";

const state: SessionState = {
	owner: "mbrooks",
	repo: "yolomatic",
	issueNumber: 7,
	title: "Title",
	body: "Body",
	status: "working",
	sessionPath: "/tmp/session.jsonl",
	workspacePath: "/tmp/ws/.worktrees/issue-7",
	lastActivity: new Date().toISOString(),
	seeded: true,
	branch: "yolomatic/issue-7",
};

function makeDeps(overrides?: {
	getPullRequest?: () => Promise<import("../../ports/github-service.js").PullRequestInfo | null>;
	execute?: () => Promise<ExecutionResult>;
	commitAndPushPath?: () => Promise<boolean>;
	getGitStatus?: () => Promise<string>;
}) {
	const github = {
		getPullRequest: overrides?.getPullRequest
			? vi.fn(overrides.getPullRequest)
			: vi.fn(async () => ({
					head: { ref: "yolomatic/issue-7", sha: "sha" },
					state: "open",
					merged: false,
					mergeable: true,
					mergeableState: "clean",
					draft: false,
				})),
		markPullRequestReadyForReview: vi.fn(async () => undefined),
	} as unknown as GitHubService & {
		getPullRequest: ReturnType<typeof vi.fn>;
		markPullRequestReadyForReview: ReturnType<typeof vi.fn>;
	};
	const executor = {
		execute: overrides?.execute
			? vi.fn(overrides.execute)
			: vi.fn(async (): Promise<ExecutionResult> => ({
					status: "complete",
					summary: "Rebased.",
					rawResponse: "YOLO_STATUS: complete\nRebased.",
				})),
	} as unknown as ExecutionService & { execute: ReturnType<typeof vi.fn> };
	const workspaces = {
		commitAndPushPath: overrides?.commitAndPushPath
			? vi.fn(overrides.commitAndPushPath)
			: vi.fn(async () => true),
		getGitStatus: overrides?.getGitStatus
			? vi.fn(overrides.getGitStatus)
			: vi.fn(async () => ""),
	} as unknown as WorkspaceService & {
		commitAndPushPath: ReturnType<typeof vi.fn>;
		getGitStatus: ReturnType<typeof vi.fn>;
	};
	return { github, executor, workspaces };
}

function makeService(deps: ReturnType<typeof makeDeps>, opts?: { maxConflictAttempts?: number; mergeabilityPollMaxAttempts?: number }) {
	return new MergeConflictReworkService({
		github: deps.github,
		executor: deps.executor,
		workspaces: deps.workspaces,
		mergeabilityPollDelayMs: 0,
		mergeabilityPollMaxAttempts: opts?.mergeabilityPollMaxAttempts ?? 5,
		maxConflictAttempts: opts?.maxConflictAttempts ?? 2,
	});
}

describe("MergeConflictReworkService", () => {
	describe("hasConflicts", () => {
		it("treats mergeable=false or mergeableState=dirty as a conflict", () => {
			const service = makeService(makeDeps());
			expect(service.hasConflicts({ head: { ref: "x" }, state: "open", merged: false, mergeable: false })).toBe(true);
			expect(service.hasConflicts({ head: { ref: "x" }, state: "open", merged: false, mergeableState: "dirty" })).toBe(true);
		});

		it("treats mergeable=true / clean as not a conflict", () => {
			const service = makeService(makeDeps());
			expect(service.hasConflicts({ head: { ref: "x" }, state: "open", merged: false, mergeable: true, mergeableState: "clean" })).toBe(false);
		});
	});

	describe("pollMergeability", () => {
		it("polls while mergeable is null and returns the first non-null info", async () => {
			const calls = [
				{ head: { ref: "x" }, state: "open", merged: false, mergeable: null as boolean | null, mergeableState: "unknown" },
				{ head: { ref: "x" }, state: "open", merged: false, mergeable: null as boolean | null, mergeableState: "unknown" },
				{ head: { ref: "x" }, state: "open", merged: false, mergeable: true, mergeableState: "clean" },
			];
			let i = 0;
			const deps = makeDeps({
				getPullRequest: async () => calls[Math.min(i++, calls.length - 1)] as never,
			});
			const service = makeService(deps);
			const info = await service.pollMergeability("mbrooks", "yolomatic", 7);
			expect(info?.mergeable).toBe(true);
			expect(deps.github.getPullRequest).toHaveBeenCalledTimes(3);
		});

		it("returns the last info when polling exhausts attempts", async () => {
			const deps = makeDeps({
				getPullRequest: async () => ({ head: { ref: "x" }, state: "open", merged: false, mergeable: null as boolean | null, mergeableState: "unknown" }),
			});
			const service = makeService(deps, { mergeabilityPollMaxAttempts: 2 });
			const info = await service.pollMergeability("mbrooks", "yolomatic", 7);
			expect(info?.mergeable).toBeNull();
			expect(deps.github.getPullRequest).toHaveBeenCalledTimes(2);
		});

		it("returns null when getPullRequest returns null", async () => {
			const deps = makeDeps({ getPullRequest: async () => null });
			const service = makeService(deps);
			expect(await service.pollMergeability("mbrooks", "yolomatic", 7)).toBeNull();
		});
	});

	describe("markReadyIfDraft", () => {
		it("marks the PR ready only when draft is true", async () => {
			const deps = makeDeps();
			const service = makeService(deps);
			await service.markReadyIfDraft("mbrooks", "yolomatic", 7, { head: { ref: "x" }, state: "open", merged: false, draft: true });
			expect(deps.github.markPullRequestReadyForReview).toHaveBeenCalledWith("mbrooks", "yolomatic", 7);
			(deps.github.markPullRequestReadyForReview as ReturnType<typeof vi.fn>).mockClear();
			await service.markReadyIfDraft("mbrooks", "yolomatic", 7, { head: { ref: "x" }, state: "open", merged: false, draft: false });
			expect(deps.github.markPullRequestReadyForReview).not.toHaveBeenCalled();
		});
	});

	describe("listConflictedFiles", () => {
		it("extracts unmerged file paths from git status", async () => {
			const deps = makeDeps({
				getGitStatus: async () => "UU src/a.ts\nDD src/b.ts\n M src/c.ts\n",
			});
			const service = makeService(deps);
			expect(await service.listConflictedFiles("mbrooks", "yolomatic", 7)).toEqual(["src/a.ts", "src/b.ts"]);
		});

		it("returns an empty list when status read fails", async () => {
			const deps = makeDeps({
				getGitStatus: async () => {
					throw new Error("boom");
				},
			});
			const service = makeService(deps);
			expect(await service.listConflictedFiles("mbrooks", "yolomatic", 7)).toEqual([]);
		});
	});

	describe("runConflictRework", () => {
		it("steers the worker with a rebase prompt and pushes the rebased branch", async () => {
			const deps = makeDeps();
			const service = makeService(deps);
			const pushed = await service.runConflictRework("mbrooks", "yolomatic", 7, 42, state, 1, 2);
			expect(pushed).toBe(true);
			expect(deps.executor.execute).toHaveBeenCalledWith(state, expect.stringContaining("git rebase origin/main"));
			expect(deps.workspaces.commitAndPushPath).toHaveBeenCalledWith(
				state.workspacePath,
				"yolomatic/issue-7",
				expect.any(String),
				undefined,
				"sha",
			);
		});

		it("returns false when the worker fails", async () => {
			const deps = makeDeps({
				execute: async () => ({ status: "failed", summary: "nope", rawResponse: "YOLO_STATUS: failed\nnope" }),
				commitAndPushPath: async () => true,
			});
			const service = makeService(deps);
			expect(await service.runConflictRework("mbrooks", "yolomatic", 7, 42, state, 1, 2)).toBe(false);
			expect(deps.workspaces.commitAndPushPath).not.toHaveBeenCalled();
		});

		it("returns false when the push fails", async () => {
			const deps = makeDeps({ commitAndPushPath: async () => false });
			const service = makeService(deps);
			expect(await service.runConflictRework("mbrooks", "yolomatic", 7, 42, state, 1, 2)).toBe(false);
		});

		it("returns false when the worker is cancelled", async () => {
			const deps = makeDeps({
				execute: async () => ({ status: "cancelled", summary: "", rawResponse: "YOLO_STATUS: cancelled" }),
			});
			const service = makeService(deps);
			expect(await service.runConflictRework("mbrooks", "yolomatic", 7, 42, state, 1, 2)).toBe(false);
		});
	});

	describe("resolveConflicts", () => {
		it("is a no-op when the PR is already mergeable", async () => {
			const deps = makeDeps({
				getPullRequest: async () => ({ head: { ref: "yolomatic/issue-7", sha: "sha" }, state: "open", merged: false, mergeable: true, mergeableState: "clean", draft: false }),
			});
			const service = makeService(deps);
			const result = await service.resolveConflicts("mbrooks", "yolomatic", 7, 42, state);
			expect(result.outcome).toBe("clean");
			expect(result.attempts).toBe(0);
			expect(deps.executor.execute).not.toHaveBeenCalled();
		});

		it("rebases and re-checks until mergeable", async () => {
			const mergeable = [false, false, true];
			let i = 0;
			const deps = makeDeps({
				getPullRequest: async () => ({
					head: { ref: "yolomatic/issue-7", sha: "sha" },
					state: "open",
					merged: false,
					mergeable: mergeable[Math.min(i++, mergeable.length - 1)],
					mergeableState: mergeable[Math.min(i > 0 ? i - 1 : 0, mergeable.length - 1)] ? "clean" : "dirty",
					draft: false,
				}),
			});
			const service = makeService(deps);
			const result = await service.resolveConflicts("mbrooks", "yolomatic", 7, 42, state);
			expect(result.outcome).toBe("clean");
			expect(result.attempts).toBe(1);
			expect(deps.executor.execute).toHaveBeenCalledTimes(1);
		});

		it("fails after maxConflictAttempts when conflicts persist", async () => {
			const deps = makeDeps({
				getPullRequest: async () => ({
					head: { ref: "yolomatic/issue-7", sha: "sha" },
					state: "open",
					merged: false,
					mergeable: false,
					mergeableState: "dirty",
					draft: false,
				}),
				getGitStatus: async () => "UU src/conflicted.ts",
			});
			const service = makeService(deps, { maxConflictAttempts: 2 });
			const result = await service.resolveConflicts("mbrooks", "yolomatic", 7, 42, state);
			expect(result.outcome).toBe("conflict-failed");
			expect(result.attempts).toBe(2);
			expect(result.conflictedFiles).toEqual(["src/conflicted.ts"]);
		});

		it("fails when mergeability cannot be computed", async () => {
			const deps = makeDeps({
				getPullRequest: async () => ({ head: { ref: "yolomatic/issue-7", sha: "sha" }, state: "open", merged: false, mergeable: null, mergeableState: "unknown", draft: false }),
			});
			const service = makeService(deps, { mergeabilityPollMaxAttempts: 2 });
			const result = await service.resolveConflicts("mbrooks", "yolomatic", 7, 42, state);
			expect(result.outcome).toBe("unknown-mergeability");
			expect(result.attempts).toBe(0);
		});

		it("marks the PR ready when the rework produces a clean draft", async () => {
			const mergeable = [false, true];
			let i = 0;
			const deps = makeDeps({
				getPullRequest: async () => ({
					head: { ref: "yolomatic/issue-7", sha: "sha" },
					state: "open",
					merged: false,
					mergeable: mergeable[Math.min(i++, mergeable.length - 1)],
					mergeableState: mergeable[Math.min(i > 0 ? i - 1 : 0, mergeable.length - 1)] ? "clean" : "dirty",
					draft: true,
				}),
			});
			const service = makeService(deps);
			await service.resolveConflicts("mbrooks", "yolomatic", 7, 42, state);
			expect(deps.github.markPullRequestReadyForReview).toHaveBeenCalledWith("mbrooks", "yolomatic", 42);
		});
	});
});