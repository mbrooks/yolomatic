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
	it("resumes a session for any TARS label and pushes branch on complete", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
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
			commitAndPushBranch: vi.fn(async () => undefined),
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

		// Should resume on tars-feedback-required
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "tars-feedback-required" }] },
			comment: { body: "Here is the missing detail", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(1);
		expect(workspaceManager.commitAndPushBranch).toHaveBeenCalledWith("mbrooks", "tars", 42);

		// Should add tars-pr-created on complete, not tars-complete
		const addLabelsCalls = (octokit.issues.addLabels.mock.calls as unknown) as Array<[{ labels: string[] }]>;
		const lastAddLabels = addLabelsCalls[addLabelsCalls.length - 1];
		expect(lastAddLabels?.[0]?.labels).toContain("tars-pr-created");

		// Should resume on tars-pr-created too
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "tars-pr-created" }] },
			comment: { body: "Can you also add tests?", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(2);

		// Should ignore non-TARS labels
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "bug" }] },
			comment: { body: "Just chatting", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(2);

		// Should ignore bot comments
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "tars-pr-created" }] },
			comment: { body: "LGTM", user: { login: "tars-bot", type: "Bot" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "tars-bot" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(2);
	});

	it("ignores events triggered by the configured GitHub user", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
				createComment: vi.fn(async () => ({})),
			},
		};
		const sessionManager = {
			createSession: vi.fn(),
			getSession: vi.fn(),
			updateStatus: vi.fn(),
			markSeeded: vi.fn(),
		};
		const workspaceManager = {
			ensureWorkspace: vi.fn(),
			getOrCreateBranch: vi.fn(),
			commitAndPushBranch: vi.fn(),
		};
		const executor = {
			execute: vi.fn(),
		};
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			octokit: octokit as never,
		});

		// Ignore issue events from self
		await handlers.handleIssueEvent({
			action: "opened",
			issue: { number: 1, title: "Test", body: "Body" },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "tars-bot" },
		});

		expect(sessionManager.createSession).not.toHaveBeenCalled();

		// Ignore comment events from self
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "tars-working" }] },
			comment: { body: "Update", user: { login: "tars-bot" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "tars-bot" },
		});

		expect(executor.execute).not.toHaveBeenCalled();
	});
});
