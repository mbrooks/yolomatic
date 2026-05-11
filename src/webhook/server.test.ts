import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import { createWebhookServer, readBody, verifySignature } from "./server.js";
import { GitHubIssueHandlers } from "./handlers.js";

function makeRequest(
	port: number,
	options: http.RequestOptions,
	body?: string,
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ hostname: "127.0.0.1", port, ...options }, (res) => {
			let data = "";
			res.on("data", (chunk) => {
				data += chunk;
			});
			res.on("end", () => {
				resolve({ statusCode: res.statusCode ?? 0, body: data, headers: res.headers });
			});
		});
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

describe("verifySignature", () => {
	it("accepts a valid GitHub webhook signature", () => {
		const payload = Buffer.from('{"action":"opened"}');
		const secret = "top-secret";
		const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

		expect(verifySignature(secret, payload, signature)).toBe(true);
		expect(verifySignature(secret, payload, "sha256=bad")).toBe(false);
	});
});

describe("readBody", () => {
	it("reads chunks from an async iterable request", async () => {
		const request = {
			async *[Symbol.asyncIterator]() {
				yield Buffer.from('{"action":"opened"}');
			},
		} as http.IncomingMessage;
		const body = await readBody(request);
		expect(body.toString()).toBe('{"action":"opened"}');
	});

	it("handles string chunks", async () => {
		const request = {
			async *[Symbol.asyncIterator]() {
				yield "hello";
			},
		} as http.IncomingMessage;
		const body = await readBody(request);
		expect(body.toString()).toBe("hello");
	});

	it("rejects when the request stream throws", async () => {
		const request = {
			async *[Symbol.asyncIterator]() {
				yield "chunk";
				throw new Error("stream error");
			},
		} as http.IncomingMessage;
		await expect(readBody(request)).rejects.toThrow("stream error");
	});
});

