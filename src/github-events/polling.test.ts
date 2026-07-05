import { describe, expect, it, vi } from "vitest";

import {
	normalizePolledIssue,
	normalizePolledIssueComment,
	normalizePolledIssueTimelineEvent,
	normalizePolledPRReview,
	normalizePolledPRReviewComment,
	normalizePolledPullRequest,
	isPollingSubjectDue,
	pollingSubjectCheckIntervalMs,
	startGitHubPolling,
	stopGitHubPolling,
	tickGitHubPolling,
} from "./polling.js";
import type { GitHubEventStateStore, GitHubPollSubject } from "./model.js";

function makeStore(last: string | null, subjects: GitHubPollSubject[] = []): GitHubEventStateStore {
	return {
		getLastEventReceivedAt: vi.fn(() => last),
		initializeLastEventReceivedAt: vi.fn(),
		updateLastEventReceivedAt: vi.fn(),
		hasSeen: vi.fn(() => false),
		markSeen: vi.fn(),
		upsertPollingSubject: vi.fn(),
		listPollingSubjects: vi.fn(() => subjects),
		markPollingSubjectChecked: vi.fn(),
	};
}

import type { AccessibleRepo } from "../ports/github-service.js";

function makeGithub(overrides = {}) {
	return {
		listAccessibleRepositories: vi.fn(async () => [{ owner: "mbrooks", repo: "tars", fullName: "mbrooks/tars", visibility: "private" }] as AccessibleRepo[]),
		listIssuesUpdatedSince: vi.fn(async () => []),
		listIssueEventsSince: vi.fn(async () => []),
		listIssueCommentsSince: vi.fn(async () => []),
		listPullRequestsUpdatedSince: vi.fn(async () => []),
		listPRReviewsSince: vi.fn(async () => []),
		listPRReviewCommentsSince: vi.fn(async () => []),
		...overrides,
	};
}

