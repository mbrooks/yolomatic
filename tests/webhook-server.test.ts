import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { verifySignature } from "../src/webhook/server.js";
import { GitHubIssueHandlers } from "../src/webhook/handlers.js";

describe("verifySignature", () => {
	it("accepts a valid GitHub webhook signature", () => {
		const payload = Buffer.from('{"action":"opened"}');
		const secret = "top-secret";
		const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

		expect(verifySignature(secret, payload, signature)).toBe(true);
		expect(verifySignature(secret, payload, "sha256=bad")).toBe(false);
	});
});

describe("GitHubIssueHandlers", () => {
	it("resumes a session only when feedback label is present", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi
					.fn()
					.mockRejectedValueOnce(Object.assign(new Error("missing"), { status: 404 }))
					.mockRejectedValueOnce(Object.assign(new Error("missing"), { status: 404 }))
					.mockRejectedValueOnce(Object.assign(new Error("missing"), { status: 404 }))
					.mockResolvedValue({}),
				createComment: vi.fn(async () => ({})),
			},
		};
		const sessionManager = {
			createSession: vi.fn(),
			getSession: vi.fn(async () => ({
				issueNumber: 42,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "waiting-feedback",
				sessionPath: "/tmp/sessions/tars-issue-42.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			updateStatus: vi.fn(async (_repo, _issue, status) => ({
				issueNumber: 42,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status,
				sessionPath: "/tmp/sessions/tars-issue-42.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			markSeeded: vi.fn(),
		};
		const workspaceManager = {
			ensureWorkspace: vi.fn(),
			getOrCreateBranch: vi.fn(async () => "tars/issue-42"),
		};
		const executor = {
			execute: vi.fn(async () => ({
				status: "complete" as const,
				summary: "Done.",
				rawResponse: "TARS_STATUS: complete\nDone.",
			})),
		};
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "mbrooks",
			autoStart: true,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "tars-feedback-required" }] },
			comment: { body: "Here is the missing detail", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
		});

		expect(executor.execute).toHaveBeenCalled();
		expect(octokit.issues.addLabels).toHaveBeenCalled();
		expect(octokit.issues.removeLabel).toHaveBeenCalled();
		expect(octokit.issues.createComment).toHaveBeenCalled();

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "bug" }] },
			comment: { body: "Just chatting", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
		});

		expect(executor.execute).toHaveBeenCalledTimes(1);
	});
});
