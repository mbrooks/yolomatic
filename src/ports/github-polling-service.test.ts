import { describe, expect, it } from "vitest";
import type {
	GitHubPollingService,
	PollIssue,
	PollPullRequest,
} from "./github-polling-service.js";

describe("GitHubPollingService interface", () => {
	it("can be implemented by a concrete object", () => {
		const service: GitHubPollingService = {
			listAccessibleRepositories: async () => [],
			listIssuesUpdatedSince: async () => [],
			listIssueEventsSince: async () => [],
			listIssueCommentsSince: async () => [],
			listPullRequestsUpdatedSince: async () => [],
			listPRReviewsSince: async () => [],
			listPRReviewCommentsSince: async () => [],
		};
		expect(typeof service.listAccessibleRepositories).toBe("function");
		expect(typeof service.listPRReviewCommentsSince).toBe("function");
	});

	it("polling model types accept expected fields", () => {
		const issue: PollIssue = {
			number: 1,
			title: "Issue",
			body: "Body",
			state: "open",
			created_at: "2026-06-01T00:00:00Z",
			updated_at: "2026-06-01T00:01:00Z",
			labels: [{ name: "yolomatic" }],
			assignee: { login: "yolomatic-bot" },
			assignees: [{ login: "yolomatic-bot" }],
			user: { login: "human" },
		};
		const pullRequest: PollPullRequest = {
			number: 2,
			title: "PR",
			body: "Body",
			state: "open",
			merged: false,
			created_at: "2026-06-01T00:00:00Z",
			updated_at: "2026-06-01T00:01:00Z",
			head: { ref: "yolomatic/issue-2" },
			user: { login: "human" },
		};
		expect(issue.labels[0]?.name).toBe("yolomatic");
		expect(pullRequest.head.ref).toBe("yolomatic/issue-2");
	});
});
