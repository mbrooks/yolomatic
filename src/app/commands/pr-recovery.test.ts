import { describe, expect, it, vi } from "vitest";

import { PRRecovery, validateRecoveryCandidate } from "./pr-recovery.js";
import type { GitHubService, PullRequestInfo } from "../../ports/github-service.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { SessionState } from "../../session/store.js";

function prInfo(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
	return {
		head: { ref: "yolomatic/issue-597" },
		base: { ref: "main" },
		state: "open",
		merged: false,
		mergeable: true,
		mergeableState: "clean",
		draft: true,
		...overrides,
	};
}

function makeGitHub(overrides: Partial<GitHubService> = {}): GitHubService {
	return {
		listPullRequests: vi.fn(async () => []),
		getPullRequest: vi.fn(async () => prInfo()),
		updatePullRequestBranch: vi.fn(),
		createPullRequest: vi.fn(),
		markPullRequestReadyForReview: vi.fn(),
		postComment: vi.fn(),
		postPRComment: vi.fn(),
		addLabels: vi.fn(),
		removeLabel: vi.fn(),
		getIssue: vi.fn(),
		createIssue: vi.fn(),
		initializeEmptyRepo: vi.fn(),
		fileSelfReport: vi.fn(),
		listReviewComments: vi.fn(),
		listLabels: vi.fn(),
		getIssueTemplates: vi.fn(),
		listRecentCommits: vi.fn(),
		listRelatedIssues: vi.fn(),
		listOpenIssues: vi.fn(),
		listPendingInvitations: vi.fn(),
		acceptInvitation: vi.fn(),
		updateIssueAssignees: vi.fn(),
		closeIssue: vi.fn(),
		updateIssueBody: vi.fn(),
		updateIssueTitle: vi.fn(),
		getAuthenticatedUser: vi.fn(),
		listAccessibleRepositories: vi.fn(),
		getRepository: vi.fn(),
		getCollaboratorPermissionLevel: vi.fn(),
		isCollaborator: vi.fn(),
		listIssueComments: vi.fn(),
		...overrides,
	} as unknown as GitHubService;
}

function makeSessions(overrides: Partial<SessionRepository> = {}): SessionRepository {
	return {
		get: vi.fn(),
		getAll: vi.fn(),
		save: vi.fn(async (s) => s),
		delete: vi.fn(),
		archive: vi.fn(),
		createSession: vi.fn(),
		updateStatus: vi.fn(async (_o, _r, _i, status, updates) => ({ ...updates, status } as SessionState)),
		markSeeded: vi.fn(),
		associatePR: vi.fn(),
		incrementIterationCount: vi.fn(),
		findSessionByPR: vi.fn(),
		cancelSession: vi.fn(),
		pauseSession: vi.fn(),
		unpauseSession: vi.fn(),
		restartSession: vi.fn(),
		markComplete: vi.fn(),
		markFailed: vi.fn(),
		markStale: vi.fn(),
		...overrides,
	} as unknown as SessionRepository;
}

function session(overrides: Partial<SessionState> = {}): SessionState {
	return {
		kind: "implementation",
		owner: "mbrooks",
		repo: "yolomatic",
		issueNumber: 597,
		title: "Recover PR",
		body: "",
		status: "pending",
		sessionPath: "/tmp/s.jsonl",
		workspacePath: "/tmp/ws/issue-597",
		lastActivity: new Date().toISOString(),
		seeded: false,
		...overrides,
	};
}

describe("validateRecoveryCandidate", () => {
	it("accepts an open, unmerged PR with the exact head and configured base", () => {
		expect(
			validateRecoveryCandidate(session({ prNumber: 605 }), 605, prInfo(), "main"),
		).toBeNull();
	});

	it("rejects a head branch for a different issue", () => {
		expect(
			validateRecoveryCandidate(session(), 605, prInfo({ head: { ref: "yolomatic/issue-598" } }), "main"),
		).toContain("not the expected");
	});

	it("rejects a PR whose base is not the configured default branch", () => {
		expect(
			validateRecoveryCandidate(session(), 605, prInfo({ base: { ref: "develop" } }), "main"),
		).toContain("configured default branch");
	});

	it("rejects a closed PR", () => {
		expect(
			validateRecoveryCandidate(session(), 605, prInfo({ state: "closed" }), "main"),
		).toContain("not open");
	});

	it("rejects a merged PR", () => {
		expect(
			validateRecoveryCandidate(session(), 605, prInfo({ merged: true }), "main"),
		).toContain("merged");
	});

	it("rejects a PR number that does not match the session association", () => {
		expect(
			validateRecoveryCandidate(session({ prNumber: 700 }), 605, prInfo(), "main"),
		).toContain("PR #700");
	});

	it("accepts a candidate when the session has no stored PR number", () => {
		expect(
			validateRecoveryCandidate(session(), 605, prInfo(), "main"),
		).toBeNull();
	});
});