describe("GitHubIssueHandlers", () => {
	it("creates a session on comment if one does not exist (fallback)", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
				createComment: vi.fn(async () => ({})),
			},
		};
		let getSessionCallCount = 0;
		const sessionManager = {
			createSession: vi.fn(async (_owner: string, _repo: string, _issue: number, title: string, body: string, workspacePath: string) => ({
				issueNumber: 99,
				repo: "tars",
				owner: "mbrooks",
				title,
				body,
				status: "pending" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-99.jsonl",
				workspacePath,
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			getSession: vi.fn(async () => {
				getSessionCallCount++;
				return getSessionCallCount === 1
					? null
					: {
							issueNumber: 99,
							repo: "tars",
							owner: "mbrooks",
							title: "Fallback title",
							body: "Fallback body",
							status: "pending" as const,
							sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-99.jsonl",
							workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-99",
							lastActivity: new Date().toISOString(),
							seeded: false,
						};
			}),
			updateStatus: vi.fn(async (_owner: string, _repo: string, _issue: number, status: string) => ({
				issueNumber: 99,
				repo: "tars",
				owner: "mbrooks",
				title: "Fallback title",
				body: "Fallback body",
				status,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-99.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-99",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-99",
				branch: "tars/issue-99",
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 99,
			})),
			commitAndPush: vi.fn(async () => true),
			removeWorktree: vi.fn(),
		};
		const executor = {
			execute: vi.fn(async () => ({
				status: "waiting-feedback" as const,
				summary: "Need clarification.",
				rawResponse: "TARS_STATUS: waiting-feedback\nNeed clarification.",
			})),
		};
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			selfReportEnabled: false,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: {
				number: 99,
				labels: [{ name: "tars-working" }],
				assignees: [{ login: "tars-bot" }],
				title: "Test issue",
				body: "Test body",
			},
			comment: { body: "What is the status?", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "mbrooks" },
		});

		expect(sessionManager.getSession).toHaveBeenCalledWith("mbrooks", "tars", 99);
		expect(sessionManager.createSession).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			99,
			"Test issue",
			"Test body",
			"/tmp/workspaces/mbrooks-tars/.worktrees/issue-99",
			["tars-working"],
		);
		expect(executor.execute).toHaveBeenCalledTimes(1);
	});

	it("resumes a session for any TARS label and pushes branch on complete", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
				createComment: vi.fn(async () => ({})),
			},
			pulls: {
				create: vi.fn(async () => ({ data: { html_url: "https://github.com/mbrooks/tars/pull/1" } })),
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
				status: "waiting-feedback" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-42.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-42",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			updateStatus: vi.fn(async (_owner: string, _repo: string, _issue: number, status: string) => ({
				issueNumber: 42,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-42.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-42",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-42",
				branch: "tars/issue-42",
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 42,
			})),
			commitAndPush: vi.fn(async () => true),
			removeWorktree: vi.fn(),
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
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			selfReportEnabled: false,
			octokit: octokit as never,
		});

		// Should resume on tars-feedback-required
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "tars-feedback-required" }], assignees: [{ login: "tars-bot" }] },
			comment: { body: "Here is the missing detail", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(1);
		expect(workspaceManager.commitAndPush).toHaveBeenCalledWith("mbrooks", "tars", 42, "TARS: Done");

		// Should add tars-pr-created on complete, not tars-complete
		const addLabelsCalls = (octokit.issues.addLabels.mock.calls as unknown) as Array<[{ labels: string[] }]>;
		const lastAddLabels = addLabelsCalls[addLabelsCalls.length - 1];
		expect(lastAddLabels?.[0]?.labels).toContain("tars-pr-created");

		// Should create a PR via the GitHub API
		expect(octokit.pulls.create).toHaveBeenCalledWith(
			expect.objectContaining({
				owner: "mbrooks",
				repo: "tars",
				title: "TARS: Title",
				body: "Fixes #42\n\nDone.",
				head: "tars/issue-42",
				base: "main",
			}),
		);

		// Should resume on tars-pr-created too
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "tars-pr-created" }], assignees: [{ login: "tars-bot" }] },
			comment: { body: "Can you also add tests?", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(2);

		// Should ignore non-TARS labels
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "bug" }], assignees: [{ login: "tars-bot" }] },
			comment: { body: "Just chatting", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(2);

		// Should ignore bot comments
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "tars-pr-created" }], assignees: [{ login: "tars-bot" }] },
			comment: { body: "LGTM", user: { login: "tars-bot", type: "Bot" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "tars-bot" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(2);

		// Should ignore comments on issues not assigned to TARS
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "tars-pr-created" }], assignees: [{ login: "someone-else" }] },
			comment: { body: "Help", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(2);
	});

	it("marks issue complete without PR when there are no changes to deliver", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
				createComment: vi.fn(async () => ({})),
			},
			pulls: {
				create: vi.fn(async () => ({ data: { html_url: "https://github.com/mbrooks/tars/pull/1" } })),
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
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-42.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-42",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			updateStatus: vi.fn(async (_o: string, _r: string, _i: number, status: string) => ({
				issueNumber: 42,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-42.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-42",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-42",
				branch: "tars/issue-42",
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 42,
			})),
			commitAndPush: vi.fn(async () => false),
			removeWorktree: vi.fn(),
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
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			selfReportEnabled: false,
			octokit: octokit as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "tars-working" }], assignees: [{ login: "tars-bot" }] },
			comment: { body: "Proceed", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		expect(workspaceManager.commitAndPush).toHaveBeenCalledWith("mbrooks", "tars", 42, "TARS: Done");
		expect(octokit.pulls.create).not.toHaveBeenCalled();
		expect(sessionManager.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 42, "complete");
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.stringContaining("No code changes were necessary."),
			}),
		);
		expect(octokit.issues.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["tars-pr-created"] }),
		);
	});

	it("ignores duplicate issue events targeting the same issue", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
				createComment: vi.fn(async () => ({})),
			},
			pulls: {
				create: vi.fn(async () => ({ data: { html_url: "https://github.com/mbrooks/tars/pull/1" } })),
			},
		};
		let createCount = 0;
		const sessionManager = {
			createSession: vi.fn(async () => {
				createCount++;
				return {
					issueNumber: 1,
					repo: "tars",
					owner: "mbrooks",
					title: "Title",
					body: "Body",
					status: createCount === 1 ? ("pending" as const) : ("working" as const),
					sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
					lastActivity: new Date().toISOString(),
					seeded: false,
				};
			}),
			getSession: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			updateStatus: vi.fn(async (_owner: string, _repo: string, _issue: number, status: string) => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				branch: "tars/issue-1",
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 1,
			})),
			commitAndPush: vi.fn(async () => true),
			removeWorktree: vi.fn(),
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
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			selfReportEnabled: false,
			octokit: octokit as never,
		});

		// Simulate an opened event immediately followed by an assigned event
		const openedPromise = handlers.handleIssueEvent({
			action: "opened",
			issue: { number: 1, title: "Test", body: "Body", assignees: [{ login: "tars-bot" }] },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		const assignedPromise = handlers.handleIssueEvent({
			action: "assigned",
			issue: { number: 1, title: "Test", body: "Body", assignee: { login: "tars-bot" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		await Promise.all([openedPromise, assignedPromise]);

		// Should only execute once
		expect(executor.execute).toHaveBeenCalledTimes(1);
		// Should comment for pickup and completion (2 total, not 4)
		expect(octokit.issues.createComment).toHaveBeenCalledTimes(2);
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({ body: "Picked up by TARS. Working on it..." }),
		);
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
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(),
			commitAndPush: vi.fn(async () => true),
			removeWorktree: vi.fn(),
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
			defaultBranch: "main",
			selfReportEnabled: false,
			octokit: octokit as never,
		});

		// Ignore issue events from self
		await handlers.handleIssueEvent({
			action: "opened",
			issue: { number: 1, title: "Test", body: "Body", assignees: [{ login: "tars-bot" }] },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "tars-bot" },
		});

		expect(sessionManager.createSession).not.toHaveBeenCalled();

		// Ignore comment events from self
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "tars-working" }], assignees: [{ login: "tars-bot" }] },
			comment: { body: "Update", user: { login: "tars-bot" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "tars-bot" },
		});

		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("only works on issues assigned to TARS", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
				createComment: vi.fn(async () => ({})),
			},
			pulls: {
				create: vi.fn(async () => ({ data: { html_url: "https://github.com/mbrooks/tars/pull/1" } })),
			},
		};
		const sessionManager = {
			createSession: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "pending" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			getSession: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			updateStatus: vi.fn(async (_o: string, _r: string, _i: number, status: string) => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				branch: "tars/issue-1",
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 1,
			})),
			commitAndPush: vi.fn(async () => true),
			removeWorktree: vi.fn(),
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
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			selfReportEnabled: false,
			octokit: octokit as never,
		});

		// Ignore opened issues not assigned to TARS
		await handlers.handleIssueEvent({
			action: "opened",
			issue: { number: 1, title: "Test", body: "Body", assignees: [] },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});
		expect(sessionManager.createSession).not.toHaveBeenCalled();

		// Process opened issues already assigned to TARS
		await handlers.handleIssueEvent({
			action: "opened",
			issue: { number: 1, title: "Test", body: "Body", assignees: [{ login: "tars-bot" }] },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});
		expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
		expect(executor.execute).toHaveBeenCalledTimes(1);

		// Process assignment to TARS
		await handlers.handleIssueEvent({
			action: "assigned",
			issue: { number: 2, title: "Test 2", body: "Body", assignee: { login: "tars-bot" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});
		expect(sessionManager.createSession).toHaveBeenCalledTimes(2);
		expect(executor.execute).toHaveBeenCalledTimes(2);

		// Ignore assignment to someone else
		await handlers.handleIssueEvent({
			action: "assigned",
			issue: { number: 3, title: "Test 3", body: "Body", assignee: { login: "other-user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});
		expect(sessionManager.createSession).toHaveBeenCalledTimes(2);
		expect(executor.execute).toHaveBeenCalledTimes(2);

		// Pause work when TARS is unassigned
		await handlers.handleIssueEvent({
			action: "unassigned",
			issue: { number: 1, title: "Test", body: "Body", assignees: [{ login: "other-user" }] },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});
		expect(sessionManager.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "pending");
		expect(octokit.issues.removeLabel).toHaveBeenCalled();
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({ body: "TARS unassigned. Pausing work." }),
		);
	});

	it("processes comments that @mention the bot even without a tars label", async () => {
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
				issueNumber: 7,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/tars-issue-7.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-7",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			updateStatus: vi.fn(async (_repo: string, _issue: number, status: string) => ({
				issueNumber: 7,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status,
				sessionPath: "/tmp/sessions/tars-issue-7.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-7",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-7",
				branch: "tars/issue-7",
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 7,
			})),
			commitAndPush: vi.fn(async () => true),
			removeWorktree: vi.fn(),
		};
		const executor = {
			execute: vi.fn(async () => ({
				status: "waiting-feedback" as const,
				summary: "Need clarification.",
				rawResponse: "TARS_STATUS: waiting-feedback\nNeed clarification.",
			})),
		};
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			selfReportEnabled: false,
			octokit: octokit as never,
		});

		// No tars labels, but @mention should allow processing
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 7, labels: [], assignees: [{ login: "tars-bot" }] },
			comment: { body: "Hey @tars-bot can you help?", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(1);

		// Should auto-add the tars label once
		expect(octokit.issues.addLabels).toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["tars"] }),
		);

		// Second comment now has a tars label; mention gate is no longer needed
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 7, labels: [{ name: "tars-working" }], assignees: [{ login: "tars-bot" }] },
			comment: { body: "Thanks!", user: { login: "user" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "user" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(2);
		// Should NOT add tars label again because hasTarsLabel is true
		const tarsAdds = (octokit.issues.addLabels.mock.calls as unknown) as Array<[{ labels: string[] }]>;
		expect(tarsAdds.filter((call) => call[0].labels.includes("tars"))).toHaveLength(1);
	});

	it("posts failure comment when execution throws", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
				createComment: vi.fn(async () => ({})),
			},
			pulls: {
				create: vi.fn(async () => ({ data: { html_url: "https://github.com/mbrooks/tars/pull/1" } })),
			},
		};
		const sessionManager = {
			createSession: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "pending" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			getSession: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			updateStatus: vi.fn(async (_o: string, _r: string, _i: number, status: string) => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				branch: "tars/issue-1",
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 1,
			})),
			commitAndPush: vi.fn(async () => true),
			removeWorktree: vi.fn(),
		};
		const executor = {
			execute: vi.fn(async () => {
				throw new Error("Boom");
			}),
		};
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			selfReportEnabled: false,
			octokit: octokit as never,
		});

		await expect(
			handlers.handleIssueEvent({
				action: "opened",
				issue: { number: 1, title: "Test", body: "Body", assignees: [{ login: "tars-bot" }] },
				repository: { name: "tars", owner: { login: "mbrooks" } },
				sender: { login: "other-user" },
			}),
		).rejects.toThrow("Boom");

		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.stringContaining("TARS failed"),
			}),
		);
	});

	it("handles 404 during safeRemoveLabel gracefully", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockRejectedValue({ status: 404 }),
				createComment: vi.fn(async () => ({})),
			},
		};
		const sessionManager = {
			createSession: vi.fn(),
			getSession: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			updateStatus: vi.fn(async (_o: string, _r: string, _i: number, status: string) => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(),
			commitAndPush: vi.fn(async () => true),
			removeWorktree: vi.fn(),
		};
		const executor = { execute: vi.fn() };
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			selfReportEnabled: false,
			octokit: octokit as never,
		});

		await handlers.handleIssueEvent({
			action: "unassigned",
			issue: { number: 1, title: "Test", body: "Body", assignees: [{ login: "other-user" }] },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		expect(octokit.issues.removeLabel).toHaveBeenCalled();
	});

	it("throws when safeRemoveLabel encounters non-404 error", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockRejectedValue({ status: 500 }),
				createComment: vi.fn(async () => ({})),
			},
		};
		const sessionManager = {
			createSession: vi.fn(),
			getSession: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			updateStatus: vi.fn(),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(),
			commitAndPush: vi.fn(async () => true),
			removeWorktree: vi.fn(),
		};
		const executor = { execute: vi.fn() };
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			selfReportEnabled: false,
			octokit: octokit as never,
		});

		await expect(
			handlers.handleIssueEvent({
				action: "unassigned",
				issue: { number: 1, title: "Test", body: "Body", assignees: [{ login: "other-user" }] },
				repository: { name: "tars", owner: { login: "mbrooks" } },
				sender: { login: "other-user" },
			}),
		).rejects.toThrow();
	});

	it("files a self-report and posts a comment on fatal system error", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
				createComment: vi.fn(async () => ({})),
				create: vi.fn(async () => ({ data: { html_url: "https://github.com/mbrooks/tars/issues/999" } })),
			},
		};
		const sessionManager = {
			createSession: vi.fn(async (_owner: string, _repo: string, _issue: number, title: string, body: string, workspacePath: string) => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title,
				body,
				status: "pending" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath,
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			getSession: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "T",
				body: "B",
				status: "pending" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			updateStatus: vi.fn(async (_owner: string, _repo: string, _issue: number, status: string) => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "T",
				body: "B",
				status,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			markSeeded: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				branch: "tars/issue-1",
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 1,
			})),
			commitAndPush: vi.fn(async () => true),
			removeWorktree: vi.fn(),
		};

		const { FatalSystemError, SelfMonitor } = await import("../self-monitor/index.js");
		const evidence = {
			toolHistory: [],
			fatalError: { category: "disk_full" as const, message: "ENOSPC", toolName: "bash" },
			systemEvidence: {
				whoami: "tars",
				pwd: "/tmp",
				workspacePath: "/tmp/ws",
				lsWorkspace: "total 0",
				gitStatus: "",
				gitBranch: "main",
				nodeVersion: "v20",
				timestamp: "2024-01-01T00:00:00Z",
			},
		};
		const fatalError = new FatalSystemError(evidence);

		const executor = {
			execute: vi.fn(async () => {
				throw fatalError;
			}),
		};

		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await expect(
			handlers.handleIssueEvent({
				action: "opened",
				issue: {
					number: 1,
					title: "Test",
					body: "Body",
					assignees: [{ login: "tars-bot" }],
				},
				repository: { name: "tars", owner: { login: "mbrooks" } },
				sender: { login: "human" },
			}),
		).resolves.toBeUndefined();

		expect(octokit.issues.create).toHaveBeenCalledWith(
			expect.objectContaining({
				owner: "mbrooks",
				repo: "tars",
				title: expect.stringContaining("TARS self-report"),
				labels: ["tars-self-report", "bug"],
			}),
		);
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({
				owner: "mbrooks",
				repo: "tars",
				issue_number: 1,
				body: expect.stringContaining("fatal system error"),
			}),
		);
		expect(sessionManager.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "failed");
	});

	it("files a self-report when commit and push delivery fails", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
				createComment: vi.fn(async () => ({})),
				create: vi.fn(async () => ({ data: { html_url: "https://github.com/mbrooks/tars/issues/1000" } })),
			},
			pulls: {
				create: vi.fn(async () => ({ data: { html_url: "https://github.com/mbrooks/tars/pull/1" } })),
			},
		};
		const sessionManager = {
			createSession: vi.fn(async (_owner: string, _repo: string, _issue: number, title: string, body: string, workspacePath: string) => ({
				issueNumber: 1,
				repo: "teamhub-case",
				owner: "mbrooks",
				title,
				body,
				status: "pending" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-teamhub-case/issue-1.jsonl",
				workspacePath,
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			getSession: vi.fn(async () => ({
				issueNumber: 1,
				repo: "teamhub-case",
				owner: "mbrooks",
				title: "T",
				body: "B",
				status: "pending" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-teamhub-case/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-teamhub-case/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			updateStatus: vi.fn(async (_owner: string, _repo: string, _issue: number, status: string) => ({
				issueNumber: 1,
				repo: "teamhub-case",
				owner: "mbrooks",
				title: "T",
				body: "B",
				status,
				sessionPath: "/tmp/sessions/github-mbrooks-teamhub-case/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-teamhub-case/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-teamhub-case/.worktrees/issue-1",
				branch: "tars/issue-1",
				owner: "mbrooks",
				repo: "teamhub-case",
				issueNumber: 1,
			})),
			commitAndPush: vi.fn(async () => {
				throw new Error("Author identity unknown");
			}),
			removeWorktree: vi.fn(),
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
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			selfReportEnabled: true,
			octokit: octokit as never,
		});

		await expect(
			handlers.handleIssueEvent({
				action: "opened",
				issue: {
					number: 1,
					title: "Test",
					body: "Body",
					assignees: [{ login: "tars-bot" }],
				},
				repository: { name: "teamhub-case", owner: { login: "mbrooks" } },
				sender: { login: "human" },
			}),
		).resolves.toBeUndefined();

		expect(octokit.issues.create).toHaveBeenCalledWith(
			expect.objectContaining({
				owner: "mbrooks",
				repo: "tars",
				title: expect.stringContaining("TARS self-report"),
				body: expect.stringContaining("Author identity unknown"),
				labels: ["tars-self-report", "bug"],
			}),
		);
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({
				owner: "mbrooks",
				repo: "teamhub-case",
				issue_number: 1,
				body: expect.stringContaining("could not deliver"),
			}),
		);
		expect(sessionManager.updateStatus).not.toHaveBeenCalledWith("mbrooks", "teamhub-case", 1, "complete");
		expect(sessionManager.updateStatus).toHaveBeenCalledWith("mbrooks", "teamhub-case", 1, "failed");
		expect(octokit.pulls.create).not.toHaveBeenCalled();
	});

	it("queues new issue events when draining mode is active", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
				createComment: vi.fn(async () => ({})),
			},
		};
		const sessionManager = {
			createSession: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "pending" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			getSession: vi.fn(async () => null),
			updateStatus: vi.fn(),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				branch: "tars/issue-1",
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 1,
			})),
			commitAndPush: vi.fn(async () => true),
			removeWorktree: vi.fn(),
		};
		const executor = {
			execute: vi.fn(),
		};
		const taskController = {
			isDraining: vi.fn(() => true),
			setDraining: vi.fn(),
			cancel: vi.fn(),
			isActive: vi.fn(() => false),
			register: vi.fn(),
			unregister: vi.fn(),
		};
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			selfReportEnabled: false,
			octokit: octokit as never,
			taskController: taskController as never,
		});

		await handlers.handleIssueEvent({
			action: "opened",
			issue: { number: 1, title: "Test", body: "Body", assignees: [{ login: "tars-bot" }] },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		expect(executor.execute).not.toHaveBeenCalled();
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({ body: "Deploy in progress. Task will resume after restart." }),
		);
	});

	it("resumes an interrupted working session", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
				createComment: vi.fn(async () => ({})),
			},
			pulls: {
				create: vi.fn(async () => ({ data: { html_url: "https://github.com/mbrooks/tars/pull/1" } })),
			},
		};
		const sessionManager = {
			createSession: vi.fn(),
			getSession: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			updateStatus: vi.fn(async (_o: string, _r: string, _i: number, status: string) => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				branch: "tars/issue-1",
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 1,
			})),
			commitAndPush: vi.fn(async () => true),
			removeWorktree: vi.fn(),
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
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			selfReportEnabled: false,
			octokit: octokit as never,
		});

		await handlers.resumeInterruptedSession("mbrooks", "tars", 1);

		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({
				body: "TARS was restarted while working on this issue. Resuming work...",
			}),
		);
		expect(executor.execute).toHaveBeenCalledTimes(1);
	});

	it("skips resume when session is not in working status", async () => {
		const sessionManager = {
			getSession: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				status: "pending" as const,
				lastActivity: new Date().toISOString(),
			})),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(),
		};
		const executor = { execute: vi.fn() };
		const octokit = { issues: { createComment: vi.fn() } };
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			selfReportEnabled: false,
			octokit: octokit as never,
		});

		await handlers.resumeInterruptedSession("mbrooks", "tars", 1);
		expect(executor.execute).not.toHaveBeenCalled();
		expect(octokit.issues.createComment).not.toHaveBeenCalled();
	});

	it("queues comment events when draining mode is active", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
				createComment: vi.fn(async () => ({})),
			},
		};
		const sessionManager = {
			getSession: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Title",
				body: "Body",
				status: "waiting-feedback" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			updateStatus: vi.fn(),
			markSeeded: vi.fn(),
			associatePR: vi.fn(),
			incrementIterationCount: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(),
			commitAndPush: vi.fn(async () => true),
			removeWorktree: vi.fn(),
		};
		const executor = { execute: vi.fn() };
		const taskController = {
			isDraining: vi.fn(() => true),
			setDraining: vi.fn(),
			cancel: vi.fn(),
			isActive: vi.fn(() => false),
			register: vi.fn(),
			unregister: vi.fn(),
		};
		const handlers = new GitHubIssueHandlers({
			sessionManager: sessionManager as never,
			workspaceManager: workspaceManager as never,
			executor: executor as never,
			githubToken: "token",
			githubUsername: "tars-bot",
			autoStart: true,
			defaultBranch: "main",
			selfReportEnabled: false,
			octokit: octokit as never,
			taskController: taskController as never,
		});

		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 1, labels: [{ name: "tars-feedback-required" }], assignees: [{ login: "tars-bot" }] },
			comment: { body: "Proceed", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		expect(executor.execute).not.toHaveBeenCalled();
		expect(octokit.issues.createComment).toHaveBeenCalledWith(
			expect.objectContaining({ body: "Deploy in progress. Feedback will be processed after restart." }),
		);
	});
});

