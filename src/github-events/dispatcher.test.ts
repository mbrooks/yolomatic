import { describe, expect, it, vi } from "vitest";

import { GitHubEventDispatcher, pollingSubjectFromEvent } from "./dispatcher.js";
import type { GitHubEventStateStore } from "./model.js";

function makeStore(overrides: Partial<GitHubEventStateStore> = {}): GitHubEventStateStore {
	return {
		getLastEventReceivedAt: vi.fn(() => null),
		initializeLastEventReceivedAt: vi.fn(),
		updateLastEventReceivedAt: vi.fn(),
		hasSeen: vi.fn(() => false),
		markSeen: vi.fn(),
		upsertPollingSubject: vi.fn(),
		listPollingSubjects: vi.fn(() => []),
		markPollingSubjectChecked: vi.fn(),
		...overrides,
	};
}

describe("GitHubEventDispatcher", () => {
	it("routes issue events and records receive time after successful dispatch", async () => {
		const store = makeStore();
		const handleIssueEvent = { execute: vi.fn(async () => {}) };
		const dispatcher = new GitHubEventDispatcher({
			handleIssueEvent: handleIssueEvent as never,
			handleIssueComment: { execute: vi.fn() } as never,
			handlePRReview: { execute: vi.fn() } as never,
			eventStore: store,
			githubUsername: "yeetomatic-bot",
		});

		await dispatcher.dispatch({
			id: "event-1",
			type: "issue",
			source: "webhook",
			owner: "mbrooks",
			repo: "yeetomatic",
			occurredAt: "2026-06-01T00:00:00.000Z",
			payload: {
				action: "opened",
				issue: { number: 1, title: "Issue", body: "", labels: [], assignees: [{ login: "yeetomatic-bot" }] },
				repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
				sender: { login: "human" },
			},
		});

		expect(handleIssueEvent.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "opened" }));
		expect(store.markSeen).toHaveBeenCalledWith(expect.objectContaining({ id: "event-1" }));
		expect(store.updateLastEventReceivedAt).toHaveBeenCalledWith(expect.any(String));
		expect(store.upsertPollingSubject).toHaveBeenCalledWith(expect.objectContaining({
			subjectKey: "mbrooks/yeetomatic:issue:1",
			lastActivityAt: "2026-06-01T00:00:00.000Z",
			lastCheckedAt: null,
		}));
	});

	it("skips events already seen by the dedupe store", async () => {
		const store = makeStore({ hasSeen: vi.fn(() => true) });
		const handleIssueEvent = { execute: vi.fn(async () => {}) };
		const dispatcher = new GitHubEventDispatcher({
			handleIssueEvent: handleIssueEvent as never,
			handleIssueComment: { execute: vi.fn() } as never,
			handlePRReview: { execute: vi.fn() } as never,
			eventStore: store,
		});

		await dispatcher.dispatch({
			id: "event-1",
			type: "pull_request",
			source: "polling",
			owner: "mbrooks",
			repo: "yeetomatic",
			occurredAt: "2026-06-01T00:00:00.000Z",
			payload: {
				action: "opened",
				pull_request: { number: 2, head: { ref: "branch" }, state: "open", merged: false },
				repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
				sender: { login: "human" },
			},
		});

		expect(handleIssueEvent.execute).not.toHaveBeenCalled();
		expect(store.markSeen).not.toHaveBeenCalled();
		expect(store.updateLastEventReceivedAt).not.toHaveBeenCalled();
	});

	it("derives polling subjects from issue and PR events", () => {
		expect(pollingSubjectFromEvent({
			id: "issue",
			type: "issue",
			source: "polling",
			owner: "mbrooks",
			repo: "yeetomatic",
			occurredAt: "2026-06-01T00:00:00.000Z",
			payload: {
				action: "assigned",
				issue: { number: 3, title: "Issue", body: "", assignees: [{ login: "other" }] },
				repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
				sender: { login: "human" },
			},
		}, "yeetomatic-bot")).toBeNull();
		expect(pollingSubjectFromEvent({
			id: "comment",
			type: "issue_comment",
			source: "polling",
			owner: "mbrooks",
			repo: "yeetomatic",
			occurredAt: "2026-06-01T00:00:00.000Z",
			payload: {
				action: "created",
				issue: { number: 3, title: "Issue", body: "", assignees: [{ login: "yeetomatic-bot" }] },
				comment: { id: 1, body: "Comment", user: { login: "human" } },
				repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
				sender: { login: "human" },
			},
		}, "yeetomatic-bot")).toEqual(expect.objectContaining({ subjectKey: "mbrooks/yeetomatic:issue:3" }));
		expect(pollingSubjectFromEvent({
			id: "pr",
			type: "pull_request",
			source: "polling",
			owner: "mbrooks",
			repo: "yeetomatic",
			occurredAt: "2026-06-01T00:00:00.000Z",
			payload: {
				action: "synchronize",
				pull_request: { number: 4, head: { ref: "branch" }, state: "open", merged: false },
				repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
				sender: { login: "human" },
			},
		})).toEqual(expect.objectContaining({ subjectKey: "mbrooks/yeetomatic:pull_request:4" }));
	});
});
