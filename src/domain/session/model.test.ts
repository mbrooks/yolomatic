import { describe, expect, it } from "vitest";
import {
	sessionKey,
	branchName,
	detectSessionRisk,
	buildRepoSummaries,
	computeAgentStatus,
	isTerminalStatus,
	sortSessionsByRecency,
	type SessionState,
} from "./model.js";

function makeSession(partial: Partial<SessionState> & { owner: string; repo: string; issueNumber: number }): SessionState {
	return {
		title: "Title",
		body: "Body",
		status: "pending" as const,
		sessionPath: "/tmp/session.jsonl",
		workspacePath: `/tmp/workspaces/${partial.owner}-${partial.repo}/.worktrees/issue-${partial.issueNumber}`,
		lastActivity: new Date().toISOString(),
		seeded: false,
		...partial,
	};
}

describe("sessionKey", () => {
	it("formats owner/repo#issueNumber", () => {
		expect(sessionKey("mbrooks", "tars", 42)).toBe("mbrooks/tars#42");
	});
});

describe("branchName", () => {
	it("formats yeetomatic/issue-N", () => {
		expect(branchName(42)).toBe("yeetomatic/issue-42");
	});
});

describe("compatibility re-exports", () => {
	it("keeps isTerminalStatus available from the domain model module", () => {
		expect(isTerminalStatus("complete")).toBe(true);
		expect(isTerminalStatus("working")).toBe(false);
	});
});

describe("detectSessionRisk", () => {
	it("returns no risk for a normal session", () => {
		const session = makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 42, title: "Fix bug", body: "Description" });
		const risk = detectSessionRisk(session);
		expect(risk.suspectedMisroute).toBe(false);
		expect(risk.reasons).toHaveLength(0);
	});

	it("flags PR-shaped title", () => {
		const session = makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 42, title: "Yeetomatic: Fix bug" });
		const risk = detectSessionRisk(session);
		expect(risk.suspectedMisroute).toBe(true);
		expect(risk.reasons).toContain("Session title looks like a generated PR title.");
	});

	it("flags body referencing a different issue", () => {
		const session = makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 42, body: "Fixes #99" });
		const risk = detectSessionRisk(session);
		expect(risk.suspectedMisroute).toBe(true);
		expect(risk.reasons).toContain("Session body references issue #99.");
		expect(risk.referencedIssueNumber).toBe(99);
	});

	it("allows body referencing the same issue", () => {
		const session = makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 42, body: "Fixes #42" });
		const risk = detectSessionRisk(session);
		expect(risk.suspectedMisroute).toBe(false);
		expect(risk.referencedIssueNumber).toBe(42);
	});
});

describe("buildRepoSummaries", () => {
	it("groups sessions by repo and counts active", () => {
		const sessions = [
			makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 1, status: "working" }),
			makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 2, status: "complete" }),
			makeSession({ owner: "mbrooks", repo: "case", issueNumber: 3, status: "pending" }),
		];
		const summaries = buildRepoSummaries(sessions);
		expect(summaries).toHaveLength(2);
		expect(summaries[0]).toEqual({ owner: "mbrooks", repo: "case", sessionCount: 1, activeCount: 1, lastActivity: expect.any(String) });
		expect(summaries[1]).toEqual({ owner: "mbrooks", repo: "tars", sessionCount: 2, activeCount: 1, lastActivity: expect.any(String) });
	});

	it("counts first terminal session as inactive", () => {
		const sessions = [makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 1, status: "complete" })];
		const summaries = buildRepoSummaries(sessions);
		expect(summaries[0]).toEqual({ owner: "mbrooks", repo: "tars", sessionCount: 1, activeCount: 0, lastActivity: expect.any(String) });
	});

	it("returns empty array for no sessions", () => {
		expect(buildRepoSummaries([])).toEqual([]);
	});
});

describe("computeAgentStatus", () => {
	it("returns busy when any session is working", () => {
		const sessions = [
			makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 1, status: "working" }),
			makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 2, status: "pending" }),
		];
		expect(computeAgentStatus(sessions)).toBe("busy");
	});

	it("returns feedback when no working but feedback exists", () => {
		const sessions = [
			makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 1, status: "waiting-feedback" }),
			makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 2, status: "complete" }),
		];
		expect(computeAgentStatus(sessions)).toBe("feedback");
	});

	it("returns online when all are terminal or pending", () => {
		const sessions = [
			makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 1, status: "pending" }),
			makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 2, status: "complete" }),
		];
		expect(computeAgentStatus(sessions)).toBe("online");
	});
});

describe("sortSessionsByRecency", () => {
	it("sorts by createdAt descending when available", () => {
		const sessions = [
			makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 1, createdAt: "2026-01-01T00:00:00Z" }),
			makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 2, createdAt: "2026-01-03T00:00:00Z" }),
			makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 3, createdAt: "2026-01-02T00:00:00Z" }),
		];
		const sorted = sortSessionsByRecency(sessions);
		expect(sorted.map((s) => s.issueNumber)).toEqual([2, 3, 1]);
	});

	it("falls back to lastActivity when createdAt is missing", () => {
		const sessions = [
			makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 1, lastActivity: "2026-01-01T00:00:00Z" }),
			makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 2, lastActivity: "2026-01-03T00:00:00Z" }),
		];
		const sorted = sortSessionsByRecency(sessions);
		expect(sorted.map((s) => s.issueNumber)).toEqual([2, 1]);
	});
});
