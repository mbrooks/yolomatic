import { describe, expect, it, vi } from "vitest";
import { ExecutionServiceAdapter } from "./execution-service-adapter.js";
import type { ExecutionResult, PiAgentExecutor, PRReviewComment } from "../../executor/index.js";
import type { SessionState } from "../../session/store.js";

describe("ExecutionServiceAdapter", () => {
	it("delegates execute to the executor", async () => {
		const mockResult: ExecutionResult = { status: "complete", summary: "Done.", rawResponse: "TARS_STATUS: complete\nDone." };
		const executor = {
			execute: vi.fn(async () => mockResult),
			executePRReview: vi.fn(),
		} as unknown as PiAgentExecutor;

		const adapter = new ExecutionServiceAdapter(executor);
		const state = {
			owner: "mbrooks",
			repo: "tars",
			issueNumber: 1,
			title: "Test",
			body: "Body",
			status: "working",
			sessionPath: "/tmp/session.jsonl",
			workspacePath: "/tmp/ws/.worktrees/issue-1",
			lastActivity: new Date().toISOString(),
			seeded: false,
		} as SessionState;

		const result = await adapter.execute(state, "comment");

		expect(executor.execute).toHaveBeenCalledWith(state, "comment", undefined, undefined, undefined, undefined, undefined);
		expect(result).toBe(mockResult);
	});

	it("delegates executePRReview to the executor", async () => {
		const mockResult: ExecutionResult = { status: "complete", summary: "Done.", rawResponse: "TARS_STATUS: complete\nDone." };
		const executor = {
			execute: vi.fn(async () => mockResult),
			executePRReview: vi.fn(),
		} as unknown as PiAgentExecutor;

		const adapter = new ExecutionServiceAdapter(executor);
		const state = {
			owner: "mbrooks",
			repo: "tars",
			issueNumber: 1,
			title: "Test",
			body: "Body",
			status: "working",
			sessionPath: "/tmp/session.jsonl",
			workspacePath: "/tmp/ws/.worktrees/issue-1",
			lastActivity: new Date().toISOString(),
			seeded: false,
		} as SessionState;

		const prReview = { comments: [{ body: "Fix", user: "reviewer" } as PRReviewComment], reviewBody: "Review" };
		const result = await adapter.executePRReview(state, prReview);

		expect(executor.execute).toHaveBeenCalledWith(state, undefined, prReview, undefined, undefined, undefined, undefined);
		expect(result).toBe(mockResult);
	});
});
