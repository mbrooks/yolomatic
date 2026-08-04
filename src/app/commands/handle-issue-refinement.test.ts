import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HandleIssueRefinement, buildNewIssueComment, ISSUE_REFINEMENT_STARTING_COMMENT } from "./handle-issue-refinement.js";
import { RefinementStore } from "../../refinement/store.js";
import { SettingsStore } from "../../settings/store.js";
import { getSessionLogs, _resetSessionLogs } from "../../logging/session-log-store.js";
import type { DockerWorkerExecutor } from "../../executor/docker-worker.js";
import { sessionStorageKey, type SessionKind, type SessionState } from "../../session/store.js";

const REFINEMENT_SESSION_KEY = sessionStorageKey("mbrooks", "yeetomatic", 1, "refinement");

describe("HandleIssueRefinement", () => {
	let tmpDir: string;
	let store: RefinementStore;
	let sessions: ReturnType<typeof createSessionsMock>;
	let github: ReturnType<typeof createGitHubMock>;
	let tasks: ReturnType<typeof createTasksMock>;
	let workspaces: ReturnType<typeof createWorkspacesMock>;
	let executor: ReturnType<typeof createExecutorMock>;
	let handler: HandleIssueRefinement;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "refinement-handler-"));
		store = new RefinementStore(path.join(tmpDir, "refinement.sqlite"));
		sessions = createSessionsMock();
		github = createGitHubMock();
		tasks = createTasksMock();
		workspaces = createWorkspacesMock(tmpDir);
		executor = createExecutorMock();
		_resetSessionLogs();
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
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
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, buildNewIssueComment("yeetomatic-bot", undefined));
		const record = store.getInstructionComment("mbrooks", "yeetomatic", 1);
		expect(record).not.toBeNull();
		const logs = getSessionLogs(REFINEMENT_SESSION_KEY);
		expect(logs.some((l) => l.message === "Posted issue-refinement instructions")).toBe(true);
	});

	it("appends an admin status link to the new-issue comment when enabled", async () => {
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
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
			issueAdminLinkInCommentsEnabled: true,
			adminBaseUrl: "http://host:6767/yeetomatic/admin",
		});
		await handler.postInstructions(createInstructionPayload() as never);
		const expectedUrl = "http://host:6767/yeetomatic/admin#/repos/mbrooks/yeetomatic/issues/1";
		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			1,
			buildNewIssueComment("yeetomatic-bot", expectedUrl),
		);
		expect((github.postComment.mock.calls as unknown as Array<[string, string, number, string]>)[0][3]).toContain(`Track status: ${expectedUrl}`);
	});

	it("re-reads admin link settings from the resolver at each comment without reconstructing the handler", async () => {
		const settingsStore = new SettingsStore(path.join(tmpDir, "bot-state.sqlite"));
		settingsStore.set("admin_base_url", "http://host:6767/old/admin");
		settingsStore.set("issue_admin_link_in_comments_enabled", "true");
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
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
			resolveAdminBaseUrl: () => {
				const raw = settingsStore.get("admin_base_url")?.trim();
				return raw || undefined;
			},
			resolveIssueAdminLinkInCommentsEnabled: () =>
				settingsStore.getBoolean("issue_admin_link_in_comments_enabled", true),
		});

		await handler.postInstructions(createInstructionPayload({ issue: { number: 10, user: { login: "human" } } }) as never);
		expect((github.postComment.mock.calls as unknown as Array<[string, string, number, string]>)[0][3]).toContain(
			"Track status: http://host:6767/old/admin#/repos/mbrooks/yeetomatic/issues/10",
		);

		// Change admin_base_url in the SettingsStore without reconstructing the handler.
		settingsStore.set("admin_base_url", "http://host:6767/new/admin");
		await handler.postInstructions(createInstructionPayload({ issue: { number: 11, user: { login: "human" } } }) as never);
		expect((github.postComment.mock.calls as unknown as Array<[string, string, number, string]>)[1][3]).toContain(
			"Track status: http://host:6767/new/admin#/repos/mbrooks/yeetomatic/issues/11",
		);
		expect((github.postComment.mock.calls as unknown as Array<[string, string, number, string]>)[1][3]).not.toContain(
			"http://host:6767/old/admin",
		);

		// Toggling the feature flag off removes the footer on subsequent comments.
		settingsStore.set("issue_admin_link_in_comments_enabled", "false");
		await handler.postInstructions(createInstructionPayload({ issue: { number: 12, user: { login: "human" } } }) as never);
		expect((github.postComment.mock.calls as unknown as Array<[string, string, number, string]>)[2][3]).not.toContain("Track status:");

		// Toggling it back on restores the footer, still reading the live base URL.
		settingsStore.set("issue_admin_link_in_comments_enabled", "true");
		await handler.postInstructions(createInstructionPayload({ issue: { number: 13, user: { login: "human" } } }) as never);
		expect((github.postComment.mock.calls as unknown as Array<[string, string, number, string]>)[3][3]).toContain(
			"Track status: http://host:6767/new/admin#/repos/mbrooks/yeetomatic/issues/13",
		);
	});

	it("interpolates the configured Yeetomatic username in the new-issue comment", async () => {
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as DockerWorkerExecutor,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "custom-yeet-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: true,
		});
		await handler.postInstructions(createInstructionPayload() as never);
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, buildNewIssueComment("custom-yeet-bot", undefined));
		expect((github.postComment.mock.calls as unknown as Array<[string, string, number, string]>)[0][3]).toContain("custom-yeet-bot");
	});

	it("does not post the automatic comment when issueNewCommentEnabled is false", async () => {
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
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
			issueNewCommentEnabled: false,
		});
		await handler.postInstructions(createInstructionPayload() as never);
		expect(github.postComment).not.toHaveBeenCalled();
		expect(store.getInstructionComment("mbrooks", "yeetomatic", 1)).toBeNull();
		const logs = getSessionLogs(REFINEMENT_SESSION_KEY);
		expect(logs.some((l) => l.message === "Posted issue-refinement instructions")).toBe(false);
	});

	it("still runs the refinement command when issueNewCommentEnabled is false", async () => {
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
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
			issueNewCommentEnabled: false,
		});
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		expect(executor.executeRefinement).toHaveBeenCalled();
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "Refined body");
	});

	it("appends an admin status link to refinement status comments when enabled", async () => {
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
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
			issueAdminLinkInCommentsEnabled: true,
			adminBaseUrl: "http://host:6767/yeetomatic/admin",
		});
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		const expectedUrl = "http://host:6767/yeetomatic/admin#/repos/mbrooks/yeetomatic/issues/1";
		const startingCall = (github.postComment.mock.calls as unknown as Array<[string, string, number, string]>).find((c) => c[3].startsWith(ISSUE_REFINEMENT_STARTING_COMMENT))!;
		expect(startingCall[3]).toContain(`Track status: ${expectedUrl}`);
		const refinedCall = (github.postComment.mock.calls as unknown as Array<[string, string, number, string]>).find((c) => c[3].startsWith("Issue refined at the request of"))!;
		expect(refinedCall[3]).toContain(`Track status: ${expectedUrl}`);
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

	it("persists a working refinement session and completes it after success", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockImplementation(async () => {
			expect(await sessions.get()).toMatchObject({ kind: "refinement", status: "working" });
			return { proposedTaskBody: "Refined body", summary: "Summary", investigation: "Investigation" };
		});

		await handler.execute(createCommandPayload() as never);

		expect(await sessions.get()).toMatchObject({
			kind: "refinement",
			status: "complete",
			summary: "Summary",
			taskStartedAt: "2026-08-01T00:00:00.000Z",
			taskFinishedAt: "2026-08-01T00:00:00.000Z",
		});
	});

	it("does not modify an existing implementation session", async () => {
		const implementation: SessionState = {
			kind: "implementation",
			owner: "mbrooks",
			repo: "yeetomatic",
			issueNumber: 1,
			title: "Implementation",
			body: "Original implementation body",
			status: "waiting-feedback",
			sessionPath: "/tmp/implementation.jsonl",
			workspacePath: "/tmp/implementation",
			branch: "yeetomatic/issue-1",
			prNumber: 99,
			prUrl: "https://github.com/mbrooks/yeetomatic/pull/99",
			lastActivity: "2026-07-31T00:00:00.000Z",
			seeded: true,
		};
		await sessions.save(implementation);
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });

		await handler.execute(createCommandPayload() as never);

		expect(await sessions.get("mbrooks", "yeetomatic", 1, "implementation")).toEqual(implementation);
		expect(await sessions.get("mbrooks", "yeetomatic", 1, "refinement")).toMatchObject({
			kind: "refinement",
			status: "complete",
		});
	});

	it("records activity logs for a successful refinement", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		const logs = getSessionLogs(REFINEMENT_SESSION_KEY);
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
		const logs = getSessionLogs(REFINEMENT_SESSION_KEY);
		expect(logs.some((l) => l.level === "warn" && l.message.includes("not a repository collaborator"))).toBe(true);
		expect(logs.some((l) => l.message === "Refinement started")).toBe(false);
	});

	it("records a warning activity log when an implementation task is active", async () => {
		tasks.isActive.mockReturnValue(true);
		await handler.execute(createCommandPayload() as never);
		const logs = getSessionLogs(REFINEMENT_SESSION_KEY);
		expect(logs.some((l) => l.level === "warn" && l.message.includes("implementation task is active"))).toBe(true);
	});

	it("records an error activity log when the worker fails", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockRejectedValue(new Error("worker crashed"));
		await handler.execute(createCommandPayload() as never);
		const logs = getSessionLogs(REFINEMENT_SESSION_KEY);
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
		const logs = getSessionLogs(REFINEMENT_SESSION_KEY);
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
		expect(github.isCollaborator).toHaveBeenCalledWith("mbrooks", "yeetomatic", "user");
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "Only repository collaborators can run issue refinement.");
	});

	it("allows refinement from a repository owner with admin permission", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		github.isCollaborator.mockResolvedValue(true);
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

		expect(github.isCollaborator).toHaveBeenCalledWith("mbrooks", "yeetomatic", "repo-owner");
		expect(executor.executeRefinement).toHaveBeenCalled();
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "Refined body");
		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			1,
			"Issue refined at the request of @repo-owner. The issue body now contains the Proposed Task. No implementation session was started.",
		);
	});

	it("allows refinement from a write-permission collaborator when isCollaborator is true", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		github.getCollaboratorPermissionLevel.mockResolvedValue("write");
		github.isCollaborator.mockResolvedValue(true);
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(
			createCommandPayload({
				sender: { login: "contributor" },
				comment: { id: 106, body: "/yeetomatic issue-refinement", user: { login: "contributor" } },
			}) as never,
		);

		expect(github.isCollaborator).toHaveBeenCalledWith("mbrooks", "yeetomatic", "contributor");
		expect(executor.executeRefinement).toHaveBeenCalled();
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "Refined body");
	});

	it("rejects refinement from a non-collaborator who is not the admin username", async () => {
		github.isCollaborator.mockResolvedValue(false);
		await handler.execute(
			createCommandPayload({
				sender: { login: "outsider" },
				comment: { id: 107, body: "/yeetomatic issue-refinement", user: { login: "outsider" } },
			}) as never,
		);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
		expect(github.isCollaborator).toHaveBeenCalledWith("mbrooks", "yeetomatic", "outsider");
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "Only repository collaborators can run issue refinement.");
	});

	it("authorizes the configured admin username even when isCollaborator returns false", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		github.isCollaborator.mockResolvedValue(false);
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		expect(github.isCollaborator).not.toHaveBeenCalled();
		expect(executor.executeRefinement).toHaveBeenCalled();
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "Refined body");
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

	it("ignores comments that do not start with the refinement command", async () => {
		await handler.execute(
			createCommandPayload({
				comment: { id: 102, body: "Please run /yeetomatic issue-refinement", user: { login: "admin" } },
			}) as never,
		);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
	});

	it("threads a steering prompt from trailing text into the worker prompt and attempt", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(
			createCommandPayload({
				comment: { id: 108, body: "/yeetomatic issue-refinement Focus on rollback", user: { login: "admin" } },
			}) as never,
			"Focus on rollback",
		);

		expect(executor.executeRefinement).toHaveBeenCalledWith(expect.anything(), undefined, "Focus on rollback");
		const attempt = store.getLatestAttempt("mbrooks", "yeetomatic", 1);
		expect(attempt).not.toBeNull();
		expect(attempt!.steeringPrompt).toBe("Focus on rollback");
	});

	it("records the steering prompt in the command-received log entry", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(
			createCommandPayload({
				comment: { id: 109, body: "/yeetomatic issue-refinement add criteria", user: { login: "admin" } },
			}) as never,
			"add criteria",
		);

		const logs = getSessionLogs(REFINEMENT_SESSION_KEY);
		const entry = logs.find((l) => l.message === "Refinement command received from @admin");
		expect(entry).toBeDefined();
		expect(entry!.details).toEqual({ steeringPrompt: "add criteria" });
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

	it("does not overlap with a persisted working implementation session", async () => {
		await sessions.save({
			kind: "implementation",
			owner: "mbrooks",
			repo: "yeetomatic",
			issueNumber: 1,
			title: "Test",
			body: "Body",
			status: "working",
			sessionPath: "/tmp/session.jsonl",
			workspacePath: "/tmp/workspace",
			lastActivity: new Date().toISOString(),
			seeded: false,
		});

		await handler.execute(createCommandPayload() as never);

		expect(executor.executeRefinement).not.toHaveBeenCalled();
		expect(tasks.register).not.toHaveBeenCalled();
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
		expect(await sessions.get()).toMatchObject({ status: "failed", staleReason: "issue closed during refinement" });
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
		expect(await sessions.get()).toMatchObject({ status: "failed", staleReason: "issue body changed during refinement" });
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
			"",
		);
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, "Skill-refined body");
	});

	it("ignores command when repository is not managed", async () => {
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
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
			sessions: sessions as never,
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
		expect(await sessions.get()).toMatchObject({ status: "failed", staleReason: "worker crashed" });
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
			sessions: sessions as never,
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
			isCollaborator: vi.fn(async (): Promise<boolean> => false),
		};
	}

	function createSessionsMock() {
		const states = new Map<SessionKind, SessionState>();
		return {
			get: vi.fn(async (_owner?: string, _repo?: string, _issueNumber?: number, kind?: SessionKind) =>
				kind ? states.get(kind) ?? null : states.get("refinement") ?? states.get("implementation") ?? null,
			),
			save: vi.fn(async (state: SessionState) => {
				states.set(state.kind ?? "implementation", state);
				return state;
			}),
			createSession: vi.fn(async (owner, repo, issueNumber, title, body, workspacePath, kind: SessionKind, labels) => {
				let current = states.get(kind);
				if (!current) {
					current = {
						kind,
						owner,
						repo,
						issueNumber,
						title,
						body,
						status: "pending",
						sessionPath: `/tmp/issue-${issueNumber}.jsonl`,
						workspacePath,
						lastActivity: new Date().toISOString(),
						seeded: false,
						labels,
					};
					states.set(kind, current);
				}
				return current;
			}),
			updateStatus: vi.fn(async (_owner, _repo, _issueNumber, status, updates = {}, kind: SessionKind = "implementation") => {
				const current = states.get(kind);
				if (!current) throw new Error("No session");
				const updated = { ...current, ...updates, status, lastActivity: new Date().toISOString() };
				states.set(kind, updated);
				return updated;
			}),
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
