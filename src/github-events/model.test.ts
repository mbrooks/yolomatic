import { describe, expect, it } from "vitest";

import type { GitHubEvent } from "./model.js";
import { isPollingSource } from "./model.js";

describe("GitHubEvent model", () => {
	it("accepts normalized issue events", () => {
		const event: GitHubEvent = {
			id: "event-1",
			type: "issue",
			source: "webhook",
			owner: "mbrooks",
			repo: "yolomatic",
			occurredAt: "2026-06-01T00:00:00.000Z",
			payload: {
				action: "opened",
				issue: { number: 1, title: "Issue", body: "", labels: [], assignees: [] },
				repository: { name: "yolomatic", owner: { login: "mbrooks" } },
				sender: { login: "human" },
			},
		};
		expect(event.type).toBe("issue");
	});

	it("identifies polling source", () => {
		expect(isPollingSource("polling")).toBe(true);
		expect(isPollingSource("webhook")).toBe(false);
	});

	it("accepts normalized push events", () => {
		const event: GitHubEvent = {
			id: "github:push:mbrooks/yolomatic:refs/heads/main:sha-after",
			type: "push",
			source: "webhook",
			owner: "mbrooks",
			repo: "yolomatic",
			occurredAt: "2026-06-01T00:00:00.000Z",
			payload: {
				ref: "refs/heads/main",
				before: "sha-before",
				after: "sha-after",
				repository: { name: "yolomatic", owner: { login: "mbrooks" } },
				sender: { login: "human" },
			},
		};
		expect(event.type).toBe("push");
		expect(event.payload.ref).toBe("refs/heads/main");
	});
});

