import { describe, expect, it, vi } from "vitest";

import { HandleIssueEvent, type IssueEventPayload } from "./handle-issue-event.js";
import { EmptyRepositoryError } from "../../workspace/errors.js";

function createPayload(overrides?: Partial<IssueEventPayload>): IssueEventPayload {
	return {
		action: "opened",
		issue: {
			number: 1,
			title: "Test issue",
			body: "Issue body",
			labels: [],
			assignee: { login: "yeetomatic-bot" },
			assignees: [{ login: "yeetomatic-bot" }],
			user: { login: "human" },
		},
		repository: { name: "tars", owner: { login: "mbrooks" } },
		sender: { login: "human" },
		...overrides,
	};
}

function createDeps(overrides?: {
	createOrGetWorktree?: ReturnType<typeof vi.fn>;
	initializeEmptyRepo?: ReturnType<typeof vi.fn>;
	createSession?: ReturnType<typeof vi.fn>;
}) {
	const sessions = {
		get: vi.fn(async () => null),
		createSession: vi.fn(async () => ({
			owner: "mbrooks",
			repo: "tars",
			issueNumber: 1,
			status: "pending" as const,
			title: "Test issue",
			body: "Issue body",
			path: "/tmp/worktree",
			labels: [],
		})),
		updateStatus: vi.fn(async () => ({
			owner: "mbrooks",
			repo: "tars",
			issueNumber: 1,
			status: "working",
			seeded: true,
			title: "Test issue",
			body: "Issue body",
			workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
			labels: [],
		})),
		markSeeded: vi.fn(async () => {}),
	};

	const workspaces = {
		createOrGetWorktree:
			overrides?.createOrGetWorktree ??
			vi.fn(async () => ({ path: "/tmp/worktree", branch: "yeetomatic/issue-1" })),
		removeWorktree: vi.fn(async () => {}),
		commitAndPush: vi.fn(async () => true),
		hasChanges: vi.fn(async () => false),
		getWorktreePath: vi.fn(() => "/tmp/worktree"),
		getGitStatus: vi.fn(async () => ""),
		getGitDiff: vi.fn(async () => ""),
	};

	const tasks = {
		isActive: vi.fn(() => false),
		steer: vi.fn(async () => false),
		isDraining: vi.fn(() => false),
		register: vi.fn(() => {}),
		unregister: vi.fn(() => {}),
		cancel: vi.fn(() => false),
	};

	const github = {
		postComment: vi.fn(async () => {}),
		addLabels: vi.fn(async () => {}),
		removeLabel: vi.fn(async () => {}),
		getPullRequest: vi.fn(async () => null),
		createPullRequest: vi.fn(async () => null),
		listPullRequests: vi.fn(async () => []),
		getIssue: vi.fn(async () => null),
		createIssue: vi.fn(async () => ({ number: 1, html_url: "" })),
		initializeEmptyRepo: overrides?.initializeEmptyRepo ?? vi.fn(async () => {}),
		fileSelfReport: vi.fn(async () => ""),
		listReviewComments: vi.fn(async () => []),
		listLabels: vi.fn(async () => []),
		getIssueTemplates: vi.fn(async () => []),
		listRecentCommits: vi.fn(async () => []),
		listRelatedIssues: vi.fn(async () => []),
		listOpenIssues: vi.fn(async () => []),
		listPendingInvitations: vi.fn(async () => []),
		acceptInvitation: vi.fn(async () => {}),
		updateIssueAssignees: vi.fn(async () => {}),
		getAuthenticatedUser: vi.fn(async () => ({ login: "testuser" })),
		listAccessibleRepositories: vi.fn(async () => []),
	};

	return {
		sessions,
		workspaces,
		tasks,
		github,
		clock: { now: () => new Date() },
		defaultBranch: "main",
		githubUsername: "yeetomatic-bot",
		selfReportEnabled: false,
		executor: {
			llm: {} as any,
			toolProvider: {} as any,
			sessions: sessions as any,
			workspaces: workspaces as any,
			github: github as any,
			tasks: tasks as any,
			clock: { now: () => new Date() } as any,
			githubUsername: "yeetomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: false,
			executor: {
				execute: vi.fn(async () => ({
					status: "complete" as const,
					summary: "Done.",
					rawResponse: "YEETOMATIC_STATUS: complete\nDone.",
				})),
				executePRReview: vi.fn(async () => ({
					status: "complete" as const,
					summary: "Done.",
					rawResponse: "YEETOMATIC_STATUS: complete\nDone.",
				})),
			} as any,
		},
	};
}