describe("createWebhookServer", () => {
	function makeMockSessionStore(): import("../session/store.js").SessionStore {
		return {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
	}

	it("returns 404 for non-POST or non-/webhook routes", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const getRes = await makeRequest(port, { method: "GET", path: "/webhook" });
		expect(getRes.statusCode).toBe(404);

		const postRes = await makeRequest(port, { method: "POST", path: "/" });
		expect(postRes.statusCode).toBe(404);

		server.close();
	});

	it("returns 401 for invalid signature", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/webhook",
			headers: {
				"x-hub-signature-256": "sha256=invalid",
				"x-github-event": "issues",
			},
		});
		expect(response.statusCode).toBe(401);

		server.close();
	});

	it("calls handleIssueEvent for valid issues webhook", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const payload = JSON.stringify({ action: "opened" });
		const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;

		const response = await makeRequest(
			port,
			{
				method: "POST",
				path: "/webhook",
				headers: {
					"x-hub-signature-256": signature,
					"x-github-event": "issues",
					"x-github-delivery": "123",
				},
			},
			payload,
		);
		expect(response.statusCode).toBe(200);
		expect(handlers.handleIssueEvent).toHaveBeenCalled();

		server.close();
	});

	it("returns 500 when handler throws", async () => {
		const handlers = {
			handleIssueEvent: vi.fn(async () => {
				throw new Error("boom");
			}),
			handleCommentEvent: vi.fn(),
			handlePullRequestReviewCommentEvent: vi.fn(),
			handlePullRequestReviewEvent: vi.fn(),
			isInFlight: vi.fn(() => false),
		};
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const payload = JSON.stringify({ action: "opened" });
		const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;

		const response = await makeRequest(
			port,
			{
				method: "POST",
				path: "/webhook",
				headers: {
					"x-hub-signature-256": signature,
					"x-github-event": "issues",
				},
			},
			payload,
		);
		expect(response.statusCode).toBe(500);

		server.close();
	});

	it("ignores unsupported events and returns 200", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const payload = JSON.stringify({ action: "published" });
		const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;

		const response = await makeRequest(
			port,
			{
				method: "POST",
				path: "/webhook",
				headers: {
					"x-hub-signature-256": signature,
					"x-github-event": "release",
				},
			},
			payload,
		);
		expect(response.statusCode).toBe(200);
		expect(handlers.handleIssueEvent).not.toHaveBeenCalled();
		expect(handlers.handleCommentEvent).not.toHaveBeenCalled();
		expect(handlers.handlePullRequestReviewCommentEvent).not.toHaveBeenCalled();
		expect(handlers.handlePullRequestReviewEvent).not.toHaveBeenCalled();

		server.close();
	});

	it("returns 401 when signature header is missing", async () => {
		const handlers = {
			handleIssueEvent: vi.fn(),
			handleCommentEvent: vi.fn(),
			handlePullRequestReviewCommentEvent: vi.fn(),
			handlePullRequestReviewEvent: vi.fn(),
			isInFlight: vi.fn(() => false),
		};
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const payload = JSON.stringify({ action: "opened" });

		const response = await makeRequest(
			port,
			{
				method: "POST",
				path: "/webhook",
				headers: {
					"x-github-event": "issues",
				},
			},
			payload,
		);
		expect(response.statusCode).toBe(401);

		server.close();
	});

	it("calls handlePullRequestReviewCommentEvent for valid PR review comment webhook", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const payload = JSON.stringify({ action: "created", comment: {} });
		const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;

		const response = await makeRequest(
			port,
			{
				method: "POST",
				path: "/webhook",
				headers: {
					"x-hub-signature-256": signature,
					"x-github-event": "pull_request_review_comment",
					"x-github-delivery": "456",
				},
			},
			payload,
		);
		expect(response.statusCode).toBe(200);
		expect(handlers.handlePullRequestReviewCommentEvent).toHaveBeenCalled();

		server.close();
	});

	it("calls handlePullRequestReviewEvent for valid PR review webhook", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const payload = JSON.stringify({ action: "submitted", review: {} });
		const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;

		const response = await makeRequest(
			port,
			{
				method: "POST",
				path: "/webhook",
				headers: {
					"x-hub-signature-256": signature,
					"x-github-event": "pull_request_review",
					"x-github-delivery": "789",
				},
			},
			payload,
		);
		expect(response.statusCode).toBe(200);
		expect(handlers.handlePullRequestReviewEvent).toHaveBeenCalled();

		server.close();
	});

	it("ignores event when x-github-event header is missing", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const payload = JSON.stringify({ action: "opened" });
		const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;

		const response = await makeRequest(
			port,
			{
				method: "POST",
				path: "/webhook",
				headers: {
					"x-hub-signature-256": signature,
				},
			},
			payload,
		);
		expect(response.statusCode).toBe(200);
		expect(handlers.handleIssueEvent).not.toHaveBeenCalled();
		expect(handlers.handleCommentEvent).not.toHaveBeenCalled();
		expect(handlers.handlePullRequestReviewCommentEvent).not.toHaveBeenCalled();
		expect(handlers.handlePullRequestReviewEvent).not.toHaveBeenCalled();

		server.close();
	});

	it("returns 404 for /tarsadmin when credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, { method: "GET", path: "/tarsadmin" });
		expect(response.statusCode).toBe(404);

		server.close();
	});

	it("returns 404 for /api/status when credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, { method: "GET", path: "/api/status" });
		expect(response.statusCode).toBe(404);

		server.close();
	});

	it("returns 401 for /tarsadmin without auth header when credentials are configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore(), "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, { method: "GET", path: "/tarsadmin" });
		expect(response.statusCode).toBe(401);
		expect(response.body).toBe("Unauthorized");

		server.close();
	});

	it("returns 401 for /api/status with wrong credentials", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore(), "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:wrong").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(401);
		expect(response.body).toBe("Invalid credentials");

		server.close();
	});

	it("returns HTML for /tarsadmin with valid credentials", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const adminAssetsDir = await mkdtemp(join(tmpdir(), "tars-admin-"));
		await writeFile(
			join(adminAssetsDir, "index.html"),
			'<!doctype html><html><head><title>TARS Admin</title></head><body><div id="root"></div><script type="module" src="/tarsadmin/assets/main.js"></script></body></html>',
		);
		const server = createWebhookServer("secret", handlers, makeMockSessionStore(), "admin", "secret", undefined, undefined, undefined, undefined, { adminAssetsDir });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		try {
			const response = await makeRequest(port, {
				method: "GET",
				path: "/tarsadmin",
				headers: {
					Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
				},
			});
			expect(response.statusCode).toBe(200);
			expect(response.headers["content-type"]).toContain("text/html");
			expect(response.body).toContain("TARS Admin");
			expect(response.body).toContain('id="root"');
			expect(response.body).toContain("/tarsadmin/assets/main.js");
		} finally {
			server.close();
			await rm(adminAssetsDir, { force: true, recursive: true });
		}
	});

	it("serves /tarsadmin bundled assets with valid credentials", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const adminAssetsDir = await mkdtemp(join(tmpdir(), "tars-admin-"));
		await mkdir(join(adminAssetsDir, "assets"));
		await writeFile(join(adminAssetsDir, "assets", "main.js"), "console.log('admin');");
		const server = createWebhookServer("secret", handlers, makeMockSessionStore(), "admin", "secret", undefined, undefined, undefined, undefined, { adminAssetsDir });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		try {
			const response = await makeRequest(port, {
				method: "GET",
				path: "/tarsadmin/assets/main.js",
				headers: {
					Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
				},
			});
			expect(response.statusCode).toBe(200);
			expect(response.headers["content-type"]).toContain("text/javascript");
			expect(response.body).toBe("console.log('admin');");
		} finally {
			server.close();
			await rm(adminAssetsDir, { force: true, recursive: true });
		}
	});

	it("requires auth for /tarsadmin bundled assets", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const adminAssetsDir = await mkdtemp(join(tmpdir(), "tars-admin-"));
		await mkdir(join(adminAssetsDir, "assets"));
		await writeFile(join(adminAssetsDir, "assets", "main.js"), "console.log('admin');");
		const server = createWebhookServer("secret", handlers, makeMockSessionStore(), "admin", "secret", undefined, undefined, undefined, undefined, { adminAssetsDir });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		try {
			const response = await makeRequest(port, { method: "GET", path: "/tarsadmin/assets/main.js" });
			expect(response.statusCode).toBe(401);
			expect(response.body).toBe("Unauthorized");
		} finally {
			server.close();
			await rm(adminAssetsDir, { force: true, recursive: true });
		}
	});

	it("returns JSON for /api/status with valid credentials", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => [
				{
					issueNumber: 1,
					repo: "tars",
					owner: "mbrooks",
					title: "Test",
					body: "Body",
					status: "working" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
					lastActivity: new Date().toISOString(),
					seeded: false,
				},
			]),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.agent).toBe("busy");
		expect(body.sessions).toHaveLength(1);
		expect(body.sessions[0].branch).toBe("tars/issue-1");
		expect(body.sessions[0].risk).toEqual({
			suspectedMisroute: false,
			reasons: [],
			referencedIssueNumber: null,
		});

		server.close();
	});

	it("flags PR-shaped sessions in /api/status", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => [
				{
					issueNumber: 89,
					repo: "tars",
					owner: "mbrooks",
					title: "TARS: Add stale session detection",
					body: "Fixes #86\n\nSummary",
					status: "complete" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-89.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-89",
					lastActivity: new Date().toISOString(),
					seeded: false,
				},
			]),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.sessions[0].risk.suspectedMisroute).toBe(true);
		expect(body.sessions[0].risk.referencedIssueNumber).toBe(86);
		expect(body.sessions[0].risk.reasons).toContain("Session body references issue #86.");
		expect(body.sessions[0].risk.reasons).toContain("Session title looks like a generated PR title.");

		server.close();
	});

	it("sorts sessions by createdAt descending in /api/status", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => [
				{
					issueNumber: 1,
					repo: "tars",
					owner: "mbrooks",
					title: "First",
					body: "Body",
					status: "complete" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
					lastActivity: "2026-01-01T00:00:00.000Z",
					createdAt: "2026-01-01T00:00:00.000Z",
					seeded: false,
				},
				{
					issueNumber: 2,
					repo: "tars",
					owner: "mbrooks",
					title: "Second",
					body: "Body",
					status: "complete" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-2.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-2",
					lastActivity: "2026-01-02T00:00:00.000Z",
					createdAt: "2026-01-03T00:00:00.000Z",
					seeded: false,
				},
				{
					issueNumber: 3,
					repo: "tars",
					owner: "mbrooks",
					title: "Third",
					body: "Body",
					status: "complete" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-3.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-3",
					lastActivity: "2026-01-03T00:00:00.000Z",
					createdAt: "2026-01-02T00:00:00.000Z",
					seeded: false,
				},
			]),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.sessions).toHaveLength(3);
		expect(body.sessions[0].issueNumber).toBe(2); // newest createdAt first
		expect(body.sessions[1].issueNumber).toBe(3);
		expect(body.sessions[2].issueNumber).toBe(1);

		server.close();
	});

	it("falls back to lastActivity when createdAt is missing", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => [
				{
					issueNumber: 1,
					repo: "tars",
					owner: "mbrooks",
					title: "Old",
					body: "Body",
					status: "complete" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
					lastActivity: "2026-01-01T00:00:00.000Z",
					seeded: false,
				},
				{
					issueNumber: 2,
					repo: "tars",
					owner: "mbrooks",
					title: "New",
					body: "Body",
					status: "complete" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-2.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-2",
					lastActivity: "2026-01-03T00:00:00.000Z",
					seeded: false,
				},
			]),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.sessions).toHaveLength(2);
		expect(body.sessions[0].issueNumber).toBe(2); // newer lastActivity first
		expect(body.sessions[1].issueNumber).toBe(1);

		server.close();
	});

	it("returns 500 for /api/status when getAll throws", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => {
				throw new Error("disk error");
			}),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(500);
		const body = JSON.parse(response.body);
		expect(body.error).toBe("disk error");

		server.close();
	});

	it("returns repo summaries in /api/status", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => [
				{
					issueNumber: 1,
					repo: "tars",
					owner: "mbrooks",
					title: "One",
					body: "Body",
					status: "working" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
					lastActivity: new Date().toISOString(),
					seeded: false,
				},
				{
					issueNumber: 2,
					repo: "tars",
					owner: "mbrooks",
					title: "Two",
					body: "Body",
					status: "complete" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-2.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-2",
					lastActivity: new Date().toISOString(),
					seeded: false,
				},
				{
					issueNumber: 3,
					repo: "case",
					owner: "mbrooks",
					title: "Three",
					body: "Body",
					status: "pending" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-case/issue-3.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-case/.worktrees/issue-3",
					lastActivity: new Date().toISOString(),
					seeded: false,
				},
			]),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.repos).toHaveLength(2);
		expect(body.repos[0]).toEqual({ owner: "mbrooks", repo: "case", sessionCount: 1, activeCount: 1 });
		expect(body.repos[1]).toEqual({ owner: "mbrooks", repo: "tars", sessionCount: 2, activeCount: 1 });

		server.close();
	});

	it("returns empty repos array when no sessions exist", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.repos).toEqual([]);

		server.close();
	});

	it("returns 404 for /api/sessions cancel when admin credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/tars/1/cancel",
		});
		expect(response.statusCode).toBe(404);

		server.close();
	});

	it("cancels an active session via POST /api/sessions/:owner/:repo/:issueNumber/cancel", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const taskController = {
			cancel: vi.fn(() => true),
			isActive: vi.fn(() => true),
			register: vi.fn(),
			unregister: vi.fn(),
		} as unknown as import("../task-controller.js").TaskController;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret", taskController);
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/tars/1/cancel",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.cancelled).toBe(true);
		expect(body.wasActive).toBe(true);
		expect(taskController.cancel).toHaveBeenCalledWith("mbrooks/tars#1");

		server.close();
	});

	it("marks session as cancelled when not active via POST cancel", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 2,
				repo: "tars",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-2.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-2",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(async (state: import("../session/store.js").SessionState) => state),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const taskController = {
			cancel: vi.fn(() => false),
			isActive: vi.fn(() => false),
			register: vi.fn(),
			unregister: vi.fn(),
		} as unknown as import("../task-controller.js").TaskController;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret", taskController);
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/tars/2/cancel",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.cancelled).toBe(false);
		expect(body.status).toBe("cancelled");
		expect(mockStore.set).toHaveBeenCalled();

		server.close();
	});

	it("returns 404 for cancel when session does not exist", async () => {
		const mockStore = {
			get: vi.fn(async () => null),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret", undefined);
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/tars/999/cancel",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(404);
		const body = JSON.parse(response.body);
		expect(body.error).toBe("Session not found");

		server.close();
	});

	it("marks a session failed via POST /api/sessions/:owner/:repo/:issueNumber/mark-failed", async () => {
		const session = {
			issueNumber: 89,
			repo: "tars",
			owner: "mbrooks",
			title: "TARS: Add stale session detection",
			body: "Fixes #86\n\nSummary",
			status: "complete" as const,
			sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-89.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-89",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};
		const mockStore = {
			get: vi.fn(async () => session),
			set: vi.fn(async (state: import("../session/store.js").SessionState) => state),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/tars/89/mark-failed",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.status).toBe("failed");
		expect(mockStore.set).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "failed",
				summary: "Marked failed by admin cleanup.",
			}),
		);

		server.close();
	});

	it("deletes a terminal session via POST /api/sessions/:owner/:repo/:issueNumber/delete", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 3,
				repo: "tars",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "complete" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-3.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-3",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
			delete: vi.fn(async () => undefined),
		} as unknown as import("../session/store.js").SessionStore;

		const workspaceManager = {
			removeWorktree: vi.fn(async () => undefined),
		} as unknown as import("../workspace/manager.js").WorkspaceManager;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret", undefined, workspaceManager);
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/tars/3/delete",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.deleted).toBe(true);
		expect(body.message).toBe("Session and workspace deleted.");
		expect(workspaceManager.removeWorktree).toHaveBeenCalledWith("mbrooks", "tars", 3);
		expect(mockStore.delete).toHaveBeenCalledWith("mbrooks", "tars", 3);

		server.close();
	});

	it("returns 400 when deleting a non-terminal session", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 4,
				repo: "tars",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-4.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-4",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
			delete: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/tars/4/delete",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(400);
		const body = JSON.parse(response.body);
		expect(body.error).toContain("Cannot delete session in 'working' status");
		expect(mockStore.delete).not.toHaveBeenCalled();

		server.close();
	});

	it("returns 404 for delete when session does not exist", async () => {
		const mockStore = {
			get: vi.fn(async () => null),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
			delete: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/tars/999/delete",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(404);
		const body = JSON.parse(response.body);
		expect(body.error).toBe("Session not found");

		server.close();
	});

	it("returns 404 for delete when admin credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/tars/1/delete",
		});
		expect(response.statusCode).toBe(404);

		server.close();
	});

	it("returns 404 for restart when admin credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/tars/1/restart",
		});
		expect(response.statusCode).toBe(404);

		server.close();
	});

	it("restarts a failed session via POST /api/sessions/:owner/:repo/:issueNumber/restart", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 5,
				repo: "tars",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "failed" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-5.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-5",
				lastActivity: new Date().toISOString(),
				seeded: true,
				summary: "Boom",
				prNumber: 7,
				prUrl: "https://github.com/mbrooks/tars/pull/7",
				iterationCount: 2,
			})),
			set: vi.fn(async (state: import("../session/store.js").SessionState) => state),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const workspaceManager = {
			removeWorktree: vi.fn(async () => undefined),
		} as unknown as import("../workspace/manager.js").WorkspaceManager;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret", undefined, workspaceManager);
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/tars/5/restart",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.restarted).toBe(true);
		expect(body.status).toBe("pending");
		expect(workspaceManager.removeWorktree).toHaveBeenCalledWith("mbrooks", "tars", 5);
		expect(mockStore.set).toHaveBeenCalled();
		const setCall = ((mockStore.set as unknown as ReturnType<typeof vi.fn>).mock.calls as unknown) as Array<[import("../session/store.js").SessionState]>;
		const updatedState = setCall[0][0];
		expect(updatedState.status).toBe("pending");
		expect(updatedState.summary).toBeUndefined();
		expect(updatedState.prNumber).toBeUndefined();
		expect(updatedState.prUrl).toBeUndefined();
		expect(updatedState.seeded).toBe(false);
		expect(updatedState.iterationCount).toBeUndefined();
		expect(updatedState.restartCount).toBe(1);
		expect(updatedState.restartedFrom).toBe("failed");

		server.close();
	});

	it("restarts a cancelled session via POST restart", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 6,
				repo: "tars",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "cancelled" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-6.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-6",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(async (state: import("../session/store.js").SessionState) => state),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const workspaceManager = {
			removeWorktree: vi.fn(async () => undefined),
		} as unknown as import("../workspace/manager.js").WorkspaceManager;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret", undefined, workspaceManager);
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/tars/6/restart",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.restarted).toBe(true);
		expect(body.status).toBe("pending");

		server.close();
	});

	it("returns 400 when restarting a completed session", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 7,
				repo: "tars",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "complete" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-7.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-7",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/tars/7/restart",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(400);
		const body = JSON.parse(response.body);
		expect(body.error).toContain("Cannot restart a completed session");
		expect(mockStore.set).not.toHaveBeenCalled();

		server.close();
	});

	it("returns 400 when restarting a working session", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 8,
				repo: "tars",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-8.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-8",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/tars/8/restart",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(400);
		const body = JSON.parse(response.body);
		expect(body.error).toContain("Cannot restart session in 'working' status");
		expect(mockStore.set).not.toHaveBeenCalled();

		server.close();
	});

	it("returns 404 for restart when session does not exist", async () => {
		const mockStore = {
			get: vi.fn(async () => null),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/tars/999/restart",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(404);
		const body = JSON.parse(response.body);
		expect(body.error).toBe("Session not found");

		server.close();
	});

	it("returns 404 for log when admin credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/sessions/mbrooks/tars/1/log",
		});
		expect(response.statusCode).toBe(404);

		server.close();
	});

	it("returns 401 for log without auth header when credentials are configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore(), "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, { method: "GET", path: "/api/sessions/mbrooks/tars/1/log" });
		expect(response.statusCode).toBe(401);
		expect(response.body).toBe("Unauthorized");

		server.close();
	});

	it("returns 404 for log when session does not exist", async () => {
		const mockStore = {
			get: vi.fn(async () => null),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/sessions/mbrooks/tars/999/log",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(404);
		const body = JSON.parse(response.body);
		expect(body.error).toBe("Session not found");

		server.close();
	});

	it("returns log lines when log file exists", async () => {
		const sessionsDir = await mkdtemp(join(tmpdir(), "tars-sessions-"));
		const sessionPath = join(sessionsDir, "github-mbrooks-tars", "issue-1.jsonl");
		await mkdir(join(sessionsDir, "github-mbrooks-tars"), { recursive: true });
		await writeFile(sessionPath, '{"type":"prompt"}\n{"type":"response"}\n');

		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath,
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		try {
			const response = await makeRequest(port, {
				method: "GET",
				path: "/api/sessions/mbrooks/tars/1/log",
				headers: {
					Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
				},
			});
			expect(response.statusCode).toBe(200);
			const body = JSON.parse(response.body);
			expect(body.available).toBe(true);
			expect(body.truncated).toBe(false);
			expect(body.lines).toEqual(['{"type":"prompt"}', '{"type":"response"}']);
		} finally {
			server.close();
			await rm(sessionsDir, { force: true, recursive: true });
		}
	});

	it("returns unavailable log when log file is missing", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath: "/nonexistent/path/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/sessions/mbrooks/tars/1/log",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.available).toBe(false);
		expect(body.error).toBe("Log file not found");

		server.close();
	});

	it("truncates log when it exceeds 10,000 lines", async () => {
		const sessionsDir = await mkdtemp(join(tmpdir(), "tars-sessions-"));
		const sessionPath = join(sessionsDir, "github-mbrooks-tars", "issue-1.jsonl");
		await mkdir(join(sessionsDir, "github-mbrooks-tars"), { recursive: true });
		const lines = Array.from({ length: 10_005 }, (_, i) => `{"line":${i}}`);
		await writeFile(sessionPath, lines.join("\n") + "\n");

		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 1,
				repo: "tars",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath,
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		try {
			const response = await makeRequest(port, {
				method: "GET",
				path: "/api/sessions/mbrooks/tars/1/log",
				headers: {
					Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
				},
			});
			expect(response.statusCode).toBe(200);
			const body = JSON.parse(response.body);
			expect(body.available).toBe(true);
			expect(body.truncated).toBe(true);
			expect(body.totalLines).toBe(10_005);
			expect(body.lines).toHaveLength(10_000);
			expect(body.lines![0]).toBe('{"line":5}');
		} finally {
			server.close();
			await rm(sessionsDir, { force: true, recursive: true });
		}
	});

	it("returns 404 for log with invalid issue number", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore(), "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/sessions/mbrooks/tars/abc/log",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(404);
		const body = JSON.parse(response.body);
		expect(body.error).toBe("Not found");

		server.close();
	});

	it("returns working status via GET /api/status/working", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => [
				{
					issueNumber: 1,
					repo: "tars",
					owner: "mbrooks",
					title: "Test",
					body: "Body",
					status: "working" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-1.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
					lastActivity: new Date().toISOString(),
					seeded: false,
				},
				{
					issueNumber: 2,
					repo: "tars",
					owner: "mbrooks",
					title: "Test",
					body: "Body",
					status: "pending" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-tars/issue-2.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-2",
					lastActivity: new Date().toISOString(),
					seeded: false,
				},
			]),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status/working",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.working).toBe(true);
		expect(body.count).toBe(1);
		expect(body.sessions).toHaveLength(1);
		expect(body.sessions[0].issueNumber).toBe(1);

		server.close();
	});

	it("returns working:false when no sessions are working", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, mockStore, "admin", "secret");
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status/working",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.working).toBe(false);
		expect(body.count).toBe(0);

		server.close();
	});

	it("returns maintenance status via GET /api/maintenance", async () => {
		const taskController = {
			isDraining: vi.fn(() => true),
			setDraining: vi.fn(),
			cancel: vi.fn(),
			isActive: vi.fn(),
			register: vi.fn(),
			unregister: vi.fn(),
		} as unknown as import("../task-controller.js").TaskController;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore(), "admin", "secret", taskController);
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/maintenance",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.draining).toBe(true);

		server.close();
	});

	it("sets draining mode via POST /api/maintenance", async () => {
		const taskController = {
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
			cancel: vi.fn(),
			isActive: vi.fn(),
			register: vi.fn(),
			unregister: vi.fn(),
		} as unknown as import("../task-controller.js").TaskController;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore(), "admin", "secret", taskController);
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/maintenance",
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
				"Content-Type": "application/json",
			},
		},
		JSON.stringify({ enabled: true }));
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.draining).toBe(true);
		expect(taskController.setDraining).toHaveBeenCalledWith(true);

		server.close();
	});

	it("returns 404 for /api/status/working when credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer("secret", handlers, makeMockSessionStore());
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, { method: "GET", path: "/api/status/working" });
		expect(response.statusCode).toBe(404);

		server.close();
	});
});
