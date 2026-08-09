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
		getRepoPollBaseline: vi.fn(() => null),
		setRepoPollBaseline: vi.fn(),
	};
}

function makeStatefulStore(last: string | null): GitHubEventStateStore {
	let lastReceivedAt = last;
	const baselines = new Map<string, string>();
	return {
		getLastEventReceivedAt: () => lastReceivedAt,
		initializeLastEventReceivedAt: (value: string) => {
			if (!lastReceivedAt) lastReceivedAt = value;
		},
		updateLastEventReceivedAt: (value: string) => {
			lastReceivedAt = value;
		},
		hasSeen: () => false,
		markSeen: () => {},
		upsertPollingSubject: () => {},
		listPollingSubjects: () => [],
		markPollingSubjectChecked: () => {},
		getRepoPollBaseline: (owner, repo) => baselines.get(`${owner}/${repo}`) ?? null,
		setRepoPollBaseline: (owner, repo, value) => {
			baselines.set(`${owner}/${repo}`, value);
		},
	};
}

import type { AccessibleRepo } from "../ports/github-service.js";

function makeGithub(overrides = {}) {
	return {
		listAccessibleRepositories: vi.fn(async () => [{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" }] as AccessibleRepo[]),
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
			subjectKey: "mbrooks/yolomatic:issue:1",
			owner: "mbrooks",
			repo: "yolomatic",
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
			githubUsername: "yolomatic-bot",
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
					assignee: { login: "yolomatic-bot" },
					assignees: [{ login: "yolomatic-bot" }],
					user: { login: "human" },
				},
			]),
		});
		const dispatch = vi.fn(async (_event: unknown) => {});

		await tickGitHubPolling({
			github,
			eventStore: store,
			githubUsername: "yolomatic-bot",
			intervalMs: 60000,
			dispatch,
		});

		expect(github.listIssuesUpdatedSince).toHaveBeenCalledWith("mbrooks", "yolomatic", "2026-06-01T11:58:00.000Z");
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
			type: "issue",
			payload: expect.objectContaining({ action: "opened" }),
		}));
	});

	it("iterates over listManagedRepos instead of github.listAccessibleRepositories when provided", async () => {
		const store = makeStore("2026-06-01T12:00:00.000Z");
		const github = makeGithub();
		const listManagedRepos = vi.fn(async () => [
			{ owner: "managed", repo: "repo" },
		]);
		const dispatch = vi.fn(async () => {});

		await tickGitHubPolling({
			github,
			eventStore: store,
			githubUsername: "yolomatic-bot",
			intervalMs: 60000,
			listManagedRepos,
			dispatch,
		});

		expect(listManagedRepos).toHaveBeenCalledTimes(1);
		expect(github.listAccessibleRepositories).not.toHaveBeenCalled();
		expect(github.listIssuesUpdatedSince).toHaveBeenCalledWith("managed", "repo", expect.any(String));
	});

	it("normalizes every supported polled event shape", () => {
		const issue = {
			number: 1,
			title: "Issue",
			body: "Body",
			state: "open",
			created_at: "2026-06-01T12:00:30.000Z",
			updated_at: "2026-06-01T12:00:30.000Z",
			labels: [{ name: "yolomatic" }],
			assignee: { login: "yolomatic-bot" },
			assignees: [{ login: "yolomatic-bot" }],
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
			head: { ref: "yolomatic/issue-1" },
			user: { login: "human" },
		};

		expect(normalizePolledIssue("mbrooks", "yolomatic", issue, "2026-06-01T12:00:00.000Z")).toEqual(expect.objectContaining({ type: "issue" }));
		expect(normalizePolledIssue("mbrooks", "yolomatic", { ...issue, created_at: "2026-06-01T11:00:00.000Z" }, "2026-06-01T12:00:00.000Z").payload.action).toBe("edited");
		expect(normalizePolledIssueTimelineEvent("mbrooks", "yolomatic", {
			id: 3,
			event: "assigned",
			created_at: "2026-06-01T12:00:00.000Z",
			actor: { login: "human" },
			issue,
		})).toEqual(expect.objectContaining({ type: "issue" }));
		expect(normalizePolledIssueTimelineEvent("mbrooks", "yolomatic", {
			id: 4,
			event: "labeled",
			created_at: "2026-06-01T12:00:00.000Z",
			issue,
		})).toBeNull();
		expect(normalizePolledIssueComment("mbrooks", "yolomatic", {
			id: 5,
			body: "Comment",
			created_at: "2026-06-01T12:00:00.000Z",
			updated_at: "2026-06-01T12:00:00.000Z",
			user: { login: "human", type: "User" },
			issue: { ...issue, pull_request: { url: "https://api.github.com/pr" } },
		})).toEqual(expect.objectContaining({ type: "issue_comment" }));
		expect(normalizePolledPullRequest("mbrooks", "yolomatic", pr, "2026-06-01T12:00:00.000Z")).toEqual(expect.objectContaining({ type: "pull_request" }));
		expect(normalizePolledPullRequest("mbrooks", "yolomatic", { ...pr, created_at: "2026-06-01T11:00:00.000Z" }, "2026-06-01T12:00:00.000Z").payload.action).toBe("synchronize");
		expect(normalizePolledPRReview("mbrooks", "yolomatic", {
			id: 6,
			body: "Review",
			state: "commented",
			submitted_at: "2026-06-01T12:00:00.000Z",
			user: { login: "reviewer" },
			pull_request: pr,
		})).toEqual(expect.objectContaining({ type: "pull_request_review" }));
		expect(normalizePolledPRReviewComment("mbrooks", "yolomatic", {
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
				{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" },
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

		await tickGitHubPolling({ github, eventStore: store, githubUsername: "yolomatic-bot", intervalMs: 60000, dispatch });

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
			await tickGitHubPolling({ github, eventStore: store, githubUsername: "yolomatic-bot", intervalMs: 60000, dispatch });

			expect(dispatch).toHaveBeenCalledTimes(2);
			expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[github-poll] dispatch failed id="));
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("checks due issue subjects and marks them checked", async () => {
		const subject: GitHubPollSubject = {
			subjectKey: "mbrooks/yolomatic:issue:1",
			owner: "mbrooks",
			repo: "yolomatic",
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
				assignee: { login: "yolomatic-bot" },
				assignees: [{ login: "yolomatic-bot" }],
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
					assignee: { login: "yolomatic-bot" },
					assignees: [{ login: "yolomatic-bot" }],
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
					assignee: { login: "yolomatic-bot" },
					assignees: [{ login: "yolomatic-bot" }],
					user: { login: "human" },
				},
			}]),
		});
		const dispatch = vi.fn(async (_event: unknown) => {});

		await tickGitHubPolling({
			github,
			eventStore: store,
			githubUsername: "yolomatic-bot",
			intervalMs: 60000,
			now: () => new Date("2026-06-04T12:00:00.000Z"),
			dispatch,
		});

		expect(github.listIssuesUpdatedSince).toHaveBeenCalledWith("mbrooks", "yolomatic", "2026-06-01T11:58:00.000Z");
		expect(dispatch).toHaveBeenCalledTimes(3);
		expect(store.markPollingSubjectChecked).toHaveBeenCalledWith("mbrooks/yolomatic:issue:1", "2026-06-04T12:00:00.000Z");
	});

	it("checks due PR subjects and ignores subjects that are not due", async () => {
		const due: GitHubPollSubject = {
			subjectKey: "mbrooks/yolomatic:pull_request:4",
			owner: "mbrooks",
			repo: "yolomatic",
			subjectType: "pull_request",
			number: 4,
			lastActivityAt: "2026-06-01T12:00:00.000Z",
			lastCheckedAt: "2026-06-02T12:00:00.000Z",
			createdAt: "2026-06-01T12:00:00.000Z",
		};
		const notDue: GitHubPollSubject = {
			...due,
			subjectKey: "mbrooks/yolomatic:issue:9",
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
			head: { ref: "yolomatic/issue-1" },
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
			githubUsername: "yolomatic-bot",
			intervalMs: 60000,
			now: () => new Date("2026-06-04T12:00:00.000Z"),
			dispatch,
		});

		expect(github.listPullRequestsUpdatedSince).toHaveBeenCalledTimes(1);
		expect(github.listIssuesUpdatedSince).not.toHaveBeenCalled();
		expect(dispatch).toHaveBeenCalledTimes(3);
		expect(store.markPollingSubjectChecked).toHaveBeenCalledWith("mbrooks/yolomatic:pull_request:4", "2026-06-04T12:00:00.000Z");
	});

	it("marks due subjects checked even when a subject check fails", async () => {
		const subject: GitHubPollSubject = {
			subjectKey: "mbrooks/yolomatic:issue:1",
			owner: "mbrooks",
			repo: "yolomatic",
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
			githubUsername: "yolomatic-bot",
			intervalMs: 60000,
			now: () => new Date("2026-06-04T12:00:00.000Z"),
			dispatch: vi.fn(),
		});
		expect(store.markPollingSubjectChecked).toHaveBeenCalledWith("mbrooks/yolomatic:issue:1", "2026-06-04T12:00:00.000Z");
	});

	it("starts and stops the polling interval", () => {
		startGitHubPolling({
			github: makeGithub(),
			eventStore: makeStore(null),
			githubUsername: "yolomatic-bot",
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
				githubUsername: "yolomatic-bot",
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

	it("logs tick start, per-repo checks, and tick completion summary", async () => {
		const store = makeStore("2026-06-01T12:00:00.000Z");
		const github = makeGithub({
			listAccessibleRepositories: vi.fn(async () => [
				{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" },
			]),
		});
		const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const now = new Date("2026-06-01T12:00:00.000Z");

		try {
			await tickGitHubPolling({
				github,
				eventStore: store,
				githubUsername: "yolomatic-bot",
				intervalMs: 60000,
				now: () => now,
				dispatch: vi.fn(),
			});

			expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[github-poll] tick started at 2026-06-01T12:00:00.000Z\n"));
			expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[github-poll] checking mbrooks/yolomatic (lastEventReceivedAt=2026-06-01T12:00:00.000Z, since=2026-06-01T11:58:00.000Z)\n"));
			expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[github-poll] tick completed: 0 events dispatched\n"));
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("logs initialization and completion when no last_event_received_at exists", async () => {
		const store = makeStore(null);
		const github = makeGithub();
		const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

		try {
			await tickGitHubPolling({
				github,
				eventStore: store,
				githubUsername: "yolomatic-bot",
				intervalMs: 60000,
				now: () => new Date("2026-06-01T12:00:00.000Z"),
				dispatch: vi.fn(),
			});

			expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[github-poll] tick started at 2026-06-01T12:00:00.000Z\n"));
			expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[github-poll] initialized last_event_received_at=2026-06-01T12:00:00.000Z\n"));
			expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[github-poll] tick completed: 0 events dispatched\n"));
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("logs effective interval when checking due polling subjects", async () => {
		const subject: GitHubPollSubject = {
			subjectKey: "mbrooks/yolomatic:issue:1",
			owner: "mbrooks",
			repo: "yolomatic",
			subjectType: "issue",
			number: 1,
			lastActivityAt: "2026-06-01T12:00:00.000Z",
			lastCheckedAt: "2026-06-02T12:00:00.000Z",
			createdAt: "2026-06-01T12:00:00.000Z",
		};
		const store = makeStore("2026-06-04T12:00:00.000Z", [subject]);
		const github = makeGithub({
			listAccessibleRepositories: vi.fn(async () => []),
			listIssuesUpdatedSince: vi.fn(async () => []),
			listIssueEventsSince: vi.fn(async () => []),
			listIssueCommentsSince: vi.fn(async () => []),
		});
		const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

		try {
			await tickGitHubPolling({
				github,
				eventStore: store,
				githubUsername: "yolomatic-bot",
				intervalMs: 60000,
				now: () => new Date("2026-06-04T12:00:00.000Z"),
				dispatch: vi.fn(),
			});

			expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[github-poll] checking subject mbrooks/yolomatic:issue:1 (effective interval=3600000ms)\n"));
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("initializes a per-repo polling baseline the first time a repo is checked", async () => {
		const store = makeStore("2026-06-01T12:00:00.000Z");
		const github = makeGithub({
			listAccessibleRepositories: vi.fn(async () => [
				{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" },
			]),
			listIssuesUpdatedSince: vi.fn(async () => []),
		});
		const now = new Date("2026-06-01T12:05:00.000Z");

		await tickGitHubPolling({
			github,
			eventStore: store,
			githubUsername: "yolomatic-bot",
			intervalMs: 60000,
			now: () => now,
			dispatch: vi.fn(),
		});

		expect(store.setRepoPollBaseline).toHaveBeenCalledWith("mbrooks", "yolomatic", now.toISOString());
		expect(store.getRepoPollBaseline).toHaveBeenCalledWith("mbrooks", "yolomatic");
	});

	it("does not reinitialize the per-repo baseline once it exists", async () => {
		const store = makeStore("2026-06-01T12:00:00.000Z");
		store.getRepoPollBaseline = vi.fn(() => "2026-06-01T12:00:00.000Z");
		const github = makeGithub({
			listAccessibleRepositories: vi.fn(async () => [
				{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" },
			]),
			listIssuesUpdatedSince: vi.fn(async () => []),
		});

		await tickGitHubPolling({
			github,
			eventStore: store,
			githubUsername: "yolomatic-bot",
			intervalMs: 60000,
			dispatch: vi.fn(),
		});

		expect(store.setRepoPollBaseline).not.toHaveBeenCalled();
	});

	it("gates the static instruction comment with a per-repo polling baseline", async () => {
		const store = makeStatefulStore("2026-06-01T12:00:00.000Z");
		const preExisting = {
			number: 1,
			title: "Old issue",
			body: "Body",
			state: "open",
			created_at: "2026-05-01T12:00:00.000Z",
			updated_at: "2026-06-01T12:00:30.000Z",
			labels: [],
			assignee: null,
			assignees: [],
			user: { login: "human" },
		};
		const github = makeGithub({
			listAccessibleRepositories: vi.fn(async () => [
				{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" },
			]),
			listIssuesUpdatedSince: vi.fn(async () => [preExisting]),
		});
		const firstTickNow = new Date("2026-06-01T12:05:00.000Z");
		const firstDispatch = vi.fn(async (_event: unknown) => {});

		await tickGitHubPolling({
			github,
			eventStore: store,
			githubUsername: "yolomatic-bot",
			intervalMs: 60000,
			now: () => firstTickNow,
			dispatch: firstDispatch,
		});

		// Pre-existing issue is normalized as edited, so it cannot trigger the
		// new-issue static instruction comment.
		expect(firstDispatch).toHaveBeenCalledWith(expect.objectContaining({
			type: "issue",
			payload: expect.objectContaining({ action: "edited" }),
		}));
		expect(firstDispatch).not.toHaveBeenCalledWith(expect.objectContaining({
			type: "issue",
			payload: expect.objectContaining({ action: "opened" }),
		}));
		expect(store.getRepoPollBaseline?.("mbrooks", "yolomatic")).toBe(firstTickNow.toISOString());

		// Second tick sees a newly opened issue. Because the repo baseline is
		// now set, the issue is eligible for the static instruction comment.
		const newIssue = {
			...preExisting,
			number: 2,
			title: "New issue",
			created_at: "2026-06-01T12:10:00.000Z",
			updated_at: "2026-06-01T12:10:00.000Z",
		};
		github.listIssuesUpdatedSince = vi.fn(async () => [newIssue]);
		const secondDispatch = vi.fn(async (_event: unknown) => {});
		const secondTickNow = new Date("2026-06-01T12:15:00.000Z");

		await tickGitHubPolling({
			github,
			eventStore: store,
			githubUsername: "yolomatic-bot",
			intervalMs: 60000,
			now: () => secondTickNow,
			dispatch: secondDispatch,
		});

		expect(secondDispatch).toHaveBeenCalledWith(expect.objectContaining({
			type: "issue",
			payload: expect.objectContaining({ action: "opened" }),
		}));
	});

	it("includes created_at in normalized polled issue payloads", () => {
		const issue = {
			number: 1,
			title: "Issue",
			body: "Body",
			state: "open",
			created_at: "2026-06-01T12:00:30.000Z",
			updated_at: "2026-06-01T12:00:30.000Z",
			labels: [],
			assignee: null,
			assignees: [],
			user: { login: "human" },
		};
		const event = normalizePolledIssue("mbrooks", "yolomatic", issue, "2026-06-01T12:00:00.000Z");
		expect((event.payload as { issue: { created_at: string } }).issue.created_at).toBe("2026-06-01T12:00:30.000Z");
	});

	describe("startGitHubPolling startup logging", () => {
		it("logs polled and skipped repositories with their effective mode", async () => {
			vi.useFakeTimers();
			const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			const github = makeGithub({
				listAccessibleRepositories: vi.fn(async () => [
					{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" },
					{ owner: "mbrooks", repo: "webhook-only", fullName: "mbrooks/webhook-only", visibility: "private" },
				] as AccessibleRepo[]),
			});

			try {
				startGitHubPolling({
					github,
					eventStore: makeStore("2026-06-01T12:00:00.000Z"),
					githubUsername: "yolomatic-bot",
					intervalMs: 60000,
					resolveGitHubEventMode: (owner, repo) => (repo === "webhook-only" ? "webhook" : "both"),
					dispatch: vi.fn(),
				});
				await vi.advanceTimersByTimeAsync(0);

				expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[github-poll] Starting GitHub polling (base interval=60000ms)\n"));
				expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[github-poll] polling mbrooks/yolomatic (mode=both, base interval=60000ms)\n"));
				expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[github-poll] skipping mbrooks/webhook-only (mode=webhook)\n"));
			} finally {
				stopGitHubPolling();
				writeSpy.mockRestore();
				vi.useRealTimers();
			}
		});

		it("defaults to polling mode when no resolver is provided", async () => {
			vi.useFakeTimers();
			const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			try {
				startGitHubPolling({
					github: makeGithub(),
					eventStore: makeStore(null),
					githubUsername: "yolomatic-bot",
					intervalMs: 60000,
					dispatch: vi.fn(),
				});
				await vi.advanceTimersByTimeAsync(0);

				expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[github-poll] polling mbrooks/yolomatic (mode=polling, base interval=60000ms)\n"));
			} finally {
				stopGitHubPolling();
				writeSpy.mockRestore();
				vi.useRealTimers();
			}
		});

		it("logs a startup failure when listing repositories throws", async () => {
			vi.useFakeTimers();
			const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			const github = makeGithub({
				listAccessibleRepositories: vi.fn(async () => { throw new Error("startup boom"); }),
			});

			try {
				startGitHubPolling({
					github,
					eventStore: makeStore(null),
					githubUsername: "yolomatic-bot",
					intervalMs: 60000,
					resolveGitHubEventMode: () => "polling",
					dispatch: vi.fn(),
				});
				await vi.advanceTimersByTimeAsync(0);

				expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[github-poll] failed to enumerate repositories at startup: startup boom\n"));
			} finally {
				stopGitHubPolling();
				writeSpy.mockRestore();
				vi.useRealTimers();
			}
		});
	});
});