describe("tickGitHubPolling", () => {
	it("computes backoff intervals from ticket idle time", () => {
		const now = new Date("2026-06-04T12:00:00.000Z");
		expect(pollingSubjectCheckIntervalMs({ lastActivityAt: "2026-06-04T11:00:00.000Z" }, now, 60000)).toBe(60000);
		expect(pollingSubjectCheckIntervalMs({ lastActivityAt: "2026-06-03T11:59:59.000Z" }, now, 60000)).toBe(15 * 60 * 1000);
		expect(pollingSubjectCheckIntervalMs({ lastActivityAt: "2026-06-01T11:59:59.000Z" }, now, 60000)).toBe(60 * 60 * 1000);
	});

	it("checks subject due status from last checked time", () => {
		const now = new Date("2026-06-04T12:00:00.000Z");
		const subject: GitHubPollSubject = {
			subjectKey: "mbrooks/tars:issue:1",
			owner: "mbrooks",
			repo: "tars",
			subjectType: "issue",
			number: 1,
			lastActivityAt: "2026-06-03T11:00:00.000Z",
			lastCheckedAt: null,
			createdAt: "2026-06-03T11:00:00.000Z",
		};
		expect(isPollingSubjectDue(subject, now, 60000)).toBe(true);
		expect(isPollingSubjectDue({ ...subject, lastCheckedAt: "2026-06-04T11:50:01.000Z" }, now, 60000)).toBe(false);
		expect(isPollingSubjectDue({ ...subject, lastCheckedAt: "2026-06-04T11:44:59.000Z" }, now, 60000)).toBe(true);
	});

	it("initializes last_event_received_at without backfilling when no timestamp exists", async () => {
		const store = makeStore(null);
		const github = makeGithub();
		await tickGitHubPolling({
			github,
			eventStore: store,
			githubUsername: "tars-bot",
			intervalMs: 60000,
			now: () => new Date("2026-06-01T12:00:00.000Z"),
			dispatch: vi.fn(),
		});

		expect(store.initializeLastEventReceivedAt).toHaveBeenCalledWith("2026-06-01T12:00:00.000Z");
		expect(github.listAccessibleRepositories).not.toHaveBeenCalled();
	});

	it("polls from the last received timestamp with a two minute overlap", async () => {
		const store = makeStore("2026-06-01T12:00:00.000Z");
		const github = makeGithub({
			listIssuesUpdatedSince: vi.fn(async () => [
				{
					number: 1,
					title: "Issue",
					body: "Body",
					state: "open",
					created_at: "2026-06-01T12:00:30.000Z",
					updated_at: "2026-06-01T12:00:30.000Z",
					labels: [],
					assignee: { login: "tars-bot" },
					assignees: [{ login: "tars-bot" }],
					user: { login: "human" },
				},
			]),
		});
		const dispatch = vi.fn(async (_event: unknown) => {});

		await tickGitHubPolling({
			github,
			eventStore: store,
			githubUsername: "tars-bot",
			intervalMs: 60000,
			dispatch,
		});

		expect(github.listIssuesUpdatedSince).toHaveBeenCalledWith("mbrooks", "tars", "2026-06-01T11:58:00.000Z");
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
			type: "issue",
			payload: expect.objectContaining({ action: "opened" }),
		}));
	});

	it("normalizes every supported polled event shape", () => {
		const issue = {
			number: 1,
			title: "Issue",
			body: "Body",
			state: "open",
			created_at: "2026-06-01T12:00:30.000Z",
			updated_at: "2026-06-01T12:00:30.000Z",
			labels: [{ name: "tars" }],
			assignee: { login: "tars-bot" },
			assignees: [{ login: "tars-bot" }],
			user: { login: "human" },
		};
		const pr = {
			number: 2,
			title: "PR",
			body: "Body",
			state: "open",
			merged: false,
			created_at: "2026-06-01T12:00:30.000Z",
			updated_at: "2026-06-01T12:00:30.000Z",
			head: { ref: "tars/issue-1" },
			user: { login: "human" },
		};

		expect(normalizePolledIssue("mbrooks", "tars", issue, "2026-06-01T12:00:00.000Z")).toEqual(expect.objectContaining({ type: "issue" }));
		expect(normalizePolledIssue("mbrooks", "tars", { ...issue, created_at: "2026-06-01T11:00:00.000Z" }, "2026-06-01T12:00:00.000Z").payload.action).toBe("edited");
		expect(normalizePolledIssueTimelineEvent("mbrooks", "tars", {
			id: 3,
			event: "assigned",
			created_at: "2026-06-01T12:00:00.000Z",
			actor: { login: "human" },
			issue,
		})).toEqual(expect.objectContaining({ type: "issue" }));
		expect(normalizePolledIssueTimelineEvent("mbrooks", "tars", {
			id: 4,
			event: "labeled",
			created_at: "2026-06-01T12:00:00.000Z",
			issue,
		})).toBeNull();
		expect(normalizePolledIssueComment("mbrooks", "tars", {
			id: 5,
			body: "Comment",
			created_at: "2026-06-01T12:00:00.000Z",
			updated_at: "2026-06-01T12:00:00.000Z",
			user: { login: "human", type: "User" },
			issue: { ...issue, pull_request: { url: "https://api.github.com/pr" } },
		})).toEqual(expect.objectContaining({ type: "issue_comment" }));
		expect(normalizePolledPullRequest("mbrooks", "tars", pr, "2026-06-01T12:00:00.000Z")).toEqual(expect.objectContaining({ type: "pull_request" }));
		expect(normalizePolledPullRequest("mbrooks", "tars", { ...pr, created_at: "2026-06-01T11:00:00.000Z" }, "2026-06-01T12:00:00.000Z").payload.action).toBe("synchronize");
		expect(normalizePolledPRReview("mbrooks", "tars", {
			id: 6,
			body: "Review",
			state: "commented",
			submitted_at: "2026-06-01T12:00:00.000Z",
			user: { login: "reviewer" },
			pull_request: pr,
		})).toEqual(expect.objectContaining({ type: "pull_request_review" }));
		expect(normalizePolledPRReviewComment("mbrooks", "tars", {
			id: 7,
			body: "Fix",
			created_at: "2026-06-01T12:00:00.000Z",
			updated_at: "2026-06-01T12:00:00.000Z",
			user: { login: "reviewer" },
			path: "src/a.ts",
			line: 1,
			pull_request: pr,
		})).toEqual(expect.objectContaining({ type: "pull_request_review_comment" }));
	});

	it("dispatches collected events oldest first and isolates repo failures", async () => {
		const store = makeStore("2026-06-01T12:00:00.000Z");
		const github = makeGithub({
			listAccessibleRepositories: vi.fn(async () => [
				{ owner: "mbrooks", repo: "bad", fullName: "mbrooks/bad", visibility: "private" },
				{ owner: "mbrooks", repo: "tars", fullName: "mbrooks/tars", visibility: "private" },
			]),
			listIssuesUpdatedSince: vi.fn(async (_owner: string, repo: string) => {
				if (repo === "bad") throw new Error("boom");
				return [{
					number: 2,
					title: "Later",
					body: "",
					state: "open",
					created_at: "2026-06-01T12:02:00.000Z",
					updated_at: "2026-06-01T12:02:00.000Z",
					labels: [],
					assignee: null,
					assignees: [],
					user: { login: "human" },
				}];
			}),
			listIssueCommentsSince: vi.fn(async () => [{
				id: 9,
				body: "Earlier",
				created_at: "2026-06-01T12:01:00.000Z",
				updated_at: "2026-06-01T12:01:00.000Z",
				user: { login: "human" },
				issue: {
					number: 1,
					title: "Issue",
					body: "",
					state: "open",
					created_at: "2026-06-01T12:00:00.000Z",
					updated_at: "2026-06-01T12:00:00.000Z",
					labels: [],
					assignee: null,
					assignees: [],
					user: { login: "human" },
				},
			}]),
		});
		const dispatch = vi.fn(async (_event: unknown) => {});

		await tickGitHubPolling({ github, eventStore: store, githubUsername: "tars-bot", intervalMs: 60000, dispatch });

		const dispatchedTypes = dispatch.mock.calls.map((call) => (call[0] as { type: string }).type);
		expect(dispatchedTypes).toEqual(["issue_comment", "issue"]);
	});

	it("continues dispatching polled events after a dispatch failure", async () => {
		const store = makeStore("2026-06-01T12:00:00.000Z");
		const github = makeGithub({
			listIssuesUpdatedSince: vi.fn(async () => [{
				number: 2,
				title: "Later",
				body: "",
				state: "open",
				created_at: "2026-06-01T12:02:00.000Z",
				updated_at: "2026-06-01T12:02:00.000Z",
				labels: [],
				assignee: null,
				assignees: [],
				user: { login: "human" },
			}]),
			listIssueCommentsSince: vi.fn(async () => [{
				id: 9,
				body: "Earlier",
				created_at: "2026-06-01T12:01:00.000Z",
				updated_at: "2026-06-01T12:01:00.000Z",
				user: { login: "human" },
				issue: {
					number: 1,
					title: "Issue",
					body: "",
					state: "open",
					created_at: "2026-06-01T12:00:00.000Z",
					updated_at: "2026-06-01T12:00:00.000Z",
					labels: [],
					assignee: null,
					assignees: [],
					user: { login: "human" },
				},
			}]),
		});
		const dispatch = vi
			.fn<(...args: unknown[]) => Promise<void>>()
			.mockRejectedValueOnce(new Error("dispatch boom"))
			.mockResolvedValueOnce();
		const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

		try {
			await tickGitHubPolling({ github, eventStore: store, githubUsername: "tars-bot", intervalMs: 60000, dispatch });

			expect(dispatch).toHaveBeenCalledTimes(2);
			expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[github-poll] dispatch failed id="));
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("checks due issue subjects and marks them checked", async () => {
		const subject: GitHubPollSubject = {
			subjectKey: "mbrooks/tars:issue:1",
			owner: "mbrooks",
			repo: "tars",
			subjectType: "issue",
			number: 1,
			lastActivityAt: "2026-06-01T12:00:00.000Z",
			lastCheckedAt: "2026-06-02T12:00:00.000Z",
			createdAt: "2026-06-01T12:00:00.000Z",
		};
		const store = makeStore("2026-06-04T12:00:00.000Z", [subject]);
		const github = makeGithub({
			listAccessibleRepositories: vi.fn(async () => []),
			listIssuesUpdatedSince: vi.fn(async () => [{
				number: 1,
				title: "Issue",
				body: "Body",
				state: "open",
				created_at: "2026-06-01T12:00:00.000Z",
				updated_at: "2026-06-04T12:00:00.000Z",
				labels: [],
				assignee: { login: "tars-bot" },
				assignees: [{ login: "tars-bot" }],
				user: { login: "human" },
			}]),
			listIssueEventsSince: vi.fn(async () => [{
				id: 2,
				event: "assigned",
				created_at: "2026-06-04T12:00:00.000Z",
				actor: { login: "human" },
				issue: {
					number: 1,
					title: "Issue",
					body: "Body",
					state: "open",
					created_at: "2026-06-01T12:00:00.000Z",
					updated_at: "2026-06-04T12:00:00.000Z",
					labels: [],
					assignee: { login: "tars-bot" },
					assignees: [{ login: "tars-bot" }],
					user: { login: "human" },
				},
			}]),
			listIssueCommentsSince: vi.fn(async () => [{
				id: 3,
				body: "Comment",
				created_at: "2026-06-04T12:00:00.000Z",
				updated_at: "2026-06-04T12:00:00.000Z",
				user: { login: "human" },
				issue: {
					number: 1,
					title: "Issue",
					body: "Body",
					state: "open",
					created_at: "2026-06-01T12:00:00.000Z",
					updated_at: "2026-06-04T12:00:00.000Z",
					labels: [],
					assignee: { login: "tars-bot" },
					assignees: [{ login: "tars-bot" }],
					user: { login: "human" },
				},
			}]),
		});
		const dispatch = vi.fn(async (_event: unknown) => {});

		await tickGitHubPolling({
			github,
			eventStore: store,
			githubUsername: "tars-bot",
			intervalMs: 60000,
			now: () => new Date("2026-06-04T12:00:00.000Z"),
			dispatch,
		});

		expect(github.listIssuesUpdatedSince).toHaveBeenCalledWith("mbrooks", "tars", "2026-06-01T11:58:00.000Z");
		expect(dispatch).toHaveBeenCalledTimes(3);
		expect(store.markPollingSubjectChecked).toHaveBeenCalledWith("mbrooks/tars:issue:1", "2026-06-04T12:00:00.000Z");
	});

	it("checks due PR subjects and ignores subjects that are not due", async () => {
		const due: GitHubPollSubject = {
			subjectKey: "mbrooks/tars:pull_request:4",
			owner: "mbrooks",
			repo: "tars",
			subjectType: "pull_request",
			number: 4,
			lastActivityAt: "2026-06-01T12:00:00.000Z",
			lastCheckedAt: "2026-06-02T12:00:00.000Z",
			createdAt: "2026-06-01T12:00:00.000Z",
		};
		const notDue: GitHubPollSubject = {
			...due,
			subjectKey: "mbrooks/tars:issue:9",
			subjectType: "issue",
			number: 9,
			lastActivityAt: "2026-06-04T11:59:00.000Z",
			lastCheckedAt: "2026-06-04T11:59:30.000Z",
		};
		const store = makeStore("2026-06-04T12:00:00.000Z", [due, notDue]);
		const pr = {
			number: 4,
			title: "PR",
			body: "Body",
			state: "open",
			merged: false,
			created_at: "2026-06-01T12:00:00.000Z",
			updated_at: "2026-06-04T12:00:00.000Z",
			head: { ref: "tars/issue-1" },
			user: { login: "human" },
		};
		const github = makeGithub({
			listAccessibleRepositories: vi.fn(async () => []),
			listPullRequestsUpdatedSince: vi.fn(async () => [pr]),
			listPRReviewsSince: vi.fn(async () => [{
				id: 5,
				body: "Review",
				state: "commented",
				submitted_at: "2026-06-04T12:00:00.000Z",
				user: { login: "reviewer" },
				pull_request: pr,
			}]),
			listPRReviewCommentsSince: vi.fn(async () => [{
				id: 6,
				body: "Fix",
				created_at: "2026-06-04T12:00:00.000Z",
				updated_at: "2026-06-04T12:00:00.000Z",
				user: { login: "reviewer" },
				pull_request: pr,
			}]),
		});
		const dispatch = vi.fn(async (_event: unknown) => {});

		await tickGitHubPolling({
			github,
			eventStore: store,
			githubUsername: "tars-bot",
			intervalMs: 60000,
			now: () => new Date("2026-06-04T12:00:00.000Z"),
			dispatch,
		});

		expect(github.listPullRequestsUpdatedSince).toHaveBeenCalledTimes(1);
		expect(github.listIssuesUpdatedSince).not.toHaveBeenCalled();
		expect(dispatch).toHaveBeenCalledTimes(3);
		expect(store.markPollingSubjectChecked).toHaveBeenCalledWith("mbrooks/tars:pull_request:4", "2026-06-04T12:00:00.000Z");
	});

	it("marks due subjects checked even when a subject check fails", async () => {
		const subject: GitHubPollSubject = {
			subjectKey: "mbrooks/tars:issue:1",
			owner: "mbrooks",
			repo: "tars",
			subjectType: "issue",
			number: 1,
			lastActivityAt: "2026-06-01T12:00:00.000Z",
			lastCheckedAt: "2026-06-02T12:00:00.000Z",
			createdAt: "2026-06-01T12:00:00.000Z",
		};
		const store = makeStore("2026-06-04T12:00:00.000Z", [subject]);
		const github = makeGithub({
			listAccessibleRepositories: vi.fn(async () => []),
			listIssuesUpdatedSince: vi.fn(async () => { throw new Error("subject failed"); }),
		});
		await tickGitHubPolling({
			github,
			eventStore: store,
			githubUsername: "tars-bot",
			intervalMs: 60000,
			now: () => new Date("2026-06-04T12:00:00.000Z"),
			dispatch: vi.fn(),
		});
		expect(store.markPollingSubjectChecked).toHaveBeenCalledWith("mbrooks/tars:issue:1", "2026-06-04T12:00:00.000Z");
	});

	it("starts and stops the polling interval", () => {
		startGitHubPolling({
			github: makeGithub(),
			eventStore: makeStore(null),
			githubUsername: "tars-bot",
			intervalMs: 60000,
			dispatch: vi.fn(),
		});
		stopGitHubPolling();
	});

	it("logs interval tick failures instead of leaking rejected promises", async () => {
		vi.useFakeTimers();
		const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const store = {
			...makeStore("2026-06-01T12:00:00.000Z"),
			getLastEventReceivedAt: vi.fn(() => {
				throw new Error("tick boom");
			}),
		};

		try {
			startGitHubPolling({
				github: makeGithub(),
				eventStore: store,
				githubUsername: "tars-bot",
				intervalMs: 1000,
				dispatch: vi.fn(),
			});

			await vi.advanceTimersByTimeAsync(1000);

			expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[github-poll] tick failed: tick boom"));
		} finally {
			stopGitHubPolling();
			writeSpy.mockRestore();
			vi.useRealTimers();
		}
	});
});
