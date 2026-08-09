import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unlinkSync } from "node:fs";

import { GitHubEventStore } from "./store.js";

const TEST_DB = "/tmp/yolomatic-github-event-store-test.sqlite";

describe("GitHubEventStore", () => {
	beforeEach(() => {
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
	});

	afterEach(() => {
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
	});

	it("persists last event receive time and dedupe ids", () => {
		const store = new GitHubEventStore(TEST_DB);
		expect(store.getLastEventReceivedAt()).toBeNull();

		store.initializeLastEventReceivedAt("2026-06-01T00:00:00.000Z");
		store.initializeLastEventReceivedAt("2026-06-02T00:00:00.000Z");
		expect(store.getLastEventReceivedAt()).toBe("2026-06-01T00:00:00.000Z");

		store.updateLastEventReceivedAt("2026-06-03T00:00:00.000Z");
		expect(store.getLastEventReceivedAt()).toBe("2026-06-03T00:00:00.000Z");

		expect(store.hasSeen("event-1")).toBe(false);
		store.markSeen({
			id: "event-1",
			type: "pull_request",
			source: "polling",
			owner: "mbrooks",
			repo: "yolomatic",
			occurredAt: "2026-06-01T00:00:00.000Z",
			payload: {
				action: "opened",
				pull_request: { number: 1, head: { ref: "branch" }, state: "open", merged: false },
				repository: { name: "yolomatic", owner: { login: "mbrooks" } },
				sender: { login: "human" },
			},
		});
		expect(store.hasSeen("event-1")).toBe(true);
	});

	it("persists polling subject backoff state", () => {
		const store = new GitHubEventStore(TEST_DB);
		store.upsertPollingSubject({
			subjectKey: "mbrooks/yolomatic:issue:1",
			owner: "mbrooks",
			repo: "yolomatic",
			subjectType: "issue",
			number: 1,
			lastActivityAt: "2026-06-01T00:00:00.000Z",
			lastCheckedAt: null,
			createdAt: "2026-06-01T00:00:00.000Z",
		});

		expect(store.listPollingSubjects()).toEqual([{
			subjectKey: "mbrooks/yolomatic:issue:1",
			owner: "mbrooks",
			repo: "yolomatic",
			subjectType: "issue",
			number: 1,
			lastActivityAt: "2026-06-01T00:00:00.000Z",
			lastCheckedAt: null,
			createdAt: "2026-06-01T00:00:00.000Z",
		}]);

		store.markPollingSubjectChecked("mbrooks/yolomatic:issue:1", "2026-06-01T00:05:00.000Z");
		expect(store.listPollingSubjects()[0]?.lastCheckedAt).toBe("2026-06-01T00:05:00.000Z");

		store.upsertPollingSubject({
			subjectKey: "mbrooks/yolomatic:issue:1",
			owner: "mbrooks",
			repo: "yolomatic",
			subjectType: "issue",
			number: 1,
			lastActivityAt: "2026-06-01T01:00:00.000Z",
			lastCheckedAt: null,
			createdAt: "2026-06-01T00:00:00.000Z",
		});
		expect(store.listPollingSubjects()[0]?.lastActivityAt).toBe("2026-06-01T01:00:00.000Z");
		expect(store.listPollingSubjects()[0]?.lastCheckedAt).toBeNull();
	});

	it("persists per-repo polling baselines", () => {
		const store = new GitHubEventStore(TEST_DB);
		expect(store.getRepoPollBaseline("mbrooks", "yolomatic")).toBeNull();

		store.setRepoPollBaseline("mbrooks", "yolomatic", "2026-06-01T12:00:00.000Z");
		expect(store.getRepoPollBaseline("mbrooks", "yolomatic")).toBe("2026-06-01T12:00:00.000Z");

		store.setRepoPollBaseline("mbrooks", "yolomatic", "2026-06-02T12:00:00.000Z");
		expect(store.getRepoPollBaseline("mbrooks", "yolomatic")).toBe("2026-06-02T12:00:00.000Z");

		expect(store.getRepoPollBaseline("other", "repo")).toBeNull();
	});
});
