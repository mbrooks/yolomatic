import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HandleIssueRefinement, buildNewIssueComment, ISSUE_REFINEMENT_STARTING_COMMENT } from "./handle-issue-refinement.js";
import { RefinementStore } from "../../refinement/store.js";
import { SettingsStore } from "../../settings/store.js";
import { getSessionLogs, _resetSessionLogs } from "../../logging/session-log-store.js";
import type { RefinementExecutionService } from "../../ports/execution-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import { sessionStorageKey, type SessionKind, type SessionState } from "../../session/store.js";

const REFINEMENT_SESSION_KEY = sessionStorageKey("mbrooks", "yolomatic", 1, "refinement");

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
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
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
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
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
			comment: { id: 100, body: "/yolomatic issue-refinement", user: { login: "admin" } },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "admin" },
			...overrides,
		};
	}

	it("drives refinement through a non-Docker fake satisfying the refinement execution port", async () => {
		const portFake: RefinementExecutionService = {
			executeRefinement: vi.fn(async () => ({
				proposedTaskBody: "Port-refined body",
				summary: "Summary",
				investigation: "Investigation",
			})),
		};
		const portHandler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: portFake,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: true,
		});
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });

		await portHandler.execute(createCommandPayload() as never);

		expect(portFake.executeRefinement).toHaveBeenCalled();
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "Port-refined body");
	});

	it("posts instructions for an eligible opened issue", async () => {
		await handler.postInstructions(createInstructionPayload() as never);
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, buildNewIssueComment("yolomatic-bot", undefined));
		const record = store.getInstructionComment("mbrooks", "yolomatic", 1);
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
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: true,
			issueAdminLinkInCommentsEnabled: true,
			adminBaseUrl: "http://host:6767/yolomatic/admin",
		});
		await handler.postInstructions(createInstructionPayload() as never);
		const expectedUrl = "http://host:6767/yolomatic/admin#/repos/mbrooks/yolomatic/issues/1";
		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			buildNewIssueComment("yolomatic-bot", expectedUrl),
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
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
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
			"Track status: http://host:6767/old/admin#/repos/mbrooks/yolomatic/issues/10",
		);

		// Change admin_base_url in the SettingsStore without reconstructing the handler.
		settingsStore.set("admin_base_url", "http://host:6767/new/admin");
		await handler.postInstructions(createInstructionPayload({ issue: { number: 11, user: { login: "human" } } }) as never);
		expect((github.postComment.mock.calls as unknown as Array<[string, string, number, string]>)[1][3]).toContain(
			"Track status: http://host:6767/new/admin#/repos/mbrooks/yolomatic/issues/11",
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
			"Track status: http://host:6767/new/admin#/repos/mbrooks/yolomatic/issues/13",
		);
	});

	it("interpolates the configured Yolomatic username in the new-issue comment", async () => {
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "custom-yolo-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: true,
		});
		await handler.postInstructions(createInstructionPayload() as never);
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, buildNewIssueComment("custom-yolo-bot", undefined));
		expect((github.postComment.mock.calls as unknown as Array<[string, string, number, string]>)[0][3]).toContain("custom-yolo-bot");
	});

	it("includes the /yolomatic feedback command in the new-issue comment", async () => {
		await handler.postInstructions(createInstructionPayload() as never);
		const posted = (github.postComment.mock.calls as unknown as Array<[string, string, number, string]>)[0][3];
		expect(posted).toContain("/yolomatic feedback");
		expect(posted).toContain("steer");
		// Ordering: feedback is documented between assign and issue-refinement.
		expect(posted.indexOf("/yolomatic feedback")).toBeLessThan(posted.indexOf("/yolomatic issue-refinement"));
		expect(posted.indexOf("Assign the issue")).toBeLessThan(posted.indexOf("/yolomatic feedback"));
	});

	it("does not post the automatic comment when issueNewCommentEnabled is false", async () => {
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: true,
			issueNewCommentEnabled: false,
		});
		await handler.postInstructions(createInstructionPayload() as never);
		expect(github.postComment).not.toHaveBeenCalled();
		expect(store.getInstructionComment("mbrooks", "yolomatic", 1)).toBeNull();
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
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
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
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "Refined body");
	});

	it("appends an admin status link to refinement status comments when enabled", async () => {
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: true,
			issueAdminLinkInCommentsEnabled: true,
			adminBaseUrl: "http://host:6767/yolomatic/admin",
		});
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		const expectedIssueUrl = "http://host:6767/yolomatic/admin#/repos/mbrooks/yolomatic/issues/1";
		const expectedSessionUrl = "http://host:6767/yolomatic/admin#/repos/mbrooks/yolomatic/1/refinement";
		const startingCall = (github.postComment.mock.calls as unknown as Array<[string, string, number, string]>).find((c) => c[3].startsWith(ISSUE_REFINEMENT_STARTING_COMMENT))!;
		expect(startingCall[3]).toContain(`Track status: ${expectedSessionUrl}`);
		expect(startingCall[3]).not.toContain(expectedIssueUrl);
		const refinedCall = (github.postComment.mock.calls as unknown as Array<[string, string, number, string]>).find((c) => c[3].startsWith("Issue refined at the request of"))!;
		expect(refinedCall[3]).toContain(`Track status: ${expectedIssueUrl}`);
		expect(refinedCall[3]).not.toContain(expectedSessionUrl);
	});

	it("omits the Track status footer from the refinement pickup comment when the toggle is disabled", async () => {
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: true,
			issueAdminLinkInCommentsEnabled: false,
			adminBaseUrl: "http://host:6767/yolomatic/admin",
		});
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		const startingCall = (github.postComment.mock.calls as unknown as Array<[string, string, number, string]>).find((c) => c[3].startsWith(ISSUE_REFINEMENT_STARTING_COMMENT))!;
		expect(startingCall[3]).toBe(ISSUE_REFINEMENT_STARTING_COMMENT);
		expect(startingCall[3]).not.toContain("Track status:");
	});

	it("does not post instructions twice for the same issue", async () => {
		await handler.postInstructions(createInstructionPayload() as never);
		await handler.postInstructions(createInstructionPayload() as never);
		expect(github.postComment).toHaveBeenCalledTimes(1);
	});

	it("does not post instructions for issues opened by the bot", async () => {
		await handler.postInstructions(createInstructionPayload({ issue: { user: { login: "yolomatic-bot" } } }) as never);
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

		expect(workspaces.createRefinementWorktree).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
		expect(executor.executeRefinement).toHaveBeenCalled();
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "Refined body");
		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			"Issue refined at the request of @admin. The issue body now contains the Proposed Task. No implementation session was started.",
		);
		const attempt = store.getLatestAttempt("mbrooks", "yolomatic", 1);
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
			repo: "yolomatic",
			issueNumber: 1,
			title: "Implementation",
			body: "Original implementation body",
			status: "waiting-feedback",
			sessionPath: "/tmp/implementation.jsonl",
			workspacePath: "/tmp/implementation",
			branch: "yolomatic/issue-1",
			prNumber: 99,
			prUrl: "https://github.com/mbrooks/yolomatic/pull/99",
			lastActivity: "2026-07-31T00:00:00.000Z",
			seeded: true,
		};
		await sessions.save(implementation);
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });

		await handler.execute(createCommandPayload() as never);

		expect(await sessions.get("mbrooks", "yolomatic", 1, "implementation")).toEqual(implementation);
		expect(await sessions.get("mbrooks", "yolomatic", 1, "refinement")).toMatchObject({
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
				comment: { id: 101, body: "/yolomatic issue-refinement", user: { login: "user" } },
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
				comment: { id: 101, body: "/yolomatic issue-refinement", user: { login: "user" } },
			}) as never,
		);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
		expect(github.isCollaborator).toHaveBeenCalledWith("mbrooks", "yolomatic", "user");
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "Only repository collaborators can run issue refinement.");
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
				comment: { id: 105, body: "/yolomatic issue-refinement", user: { login: "repo-owner" } },
			}) as never,
		);

		expect(github.isCollaborator).toHaveBeenCalledWith("mbrooks", "yolomatic", "repo-owner");
		expect(executor.executeRefinement).toHaveBeenCalled();
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "Refined body");
		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
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
				comment: { id: 106, body: "/yolomatic issue-refinement", user: { login: "contributor" } },
			}) as never,
		);

		expect(github.isCollaborator).toHaveBeenCalledWith("mbrooks", "yolomatic", "contributor");
		expect(executor.executeRefinement).toHaveBeenCalled();
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "Refined body");
	});

	it("rejects refinement from a non-collaborator who is not the admin username", async () => {
		github.isCollaborator.mockResolvedValue(false);
		await handler.execute(
			createCommandPayload({
				sender: { login: "outsider" },
				comment: { id: 107, body: "/yolomatic issue-refinement", user: { login: "outsider" } },
			}) as never,
		);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
		expect(github.isCollaborator).toHaveBeenCalledWith("mbrooks", "yolomatic", "outsider");
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "Only repository collaborators can run issue refinement.");
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
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "Refined body");
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
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ISSUE_REFINEMENT_STARTING_COMMENT);
	});

	it("does not post a starting comment when the task key is already claimed", async () => {
		tasks.register.mockReturnValue(null as never);
		await handler.execute(createCommandPayload() as never);
		expect(github.postComment).not.toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ISSUE_REFINEMENT_STARTING_COMMENT);
	});

	it("does not post a starting comment for non-admin users", async () => {
		await handler.execute(
			createCommandPayload({
				sender: { login: "user" },
				comment: { id: 101, body: "/yolomatic issue-refinement", user: { login: "user" } },
			}) as never,
		);
		expect(github.postComment).not.toHaveBeenCalledWith("mbrooks", "yolomatic", 1, ISSUE_REFINEMENT_STARTING_COMMENT);
	});

	it("ignores comments that do not start with the refinement command", async () => {
		await handler.execute(
			createCommandPayload({
				comment: { id: 102, body: "Please run /yolomatic issue-refinement", user: { login: "admin" } },
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
				comment: { id: 108, body: "/yolomatic issue-refinement Focus on rollback", user: { login: "admin" } },
			}) as never,
			"Focus on rollback",
		);

		expect(executor.executeRefinement).toHaveBeenCalledWith(expect.anything(), undefined, "Focus on rollback");
		const attempt = store.getLatestAttempt("mbrooks", "yolomatic", 1);
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
				comment: { id: 109, body: "/yolomatic issue-refinement add criteria", user: { login: "admin" } },
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
			"yolomatic",
			1,
			"Yolomatic is currently working on this issue. Refinement cannot overlap with implementation.",
		);
	});

	it("does not overlap with a persisted working implementation session", async () => {
		await sessions.save({
			kind: "implementation",
			owner: "mbrooks",
			repo: "yolomatic",
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
		const attempt = store.getLatestAttempt("mbrooks", "yolomatic", 1);
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
		const attempt = store.getLatestAttempt("mbrooks", "yolomatic", 1);
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
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "Skill-refined body");
	});

	it("ignores command when repository is not managed", async () => {
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
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
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
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
			"yolomatic",
			1,
			"Yolomatic is currently active on this issue. Refinement cannot overlap with implementation.",
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
		const attempt = store.getLatestAttempt("mbrooks", "yolomatic", 1);
		expect(attempt!.state).toBe("failed");
	});

	it("applies a proposed title when the worker returns a changed one", async () => {
		github.getIssue.mockResolvedValue({ state: "open", title: "Test", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			proposedTitle: "Clearer Title",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "Refined body");
		expect(github.updateIssueTitle).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "Clearer Title");
		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			"Issue refined at the request of @admin. The issue title and body now contain the Proposed Task. No implementation session was started.",
		);
		const attempt = store.getLatestAttempt("mbrooks", "yolomatic", 1);
		expect(attempt!.state).toBe("applied");
		expect(attempt!.proposedTitle).toBe("Clearer Title");
	});

	it("does not apply a title when the worker omits proposedTitle", async () => {
		github.getIssue.mockResolvedValue({ state: "open", title: "Test", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		expect(github.updateIssueTitle).not.toHaveBeenCalled();
		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			"Issue refined at the request of @admin. The issue body now contains the Proposed Task. No implementation session was started.",
		);
	});

	it("does not apply a title when proposedTitle is empty", async () => {
		github.getIssue.mockResolvedValue({ state: "open", title: "Test", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			proposedTitle: "   ",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		expect(github.updateIssueTitle).not.toHaveBeenCalled();
	});

	it("does not apply a title when proposedTitle equals the original title", async () => {
		github.getIssue.mockResolvedValue({ state: "open", title: "Test", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			proposedTitle: "Test",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		expect(github.updateIssueTitle).not.toHaveBeenCalled();
		expect(github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			"Issue refined at the request of @admin. The issue body now contains the Proposed Task. No implementation session was started.",
		);
	});

	it("marks stale when the issue title changes during refinement", async () => {
		github.getIssue
			.mockResolvedValueOnce({ state: "open", title: "Test", body: "Body" })
			.mockResolvedValueOnce({ state: "open", title: "Renamed by maintainer", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			proposedTitle: "Clearer Title",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		expect(github.updateIssueBody).not.toHaveBeenCalled();
		expect(github.updateIssueTitle).not.toHaveBeenCalled();
		const attempt = store.getLatestAttempt("mbrooks", "yolomatic", 1);
		expect(attempt!.state).toBe("stale");
		expect(attempt!.failureReason).toBe("issue title changed during refinement");
		expect(await sessions.get()).toMatchObject({ status: "failed", staleReason: "issue title changed during refinement" });
	});

	it("rejects an oversized proposed title", async () => {
		github.getIssue.mockResolvedValue({ state: "open", title: "Test", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			proposedTitle: "x".repeat(257),
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		expect(github.updateIssueBody).not.toHaveBeenCalled();
		expect(github.updateIssueTitle).not.toHaveBeenCalled();
		const attempt = store.getLatestAttempt("mbrooks", "yolomatic", 1);
		expect(attempt!.state).toBe("failed");
		expect(attempt!.failureReason).toBe("proposed title exceeds GitHub size limit");
	});

	it("persists proposedTitle on the attempt even when body is stale", async () => {
		github.getIssue
			.mockResolvedValueOnce({ state: "open", title: "Test", body: "Body" })
			.mockResolvedValueOnce({ state: "open", title: "Test", body: "Modified body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			proposedTitle: "Clearer Title",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(createCommandPayload() as never);

		const attempt = store.getLatestAttempt("mbrooks", "yolomatic", 1);
		expect(attempt!.proposedTitle).toBe("Clearer Title");
		expect(attempt!.state).toBe("stale");
	});

	it("reports failure when the worker throws", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockRejectedValue(new Error("worker crashed"));
		await handler.execute(createCommandPayload() as never);
		expect(github.updateIssueBody).not.toHaveBeenCalled();
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "Refinement failed: worker crashed");
		const attempt = store.getLatestAttempt("mbrooks", "yolomatic", 1);
		expect(attempt!.state).toBe("failed");
		expect(await sessions.get()).toMatchObject({ status: "failed", staleReason: "worker crashed" });
	});

	it("ignores non-created comment actions", async () => {
		await handler.execute(createCommandPayload({ action: "edited" }) as never);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
	});

	it("ignores comments from the bot account", async () => {
		await handler.execute(
			createCommandPayload({ comment: { id: 103, body: "/yolomatic issue-refinement", user: { login: "yolomatic-bot" } } }) as never,
		);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
	});

	it("ignores comments from bot-typed users", async () => {
		await handler.execute(
			createCommandPayload({
				comment: { id: 104, body: "/yolomatic issue-refinement", user: { login: "some-bot", type: "Bot" } },
			}) as never,
		);
		expect(executor.executeRefinement).not.toHaveBeenCalled();
	});

	it("ignores refinement commands on pull requests", async () => {
		await handler.execute(
			createCommandPayload({ issue: { pull_request: { url: "https://api.github.com/repos/mbrooks/yolomatic/pulls/1" } } }) as never,
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
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: false,
		});
		await handler.postInstructions(createInstructionPayload() as never);
		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("does not post instructions for issues assigned to the bot", async () => {
		await handler.postInstructions(
			createInstructionPayload({ issue: { assignees: [{ login: "yolomatic-bot" }] } }) as never,
		);
		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("does not post instructions for a polling source issue before the repo baseline", async () => {
		const eventStore = createEventStoreMock("2026-08-02T00:00:00.000Z");
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			eventStore: eventStore as never,
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: true,
		});
		const issue = { ...createInstructionPayload().issue, created_at: "2026-08-01T00:00:00.000Z" };
		await handler.postInstructions(createInstructionPayload({ source: "polling", issue }) as never);
		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("does not post instructions for a polling source issue when no baseline exists", async () => {
		const eventStore = createEventStoreMock(null);
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			eventStore: eventStore as never,
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: true,
		});
		const issue = { ...createInstructionPayload().issue, created_at: "2026-08-02T00:00:00.000Z" };
		await handler.postInstructions(createInstructionPayload({ source: "polling", issue }) as never);
		expect(github.postComment).not.toHaveBeenCalled();
	});

	it("posts instructions for a polling source issue created after the repo baseline", async () => {
		const eventStore = createEventStoreMock("2026-08-01T00:00:00.000Z");
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			eventStore: eventStore as never,
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: true,
		});
		const issue = { ...createInstructionPayload().issue, created_at: "2026-08-02T00:00:00.000Z" };
		await handler.postInstructions(createInstructionPayload({ source: "polling", issue }) as never);
		expect(github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, buildNewIssueComment("yolomatic-bot", undefined));
	});

	it("ignores the polling baseline for webhook source events", async () => {
		const eventStore = createEventStoreMock(null);
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			eventStore: eventStore as never,
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: true,
		});
		await handler.postInstructions(createInstructionPayload({ source: "webhook" }) as never);
		expect(github.postComment).toHaveBeenCalled();
	});

	it("identifies a polling issues.edited event as the applied refinement body", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});
		await handler.execute(createCommandPayload({ source: "polling" }) as never);

		const applied = handler.isAppliedBodyEdit({
			source: "polling",
			issue: { number: 1, body: "Refined body" },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
		});
		expect(applied).toBe(true);

		const mismatch = handler.isAppliedBodyEdit({
			source: "polling",
			issue: { number: 1, body: "Different body" },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
		});
		expect(mismatch).toBe(false);

		const webhook = handler.isAppliedBodyEdit({
			source: "webhook",
			issue: { number: 1, body: "Refined body" },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
		});
		expect(webhook).toBe(false);
	});

	it("runs refinement end-to-end from a polled comment", async () => {
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.execute(
			createCommandPayload({
				source: "polling",
				comment: { id: 110, body: "/yolomatic issue-refinement Focus on polling", user: { login: "admin" } },
			}) as never,
			"Focus on polling",
		);

		expect(executor.executeRefinement).toHaveBeenCalledWith(expect.anything(), undefined, "Focus on polling");
		expect(github.updateIssueBody).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "Refined body");
		const attempt = store.getLatestAttempt("mbrooks", "yolomatic", 1);
		expect(attempt).not.toBeNull();
		expect(attempt!.state).toBe("applied");
		expect(attempt!.steeringPrompt).toBe("Focus on polling");
	});

	it("restarts the latest failed refinement against the current issue", async () => {
		store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 1,
			requester: "original-requester",
			originalTitle: "Old title",
			originalBody: "Old body",
			originalBodyFingerprint: "old-fingerprint",
			instructionSource: "prompt-defaults",
			state: "failed",
			failureReason: "invalid JSON",
			steeringPrompt: "Keep it narrow",
		});
		github.getIssue.mockResolvedValue({ state: "open", title: "Current title", body: "Current body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
		});

		await handler.restart("mbrooks", "yolomatic", 1);

		expect(executor.executeRefinement).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Current title", body: "Current body", kind: "refinement" }),
			undefined,
			"Keep it narrow",
		);
		const attempts = store.listAttemptsByIssue("mbrooks", "yolomatic", 1);
		expect(attempts).toHaveLength(2);
		expect(attempts.find((attempt) => attempt.requester === "admin")).toEqual(
			expect.objectContaining({ state: "applied" }),
		);
	});

	function createGitHubMock() {
		return {
			postComment: vi.fn(async () => 1),
			updateIssueBody: vi.fn(async () => {}),
			updateIssueTitle: vi.fn(async () => {}),
			getIssue: vi.fn<GitHubService["getIssue"]>(async () => ({ state: "open", body: "Body" })),
			getCollaboratorPermissionLevel: vi.fn(async (): Promise<import("../../ports/github-service.js").CollaboratorPermission | null> => null),
			isCollaborator: vi.fn(async (): Promise<boolean> => false),
			listIssueComments: vi.fn(async (): Promise<import("../../ports/github-service.js").IssueComment[]> => []),
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

	function createEventStoreMock(baseline: string | null = null) {
		return {
			getLastEventReceivedAt: vi.fn(() => "2026-08-01T00:00:00.000Z"),
			initializeLastEventReceivedAt: vi.fn(),
			updateLastEventReceivedAt: vi.fn(),
			hasSeen: vi.fn(() => false),
			markSeen: vi.fn(),
			upsertPollingSubject: vi.fn(),
			listPollingSubjects: vi.fn(() => []),
			markPollingSubjectChecked: vi.fn(),
			getRepoPollBaseline: vi.fn(() => baseline),
			setRepoPollBaseline: vi.fn(),
		};
	}

	function createExecutorMock() {
		return {
			executeRefinement: vi.fn<RefinementExecutionService["executeRefinement"]>(async () => ({
				proposedTaskBody: "Body",
				summary: "Summary",
				investigation: "Investigation",
			})),
		};
	}

	it("records a refinement metric with runtime and token usage on success", async () => {
		const metrics = { record: vi.fn() };
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: true,
			metrics,
		});
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockResolvedValue({
			proposedTaskBody: "Refined body",
			summary: "Summary",
			investigation: "Investigation",
			usage: { available: true, input: 50, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 70, cost: 0.4 },
		});

		await handler.execute(createCommandPayload() as never);

		expect(metrics.record).toHaveBeenCalledOnce();
		const metric = metrics.record.mock.calls[0][0];
		expect(metric).toMatchObject({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 1,
			kind: "refinement",
			status: "complete",
		});
		expect(metric.sessionKey).toBe("github-mbrooks-yolomatic-issue-1-refinement");
		expect(typeof metric.durationMs).toBe("number");
		expect(metric.tokenUsage.available).toBe(true);
		expect(metric.tokenUsage.totalTokens).toBe(70);
	});

	it("records a failed refinement metric when the worker throws", async () => {
		const metrics = { record: vi.fn() };
		handler = new HandleIssueRefinement({
			refinementStore: store,
			sessions: sessions as never,
			github: github as never,
			tasks: tasks as never,
			workspaces: workspaces as never,
			executor: executor as unknown as RefinementExecutionService,
			clock: { now: () => new Date("2026-08-01T00:00:00Z"), uptime: () => 0 },
			adminGithubUsername: "admin",
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			isRepoManaged: () => true,
			refinementEnabled: true,
			metrics,
		});
		github.getIssue.mockResolvedValue({ state: "open", body: "Body" });
		executor.executeRefinement.mockRejectedValue(new Error("worker crashed"));

		await handler.execute(createCommandPayload() as never);

		expect(metrics.record).toHaveBeenCalledOnce();
		const metric = metrics.record.mock.calls[0][0];
		expect(metric.kind).toBe("refinement");
		expect(metric.status).toBe("failed");
		expect(metric.tokenUsage.available).toBe(false);
	});
});