describe("HandleIssueEvent", () => {
	it("ignores events sent by the bot itself", async () => {
		const deps = createDeps();
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload({ sender: { login: "yeetomatic-bot" } });

		await handler.execute(payload);

		expect(deps.workspaces.createOrGetWorktree).not.toHaveBeenCalled();
	});

	it("reports in-flight status correctly", () => {
		const deps = createDeps();
		const inFlight = new Set(["mbrooks/tars#1"]);
		const handler = new HandleIssueEvent({ ...(deps as any), inFlight });

		expect(handler.isInFlight("mbrooks", "tars", 1)).toBe(true);
		expect(handler.isInFlight("mbrooks", "tars", 2)).toBe(false);
	});

	it("ignores unassigned events when Yeetomatic is still assigned", async () => {
		const deps = createDeps();
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload({ action: "unassigned" });

		await handler.execute(payload);

		expect(deps.workspaces.createOrGetWorktree).not.toHaveBeenCalled();
	});

	it("handles unassigned events by pausing work when Yeetomatic is unassigned", async () => {
		const deps = createDeps();
		deps.sessions.get = vi.fn(async () => ({ status: "working" } as any));
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload({
			action: "unassigned",
			issue: {
				number: 1,
				title: "Test",
				body: "body",
				labels: [],
				assignee: null,
				assignees: [],
				user: { login: "human" },
			},
		});

		await handler.execute(payload);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "pending");
		expect(deps.github.postComment).toHaveBeenCalledWith("mbrooks", "tars", 1, "Yeetomatic unassigned. Pausing work.");
	});

	it("steers active execution on edited events", async () => {
		const deps = createDeps();
		deps.sessions.get = vi.fn(async () => ({ status: "working" } as any));
		deps.tasks.isActive = vi.fn(() => true);
		deps.tasks.steer = vi.fn(async () => true);
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload({ action: "edited", issue: { ...createPayload().issue, labels: [{ name: "yeetomatic" }] } });

		await handler.execute(payload);

		expect(deps.tasks.steer).toHaveBeenCalled();
		expect(deps.github.postComment).toHaveBeenCalledWith("mbrooks", "tars", 1, "Issue description updated. Steering to Yeetomatic.");
	});

	it("ignores edited events when not a Yeetomatic issue and no session", async () => {
		const deps = createDeps();
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload({
			action: "edited",
			issue: {
				...createPayload().issue,
				labels: [],
				assignee: null,
				assignees: [],
				user: { login: "human" },
			},
		});

		await handler.execute(payload);

		expect(deps.sessions.get).not.toHaveBeenCalled();
	});

	it("ignores edited events when no session exists", async () => {
		const deps = createDeps();
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload({
			action: "edited",
			issue: { ...createPayload().issue, labels: [{ name: "yeetomatic" }] },
		});

		await handler.execute(payload);

		expect(deps.sessions.get).toHaveBeenCalled();
		expect(deps.github.postComment).not.toHaveBeenCalled();
	});

	it("updates session body/title on edited events when not active", async () => {
		const deps = createDeps();
		deps.sessions.get = vi.fn(async () => ({ status: "working" } as any));
		deps.tasks.isActive = vi.fn(() => false);
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload({
			action: "edited",
			issue: { ...createPayload().issue, labels: [{ name: "yeetomatic" }] },
		});

		await handler.execute(payload);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "working", {
			body: "Issue body",
			title: "Test issue",
		});
	});

	it("ignores unsupported actions", async () => {
		const deps = createDeps();
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload({ action: "labeled" });

		await handler.execute(payload);

		expect(deps.workspaces.createOrGetWorktree).not.toHaveBeenCalled();
	});

	it("ignores events that should be ignored per policy", async () => {
		const deps = createDeps();
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload({ issue: { ...createPayload().issue, assignee: null, assignees: [] } });

		await handler.execute(payload);

		expect(deps.workspaces.createOrGetWorktree).not.toHaveBeenCalled();
	});

	it("ignores in-flight issues", async () => {
		const deps = createDeps();
		const inFlight = new Set(["mbrooks/tars#1"]);
		const handler = new HandleIssueEvent({ ...(deps as any), inFlight });
		const payload = createPayload();

		await handler.execute(payload);

		expect(deps.workspaces.createOrGetWorktree).not.toHaveBeenCalled();
	});

	it("creates worktree and session for new issues", async () => {
		const deps = createDeps();
		(deps.sessions.get as any)
			.mockResolvedValueOnce(null)
			.mockResolvedValue({
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 1,
				status: "pending",
				title: "Test issue",
				body: "Issue body",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				labels: [],
			});
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload();

		await handler.execute(payload);

		expect(deps.workspaces.createOrGetWorktree).toHaveBeenCalledWith("mbrooks", "tars", 1);
		expect(deps.sessions.createSession).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			"Test issue",
			"Issue body",
			"/tmp/worktree",
			[],
		);
	});

	it("ignores when session status is not pending", async () => {
		const deps = createDeps();
		(deps.sessions.createSession as any) = vi.fn(async () => ({
			owner: "mbrooks",
			repo: "tars",
			issueNumber: 1,
			status: "working" as const,
			title: "Test issue",
			body: "Issue body",
			path: "/tmp/worktree",
			labels: [],
		}));
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload();

		await handler.execute(payload);

		expect(deps.sessions.createSession).toHaveBeenCalled();
		expect(deps.github.postComment).not.toHaveBeenCalled();
	});

	it("posts draining message when in draining mode", async () => {
		const deps = createDeps();
		deps.tasks.isDraining = vi.fn(() => true);
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload();

		await handler.execute(payload);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			"Deploy in progress. Task will resume after restart.",
		);
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "tars", 1, "pending", { resumeOnBoot: true });
	});

	it("auto-starts execution for accepted issues", async () => {
		const deps = createDeps();
		let getCallCount = 0;
		deps.sessions.get = vi.fn(async () => {
			getCallCount++;
			if (getCallCount === 1) return null;
			return {
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 1,
				status: "working",
				seeded: true,
				title: "Test issue",
				body: "Issue body",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				labels: [],
			};
		});
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload();

		await handler.execute(payload);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			1,
			"Picked up by Yeetomatic. Working on it...",
		);
	});

	it("initializes empty repo and retries when createOrGetWorktree throws EmptyRepositoryError", async () => {
		let callCount = 0;
		const createOrGetWorktree = vi.fn(async () => {
			callCount++;
			if (callCount === 1) {
				throw new EmptyRepositoryError("/tmp/workspaces/mbrooks-tars");
			}
			return { path: "/tmp/worktree", branch: "yeetomatic/issue-1" };
		});
		const initializeEmptyRepo = vi.fn(async () => {});
		const deps = createDeps({ createOrGetWorktree, initializeEmptyRepo });
		(deps.sessions.get as any)
			.mockResolvedValueOnce(null)
			.mockResolvedValue({
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 1,
				status: "pending",
				title: "Test issue",
				body: "Issue body",
				workspacePath: "/tmp/workspaces/mbrooks-tars/.worktrees/issue-1",
				labels: [],
			});
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload();

		await handler.execute(payload);

		expect(initializeEmptyRepo).toHaveBeenCalledWith("mbrooks", "tars", "main");
		expect(createOrGetWorktree).toHaveBeenCalledTimes(3);
		expect(deps.sessions.createSession).toHaveBeenCalled();
	});

	it("rethrows non-empty-repo errors from createOrGetWorktree", async () => {
		const createOrGetWorktree = vi.fn(async () => {
			throw new Error("some other error");
		});
		const deps = createDeps({ createOrGetWorktree });
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload();

		await expect(handler.execute(payload)).rejects.toThrow("some other error");
		expect(deps.github.initializeEmptyRepo).not.toHaveBeenCalled();
	});
});