describe("PRRecovery.recover", () => {
	it("reuses a preserved, valid PR association without listing", async () => {
		const github = makeGitHub();
		const sessions = makeSessions();
		const recovery = new PRRecovery({ github, sessions });
		const state = session({ prNumber: 605, prUrl: "https://github.com/mbrooks/yolomatic/pull/605" });

		const result = await recovery.recover(state, "main");

		expect(result).toEqual({
			ok: true,
			pr: { number: 605, html_url: "https://github.com/mbrooks/yolomatic/pull/605" },
			source: "preserved",
		});
		expect(github.getPullRequest).toHaveBeenCalledWith("mbrooks", "yolomatic", 605);
		expect(github.listPullRequests).not.toHaveBeenCalled();
		expect(sessions.associatePR).not.toHaveBeenCalled();
		expect(sessions.updateStatus).not.toHaveBeenCalled();
	});

	it("clears a stale preserved association (closed PR) and discovers a single valid PR", async () => {
		const github = makeGitHub({
			getPullRequest: vi.fn(async (_o, _r, n) =>
				n === 605 ? prInfo({ state: "closed" }) : prInfo(),
			),
			listPullRequests: vi.fn(async () => [
				{ number: 700, html_url: "https://github.com/mbrooks/yolomatic/pull/700" },
			]),
		});
		const sessions = makeSessions();
		const recovery = new PRRecovery({ github, sessions });
		const state = session({ prNumber: 605, prUrl: "https://github.com/mbrooks/yolomatic/pull/605" });

		const result = await recovery.recover(state, "main");

		expect(result).toEqual({
			ok: true,
			pr: { number: 700, html_url: "https://github.com/mbrooks/yolomatic/pull/700" },
			source: "discovered",
		});
		// Stale preserved association must be cleared before discovery.
		expect(sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			597,
			"pending",
			{ prNumber: undefined, prUrl: undefined },
		);
		expect(sessions.associatePR).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			597,
			700,
			"https://github.com/mbrooks/yolomatic/pull/700",
		);
	});

	it("clears a deleted preserved association (getPullRequest null) and discovers", async () => {
		const github = makeGitHub({
			getPullRequest: vi.fn(async (_o, _r, n) => (n === 605 ? null : prInfo())),
			listPullRequests: vi.fn(async () => [
				{ number: 700, html_url: "https://github.com/mbrooks/yolomatic/pull/700" },
			]),
		});
		const sessions = makeSessions();
		const recovery = new PRRecovery({ github, sessions });

		const result = await recovery.recover(session({ prNumber: 605, prUrl: "u/605" }), "main");

		expect(result).toEqual({
			ok: true,
			pr: { number: 700, html_url: "https://github.com/mbrooks/yolomatic/pull/700" },
			source: "discovered",
		});
		expect(sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			597,
			"pending",
			{ prNumber: undefined, prUrl: undefined },
		);
		expect(sessions.associatePR).toHaveBeenCalledWith("mbrooks", "yolomatic", 597, 700, "https://github.com/mbrooks/yolomatic/pull/700");
	});

	it("discovers a single valid PR when no association is stored", async () => {
		const github = makeGitHub({
			listPullRequests: vi.fn(async () => [
				{ number: 605, html_url: "https://github.com/mbrooks/yolomatic/pull/605" },
			]),
		});
		const sessions = makeSessions();
		const recovery = new PRRecovery({ github, sessions });

		const result = await recovery.recover(session(), "main");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.source).toBe("discovered");
			expect(result.pr.number).toBe(605);
		}
		expect(github.listPullRequests).toHaveBeenCalledWith("mbrooks", "yolomatic", {
			head: "mbrooks:yolomatic/issue-597",
			base: "main",
			state: "open",
		});
		expect(sessions.associatePR).toHaveBeenCalledWith("mbrooks", "yolomatic", 597, 605, "https://github.com/mbrooks/yolomatic/pull/605");
	});

	it("refuses when discovery finds zero PRs", async () => {
		const github = makeGitHub({ listPullRequests: vi.fn(async () => []) });
		const sessions = makeSessions();
		const recovery = new PRRecovery({ github, sessions });

		const result = await recovery.recover(session(), "main");

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("No open pull request");
		expect(sessions.associatePR).not.toHaveBeenCalled();
	});

	it("refuses when discovery finds multiple valid PRs", async () => {
		const github = makeGitHub({
			listPullRequests: vi.fn(async () => [
				{ number: 605, html_url: "u/605" },
				{ number: 606, html_url: "u/606" },
			]),
		});
		const sessions = makeSessions();
		const recovery = new PRRecovery({ github, sessions });

		const result = await recovery.recover(session(), "main");

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("Multiple");
		expect(sessions.associatePR).not.toHaveBeenCalled();
	});

	it("refuses when the only candidate has the wrong base branch", async () => {
		const github = makeGitHub({
			getPullRequest: vi.fn(async () => prInfo({ base: { ref: "develop" } })),
			listPullRequests: vi.fn(async () => [{ number: 605, html_url: "u/605" }]),
		});
		const recovery = new PRRecovery({ github: github, sessions: makeSessions() });

		const result = await recovery.recover(session(), "main");

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("No open pull request");
	});

	it("refuses when the only candidate is merged", async () => {
		const github = makeGitHub({
			getPullRequest: vi.fn(async () => prInfo({ merged: true, state: "closed" })),
			listPullRequests: vi.fn(async () => [{ number: 605, html_url: "u/605" }]),
		});
		const recovery = new PRRecovery({ github: github, sessions: makeSessions() });

		const result = await recovery.recover(session(), "main");

		expect(result.ok).toBe(false);
	});

	it("refuses when the only candidate has the wrong head branch", async () => {
		const github = makeGitHub({
			getPullRequest: vi.fn(async () => prInfo({ head: { ref: "yolomatic/issue-598" } })),
			listPullRequests: vi.fn(async () => [{ number: 605, html_url: "u/605" }]),
		});
		const recovery = new PRRecovery({ github: github, sessions: makeSessions() });

		const result = await recovery.recover(session(), "main");

		expect(result.ok).toBe(false);
	});
});