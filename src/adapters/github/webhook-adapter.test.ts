import { describe, expect, it, vi } from "vitest";

import { dispatchWebhookEvent, normalizeWebhookEvent } from "./webhook-adapter.js";

describe("webhook-adapter", () => {
	const payload = {
		action: "created",
		repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
		issue: { number: 1, title: "Issue", body: "Body", updated_at: "2026-06-01T00:00:00Z" },
		comment: { id: 10, body: "Comment", user: { login: "human" }, created_at: "2026-06-01T00:00:00Z" },
		pull_request: { number: 2, head: { ref: "branch" }, state: "open", merged: false, updated_at: "2026-06-01T00:00:00Z" },
		review: { id: 20, body: "Review", state: "commented", user: { login: "human" }, submitted_at: "2026-06-01T00:00:00Z" },
		sender: { login: "human" },
	};

	it("normalizes supported webhook events", () => {
		expect(normalizeWebhookEvent("issues", payload, "d1")[0]).toEqual(expect.objectContaining({ type: "issue", id: expect.stringContaining("d1") }));
		expect(normalizeWebhookEvent("issue_comment", payload, "d1")[0]).toEqual(expect.objectContaining({ type: "issue_comment", id: "github:issue_comment:10" }));
		expect(normalizeWebhookEvent("pull_request_review_comment", payload, "d1")[0]).toEqual(expect.objectContaining({ type: "pull_request_review_comment", id: "github:pull_request_review_comment:10" }));
		expect(normalizeWebhookEvent("pull_request_review", payload, "d1")[0]).toEqual(expect.objectContaining({ type: "pull_request_review", id: "github:pull_request_review:20:created" }));
		expect(normalizeWebhookEvent("pull_request", payload, "d1")[0]).toEqual(expect.objectContaining({ type: "pull_request" }));
		expect(normalizeWebhookEvent("ping", payload)).toEqual([]);
	});

	it("falls back when payload metadata is missing", () => {
		const [event] = normalizeWebhookEvent("issue_comment", {}, undefined);
		expect(event).toEqual(expect.objectContaining({
			owner: "unknown",
			repo: "unknown",
			id: expect.stringContaining("unknown"),
		}));
	});

	it("dispatches legacy webhook events to command handlers", async () => {
		const deps = {
			handleIssueEvent: { execute: vi.fn() },
			handleIssueComment: { execute: vi.fn() },
			handlePRReview: { execute: vi.fn() },
		};

		await dispatchWebhookEvent("issues", payload, deps as never);
		await dispatchWebhookEvent("issue_comment", payload, deps as never);
		await dispatchWebhookEvent("pull_request_review_comment", payload, deps as never);
		await dispatchWebhookEvent("pull_request_review", payload, deps as never);
		await dispatchWebhookEvent("unknown", payload, deps as never);

		expect(deps.handleIssueEvent.execute).toHaveBeenCalled();
		expect(deps.handleIssueComment.execute).toHaveBeenCalled();
		expect(deps.handlePRReview.execute).toHaveBeenCalledTimes(2);
	});
});

