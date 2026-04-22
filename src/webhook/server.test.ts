import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { verifySignature } from "./server.js";
import { GitHubIssueHandlers } from "./handlers.js";

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
			pulls: {
				create: vi.fn(async () => ({ data: { html_url: "https://github.com/mbrooks/tars/pull/1" } })),
			},
			reactions: {
				createForIssue: vi.fn(async () => ({})),
				createForIssueComment: vi.fn(async () => ({})),
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
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-42",
				branch: "tars/issue-42",
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 42,
			})),
			commitAndPush: vi.fn(async () => undefined),
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
			githubUsername: "mbrooks",
			autoStart: true,
			defaultBranch: "main",
			octokit: octokit as never,
		});

		// Should resume on tars-feedback-required
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "tars-feedback-required" }], assignees: [{ login: "mbrooks" }] },
			comment: { id: 101, body: "Here is the missing detail", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(1);
		expect(workspaceManager.commitAndPush).toHaveBeenCalledWith("mbrooks", "tars", 42);

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
			issue: { number: 42, labels: [{ name: "tars-pr-created" }], assignees: [{ login: "mbrooks" }] },
			comment: { id: 102, body: "Can you also add tests?", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(2);

		// Should ignore non-TARS labels
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "bug" }], assignees: [{ login: "mbrooks" }] },
			comment: { id: 103, body: "Just chatting", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(2);

		// Should ignore bot comments
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "tars-pr-created" }], assignees: [{ login: "mbrooks" }] },
			comment: { id: 104, body: "LGTM", user: { login: "tars-bot", type: "Bot" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "tars-bot" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(2);

		// Should ignore comments on issues not assigned to TARS
		await handlers.handleCommentEvent({
			action: "created",
			issue: { number: 42, labels: [{ name: "tars-pr-created" }], assignees: [{ login: "someone-else" }] },
			comment: { id: 105, body: "Help", user: { login: "mbrooks" } },
			repository: { name: "tars", owner: { login: "mbrooks" } },
			sender: { login: "other-user" },
		});

		expect(executor.execute).toHaveBeenCalledTimes(2);
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
			reactions: {
				createForIssue: vi.fn(async () => ({})),
				createForIssueComment: vi.fn(async () => ({})),
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
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				branch: "tars/issue-1",
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 1,
			})),
			commitAndPush: vi.fn(),
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
		// Should react for pickup and comment for completion (2 total interactions, not 4 comments)
		expect(octokit.issues.createComment).toHaveBeenCalledTimes(1);
		expect(octokit.reactions.createForIssue).toHaveBeenCalledTimes(1);
		expect(octokit.reactions.createForIssue).toHaveBeenCalledWith(
			expect.objectContaining({ content: "eyes" }),
		);
	});

	it("ignores events triggered by the configured GitHub user", async () => {
		const octokit = {
			issues: {
				addLabels: vi.fn(async () => ({})),
				removeLabel: vi.fn().mockResolvedValue({}),
				createComment: vi.fn(async () => ({})),
			},
			reactions: {
				createForIssue: vi.fn(async () => ({})),
				createForIssueComment: vi.fn(async () => ({})),
			},
		};
		const sessionManager = {
			createSession: vi.fn(),
			getSession: vi.fn(),
			updateStatus: vi.fn(),
			markSeeded: vi.fn(),
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(),
			commitAndPush: vi.fn(),
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
			comment: { id: 201, body: "Update", user: { login: "tars-bot" } },
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
			reactions: {
				createForIssue: vi.fn(async () => ({})),
				createForIssueComment: vi.fn(async () => ({})),
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
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				branch: "tars/issue-1",
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 1,
			})),
			commitAndPush: vi.fn(async () => undefined),
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
		};
		const workspaceManager = {
			createOrGetWorktree: vi.fn(async () => ({
				path: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-7",
				branch: "tars/issue-7",
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 7,
			})),
			commitAndPush: vi.fn(),
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
});
