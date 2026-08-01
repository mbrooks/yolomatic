import { describe, expect, it } from "vitest";

import type { GitHubEvent } from "./model.js";

describe("GitHubEvent model", () => {
	it("accepts normalized issue events", () => {
		const event: GitHubEvent = {
			id: "event-1",
			type: "issue",
			source: "webhook",
			owner: "mbrooks",
			repo: "yeetomatic",
			occurredAt: "2026-06-01T00:00:00.000Z",
			payload: {
				action: "opened",
				issue: { number: 1, title: "Issue", body: "", labels: [], assignees: [] },
				repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
				sender: { login: "human" },
			},
		};
		expect(event.type).toBe("issue");
	});
});

