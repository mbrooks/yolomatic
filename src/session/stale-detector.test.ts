import { describe, expect, it, vi } from "vitest";
import { StaleSessionDetector } from "./stale-detector.js";
import { createOctokit } from "../adapters/github/octokit.js";
import type { SessionState } from "./store.js";

vi.mock("../adapters/github/octokit.js", () => ({
	createOctokit: vi.fn(() => ({
		issues: {
			get: vi.fn(async () => ({ data: { state: "open" } })),
		},
		pulls: {
			get: vi.fn(async () => ({ data: { state: "open", merged: false } })),
		},
	})),
}));

function makeSession(partial: Partial<SessionState> & { owner: string; repo: string; issueNumber: number }): SessionState {
	return {
		title: "Title",
		body: "Body",
		status: "working" as const,
		sessionPath: "/tmp/session.jsonl",
		workspacePath: "/tmp/ws",
		lastActivity: new Date(Date.now() - 100_000).toISOString(),
		seeded: false,
		...partial,
	};
}

function makeDetector(options: {
	sessions?: SessionState[];
	hasChanges?: boolean | (() => Promise<boolean>);
	isInFlight?: boolean;
	thresholdMs?: number;
	issueState?: string;
	prState?: string;
	prMerged?: boolean;
	issueError?: boolean;
	prError?: boolean;
} = {}) {
	const {
		sessions = [],
		hasChanges = false,
		isInFlight = false,
		thresholdMs = 1000,
		issueState = "open",
		prState = "open",
		prMerged = false,
		issueError = false,
		prError = false,
	} = options;

	const sessionStore = {
		getAll: vi.fn(async () => sessions),
	} as unknown as import("./store.js").SessionStore;

	const workspaceManager = {
		hasChanges: vi.fn(typeof hasChanges === "function" ? hasChanges : async () => hasChanges),
	} as unknown as import("../workspace/manager.js").WorkspaceManager;

	vi.mocked(createOctokit).mockReturnValue({
		issues: {
			get: issueError
				? vi.fn(async () => {
						throw new Error("issue fetch failed");
				  })
				: vi.fn(async () => ({ data: { state: issueState } })),
		},
		pulls: {
			get: prError
				? vi.fn(async () => {
						throw new Error("pr fetch failed");
				  })
				: vi.fn(async () => ({ data: { state: prState, merged: prMerged } })),
		},
	} as never);

	return new StaleSessionDetector(
		sessionStore,
		workspaceManager,
		"fake-token",
		() => isInFlight,
		thresholdMs,
	);
}

describe("StaleSessionDetector", () => {
	it("skips non-working sessions", async () => {
		const detector = makeDetector({
			sessions: [makeSession({ owner: "mbrooks", repo: "yeetomatic", issueNumber: 1, status: "pending" })],
		});

		const result = await detector.detectStaleSessions();
		expect(result[0].isStale).toBe(false);
		expect(result[0].classification).toBe("unknown");
	});

	it("skips in-flight sessions", async () => {
		const detector = makeDetector({
			sessions: [makeSession({ owner: "mbrooks", repo: "yeetomatic", issueNumber: 1, status: "working" })],
			isInFlight: true,
		});

		const result = await detector.detectStaleSessions();
		expect(result[0].isStale).toBe(false);
		expect(result[0].classification).toBe("unknown");
	});

	it("does not classify working refinement sessions as stale", async () => {
		const detector = makeDetector({
			sessions: [
				makeSession({
					kind: "refinement",
					owner: "mbrooks",
					repo: "yeetomatic",
					issueNumber: 1,
					status: "working",
				}),
			],
			thresholdMs: 1,
		});

		const result = await detector.detectStaleSessions();

		expect(result[0]).toMatchObject({ isStale: false, classification: "unknown", worktreeDirty: null });
	});

	it("marks sessions below the threshold as not stale", async () => {
		const detector = makeDetector({
			sessions: [makeSession({ owner: "mbrooks", repo: "yeetomatic", issueNumber: 1, status: "working" })],
			thresholdMs: 1_000_000,
		});

		const result = await detector.detectStaleSessions();
		expect(result[0].isStale).toBe(false);
		expect(result[0].classification).toBe("unknown");
	});

	it("classifies stale sessions with dirty worktrees as needs-review", async () => {
		const detector = makeDetector({
			sessions: [makeSession({ owner: "mbrooks", repo: "yeetomatic", issueNumber: 1, status: "working" })],
			hasChanges: true,
			thresholdMs: 1,
		});

		const result = await detector.detectStaleSessions();
		expect(result[0].isStale).toBe(true);
		expect(result[0].worktreeDirty).toBe(true);
		expect(result[0].classification).toBe("needs-review");
	});

	it("classifies closed issue + merged PR as stale-complete-candidate", async () => {
		const detector = makeDetector({
			sessions: [
				makeSession({ owner: "mbrooks", repo: "yeetomatic", issueNumber: 1, status: "working", prNumber: 10, prUrl: "url" }),
			],
			thresholdMs: 1,
			issueState: "closed",
			prState: "closed",
			prMerged: true,
		});

		const result = await detector.detectStaleSessions();
		expect(result[0].classification).toBe("stale-complete-candidate");
	});

	it("classifies missing/closed issue + closed PR as stale-abandoned-candidate", async () => {
		const detector = makeDetector({
			sessions: [
				makeSession({ owner: "mbrooks", repo: "yeetomatic", issueNumber: 1, status: "working", prNumber: 10, prUrl: "url" }),
			],
			thresholdMs: 1,
			issueState: "closed",
			prState: "closed",
			prMerged: false,
		});

		const result = await detector.detectStaleSessions();
		expect(result[0].classification).toBe("stale-abandoned-candidate");
	});

	it("classifies clean worktree with closed issue as safe-to-archive", async () => {
		const detector = makeDetector({
			sessions: [makeSession({ owner: "mbrooks", repo: "yeetomatic", issueNumber: 1, status: "working" })],
			thresholdMs: 1,
			hasChanges: false,
			issueState: "closed",
		});

		const result = await detector.detectStaleSessions();
		expect(result[0].worktreeDirty).toBe(false);
		expect(result[0].classification).toBe("safe-to-archive");
	});

	it("handles worktree hasChanges errors gracefully", async () => {
		const detector = makeDetector({
			sessions: [makeSession({ owner: "mbrooks", repo: "yeetomatic", issueNumber: 1, status: "working" })],
			thresholdMs: 1,
			hasChanges: async () => {
				throw new Error("git error");
			},
		});

		const result = await detector.detectStaleSessions();
		expect(result[0].worktreeDirty).toBeNull();
	});

	it("handles missing issue state", async () => {
		const detector = makeDetector({
			sessions: [makeSession({ owner: "mbrooks", repo: "yeetomatic", issueNumber: 1, status: "working" })],
			thresholdMs: 1,
			hasChanges: true,
			issueError: true,
		});

		const result = await detector.detectStaleSessions();
		expect(result[0].issueState).toBe("missing");
		expect(result[0].classification).toBe("needs-review");
	});

	it("handles missing pr state", async () => {
		const detector = makeDetector({
			sessions: [
				makeSession({ owner: "mbrooks", repo: "yeetomatic", issueNumber: 1, status: "working", prNumber: 10, prUrl: "url" }),
			],
			thresholdMs: 1,
			hasChanges: true,
			prError: true,
		});

		const result = await detector.detectStaleSessions();
		expect(result[0].prState).toBe("missing");
		expect(result[0].classification).toBe("needs-review");
	});
});
