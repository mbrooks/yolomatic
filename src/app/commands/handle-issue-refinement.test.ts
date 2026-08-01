import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HandleIssueRefinement, ISSUE_REFINEMENT_INSTRUCTIONS, ISSUE_REFINEMENT_STARTING_COMMENT } from "./handle-issue-refinement.js";
import { RefinementStore } from "../../refinement/store.js";
import { getSessionLogs, _resetSessionLogs } from "../../logging/session-log-store.js";
import type { DockerWorkerExecutor } from "../../executor/docker-worker.js";

describe("HandleIssueRefinement", () => {
	let tmpDir: string;
	let store: RefinementStore;
	let github: ReturnType<typeof createGitHubMock>;
	let tasks: ReturnType<typeof createTasksMock>;
	let workspaces: ReturnType<typeof createWorkspacesMock>;
	let executor: ReturnType<typeof createExecutorMock>;
	let handler: HandleIssueRefinement;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "refinement-handler-"));
		store = new RefinementStore(path.join(tmpDir, "refinement.sqlite"));
		github = createGitHubMock();
		tasks = createTasksMock();
		workspaces = createWorkspacesMock(tmpDir);
		executor = createExecutorMock();
		_resetSessionLogs();
		handler = new HandleIssueRefinement({
			refinementStore: store,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as DockerWorkerExecutor,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yeetomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: true,
		});
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
		_resetSessionLogs();
	});

	function createInstructionPayload(overrides?: Record<string, unknown>) {
		return {
			action: "opened",
			issue: {
				number: 1,
				title: "Test",
				body: "Body",
				labels: [],
				assignee: null,
				assignees: [],
				user: { login: "human" },
			},
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "human" },
			...overrides,
		};
	}

	function createCommandPayload(overrides?: Record<string, unknown>) {
		return {
			action: "created",
			issue: {
				number: 1,
				state: "open",
				title: "Test",
				body: "Body",
				labels: [],
				assignee: null,
				assignees: [],
				user: { login: "human" },
			},
			comment: { id: 100, body: "/yeetomatic issue-refinement", user: { login: "admin" } },
			repository: { name: "yeetomatic", owner: { login: "mbrooks" } },
			sender: { login: "admin" },
			...overrides,
		};
	}

	it("posts instructions for an eligible opened issue", async () => {
		await handler.postInstructions(createInstructionPayload() as never);
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, ISSUE_REFINEMENT_INSTRUCTIONS);
		const record = store.getInstructionComment("mbrooks", "yeetomatic", 1);
		expect(record).not.toBeNull();
		const logs = getSessionLogs("mbrooks/yeetomatic#1");
		expect(logs.some((l) => l.message === "Posted issue-refinement instructions")).toBe(true);
	});

	it("does not post instructions twice for the same issue", async () => {
		await handler.postInstructions(createInstructionPayload() as never);
		await handler.postInstructions(createInstructionPayload() as never);
		expect(github.postComment).toHaveBeenCalledTimes(1);
	});

	it("does not post instructions for issues opened by the bot", async () => {
		await handler.postInstructions(createInstructionPayload({ issue: { user: { login: "yeetomatic-bot" } } }) as never);
		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("executes refinement for an admin command", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		expect(workspaces.createRefinementWorktree).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1);
		expect(executor.executeRefinement).toHaveBeenCalled();
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "Refined body");
		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			1,
			"Issue refined at the request of @admin. The issue body now contains the Proposed Task. No implementation session was started.",
		);
		const attempt = store.getLatestAttempt("mbrooks", "yeetomatic", 1);
		expect(attempt).not.toBeNull();
		expect(attempt!.state).toBe("applied");
	});

	it("records activity logs for a successful refinement", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		const logs = getSessionLogs("mbrooks/yeetomatic#1");
		const messages = logs.map((l) => l.message);
		expect(messages).toContain("Refinement command received from @admin");
		expect(messages).toContain("Refinement started");
		expect(messages).toContain("Created refinement attempt");
		expect(messages).toContain("Refinement worker returned a proposed task");
		expect(messages).toContain("Applied refined issue body");
		expect(messages).toContain("Refinement finished");
		expect(messages.some((m) => m.startsWith("Refinement rejected"))).toBe(false);
	});

	it("records a warning activity log when a non-owner runs refinement", async () => {
		await handler.execute(
			createCommandPayload({
				sender: { login: "user" },
				comment: { id: 101, body: "/yeetomatic issue-refinement", user: { login: "user" } },
			}) as never,
		);
		const logs = getSessionLogs("mbrooks/yeetomatic#1");
		expect(logs.some((l) => l.level === "warn" && l.message.includes("not a repository owner"))).toBe(true);
		expect(logs.some((l) => l.message === "Refinement started")).toBe(false);
	});

	it("records a warning activity log when an implementation task is active", async () => {
		tasks.isActive.mockReturnValue(true);
		await handler.execute(createCommandPayload() as never);
		const logs = getSessionLogs("mbrooks/yeetomatic#1");
		expect(logs.some((l) => l.level === "warn" && l.message.includes("implementation task is active"))).toBe(true);
	});

	it("records an error activity log when the worker fails", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockRejectedValue(new Error("worker crashed"));
		await handler.execute(createCommandPayload() as never);
		const logs = getSessionLogs("mbrooks/yeetomatic#1");
		expect(logs.some((l) => l.level === "error" && l.message.startsWith("Refinement failed"))).toBe(true);
	});

	it("records a stale activity log when the issue body changes during refinement", async () => {
		github.getIssue
			.mockResolvedValueOnce({ state: "open", body: "Body" })
			.mockResolvedValueOnce({ state: "open", body: "Modified body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});
		await handler.execute(createCommandPayload() as never);
		const logs = getSessionLogs("mbrooks/yeetomatic#1");
		expect(logs.some((l) => l.level === "warn" && l.message.includes("marked stale"))).toBe(true);
		expect(logs.some((l) => l.message === "Applied refined issue body")).toBe(false);
	});
	it("rejects refinement from non-admin users", async () => {
		await handler.execute(
			createCommandPayload({
				sender: { login: "user" },
				comment: { id: 101, body: "/yeetomatic issue-refinement", user: { login: "user" } },
			}) as never,
		);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
		expect(github.getCollaboratorPermissionLevel).toHaveBeenCalledWith("mbrooks", "yeetomatic", "user");
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "Only repository owners can run issue refinement.");
	});

	it("allows refinement from a repository owner with admin permission", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		github.getCollaboratorPermissionLevel.mockResolvedValue("admin");
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(
			createCommandPayload({
				sender: { login: "repo-owner" },
				comment: { id: 105, body: "/yeetomatic issue-refinement", user: { login: "repo-owner" } },
			}) as never,
		);

		expect(github.getCollaboratorPermissionLevel).toHaveBeenCalledWith("mbrooks", "yeetomatic", "repo-owner");
		expect(executor.executeRefinement).toHaveBeenCalled();
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "Refined body");
		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			1,
			"Issue refined at the request of @repo-owner. The issue body now contains the Proposed Task. No implementation session was started.",
		);
	});

	it("rejects refinement from a collaborator without admin permission", async () => {
		github.getCollaboratorPermissionLevel.mockResolvedValue("write");
		await handler.execute(
			createCommandPayload({
				sender: { login: "contributor" },
				comment: { id: 106, body: "/yeetomatic issue-refinement", user: { login: "contributor" } },
			}) as never,
		);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "Only repository owners can run issue refinement.");
	});

	it("posts a starting comment immediately when refinement begins", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		const startCallCount: number[] = [];
		executor.executeRefinement.mockImplementation(async () => {
			const calls = github.postComment.mock.calls as unknown as Array<[string, string, number, string]>;
			startCallCount.push(calls.filter((c) => c[3] === ISSUE_REFINEMENT_STARTING_COMMENT).length);
			return { proposedTaskBody: "Refined body", summary: "Summary", investigation: "Investigation" };
		});

		await handler.execute(createCommandPayload() as never);

		expect(startCallCount[0]).toBeGreaterThanOrEqual(1);
		const calls = github.postComment.mock.calls as unknown as Array<[string, string, number, string]>;
		expect(calls[0][3]).toBe(ISSUE_REFINEMENT_STARTING_COMMENT);
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, ISSUE_REFINEMENT_STARTING_COMMENT);
	});

	it("does not post a starting comment when the task key is already claimed", async () => {
		tasks.register.mockReturnValue(null as never);
		await handler.execute(createCommandPayload() as never);
		expect(github.postComment).not.toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, ISSUE_REFINEMENT_STARTING_COMMENT);
	});

	it("does not post a starting comment for non-admin users", async () => {
		await handler.execute(
			createCommandPayload({
				sender: { login: "user" },
				comment: { id: 101, body: "/yeetomatic issue-refinement", user: { login: "user" } },
			}) as never,
		);
		expect(github.postComment).not.toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, ISSUE_REFINEMENT_STARTING_COMMENT);
	});

	it("ignores non-exact refinement commands", async () => {
		await handler.execute(
			createCommandPayload({
				comment: { id: 102, body: "/yeetomatic issue-refinement please", user: { login: "admin" } },
			}) as never,
		);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
	});

	it("does not overlap with active implementation", async () => {
		tasks.isActive.mockReturnValue(true);
		await handler.execute(createCommandPayload() as never);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			1,
			"Yeetomatic is currently working on this issue. Refinement cannot overlap with implementation.",
		);
	});

	it("marks stale when the issue is closed during refinement", async () => {
		github.getIssue.mockResolvedValueOnce({ state: "open", body: "Body" }).mockResolvedValueOnce({ state: "closed", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		expect(github.updateIssueBody).not.toHaveBeenCalled();
		const attempt = store.getLatestAttempt("mbrooks", "yeetomatic", 1);
		expect(attempt!.state).toBe("stale");
	});

	it("marks stale when the issue body changes during refinement", async () => {
		github.getIssue
			.mockResolvedValueOnce({ state: "open", body: "Body" })
			.mockResolvedValueOnce({ state: "open", body: "Modified body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		expect(github.updateIssueBody).not.toHaveBeenCalled();
		const attempt = store.getLatestAttempt("mbrooks", "yeetomatic", 1);
		expect(attempt!.state).toBe("stale");
	});

	it("uses repository skill when present", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Skill-refined body",
			summary: "Summary",
			investigation: "Investigation",
		});
		workspaces.createRefinementWorktree.mockResolvedValue(path.join(tmpDir, "refinement", "issue-1"));

		const skillDir = path.join(tmpDir, "refinement", "issue-1", ".pi", "skills", "issue-refinement");
		await import("node:fs/promises").then((fs) => fs.mkdir(skillDir, { recursive: true }));
		await import("node:fs/promises").then((fs) => fs.writeFile(path.join(skillDir, "SKILL.md"), "Skill instructions", "utf-8"));

		await handler.execute(createCommandPayload() as never);

		expect(executor.executeRefinement).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining("Skill instructions"),
		);
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "Skill-refined body");
	});

	it("ignores command when repository is not managed", async () => {
		handler = new HandleIssueRefinement({
			refinementStore: store,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as DockerWorkerExecutor,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yeetomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => false,
			refinementEnabled: true,
		});
		await handler.execute(createCommandPayload() as never);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
	});

	it("ignores command when refinement is disabled", async () => {
		handler = new HandleIssueRefinement({
			refinementStore: store,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as DockerWorkerExecutor,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yeetomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: false,
		});
		await handler.execute(createCommandPayload() as never);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
	});

	it("fails when the task key is already claimed", async () => {
		tasks.register.mockReturnValue(null as never);
		await handler.execute(createCommandPayload() as never);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			1,
			"Yeetomatic is currently active on this issue. Refinement cannot overlap with implementation.",
		);
	});

	it("rejects oversized proposed bodies", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "x".repeat(65536),
			summary: "Summary",
			investigation: "Investigation",
		});
		await handler.execute(createCommandPayload() as never);
		expect(github.updateIssueBody).not.toHaveBeenCalled();
		const attempt = store.getLatestAttempt("mbrooks", "yeetomatic", 1);
		expect(attempt!.state).toBe("failed");
	});

	it("reports failure when the worker throws", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockRejectedValue(new Error("worker crashed"));
		await handler.execute(createCommandPayload() as never);
		expect(github.updateIssueBody).not.toHaveBeenCalled();
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "Refinement failed: worker crashed");
		const attempt = store.getLatestAttempt("mbrooks", "yeetomatic", 1);
		expect(attempt!.state).toBe("failed");
	});

	it("ignores non-created comment actions", async () => {
		await handler.execute(createCommandPayload({ action: "edited" }) as never);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
	});

	it("ignores comments from the bot account", async () => {
		await handler.execute(
			createCommandPayload({ comment: { id: 103, body: "/yeetomatic issue-refinement", user: { login: "yeetomatic-bot" } } }) as never,
		);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
	});

	it("ignores comments from bot-typed users", async () => {
		await handler.execute(
			createCommandPayload({
				comment: { id: 104, body: "/yeetomatic issue-refinement", user: { login: "some-bot", type: "Bot" } },
			}) as never,
		);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
	});

	it("ignores refinement commands on pull requests", async () => {
		await handler.execute(
			createCommandPayload({ issue: { pull_request: { url: "https://api.github.com/repos/mbrooks/yeetomatic/pulls/1" } } }) as never,
		);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
	});

	it("ignores refinement commands on closed issues", async () => {
		await handler.execute(createCommandPayload({ issue: { state: "closed" } }) as never);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
	});

	it("does not post instructions for non-opened actions", async () => {
		await handler.postInstructions(createInstructionPayload({ action: "edited" }) as never);
		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("does not post instructions when refinement is disabled", async () => {
		handler = new HandleIssueRefinement({
			refinementStore: store,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as DockerWorkerExecutor,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yeetomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: false,
		});
		await handler.postInstructions(createInstructionPayload() as never);
		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("does not post instructions for issues assigned to the bot", async () => {
		await handler.postInstructions(
			createInstructionPayload({ issue: { assignees: [{ login: "yeetomatic-bot" }] } }) as never,
		);
		expect(github.postComment).not.toHaveBeenCalled();
	});

	function createGitHubMock() {
		return {
			postComment: vi.fn(async () => 1),
			updateIssueBody: vi.fn(async () => {}),
			getIssue: vi.fn(async () => ({ state: "open", body: "Body" })),
			getCollaboratorPermissionLevel: vi.fn(async (): Promise<import("../../ports/github-service.js").CollaboratorPermission | null> => null),
		};
	}

	function createTasksMock() {
		return {
			isActive: vi.fn(() => false),
			register: vi.fn(() => Symbol("reg")),
			unregister: vi.fn(),
			steer: vi.fn(),
			cancel: vi.fn(),
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		};
	}

	function createWorkspacesMock(tmp: string) {
		return {
			getWorktreePath: vi.fn((owner: string, repo: string, issueNumber: number) =>
				path.join(tmp, `${owner}-${repo}`, ".worktrees", `issue-${issueNumber}`),
			),
			createRefinementWorktree: vi.fn(async () => path.join(tmp, "refinement", "issue-1")),
			removeRefinementWorktree: vi.fn(async () => {}),
		};
	}

	function createExecutorMock() {
		return {
			executeRefinement: vi.fn(async () => ({
				proposedTaskBody: "Body",
				summary: "Summary",
				investigation: "Investigation",
			})),
		};
	}
});
