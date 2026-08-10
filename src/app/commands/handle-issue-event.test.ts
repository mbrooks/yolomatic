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
			assignee: { login: "yolomatic-bot" },
			assignees: [{ login: "yolomatic-bot" }],
			user: { login: "human" },
		},
		repository: { name: "yolomatic", owner: { login: "mbrooks" } },
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
			repo: "yolomatic",
			issueNumber: 1,
			status: "pending" as const,
			title: "Test issue",
			body: "Issue body",
			path: "/tmp/worktree",
			labels: [],
		})),
		updateStatus: vi.fn(async () => ({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 1,
			status: "working",
			seeded: true,
			title: "Test issue",
			body: "Issue body",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
			labels: [],
		})),
		markSeeded: vi.fn(async () => {}),
	};

	const workspaces = {
		createOrGetWorktree:
			overrides?.createOrGetWorktree ??
			vi.fn(async () => ({ path: "/tmp/worktree", branch: "yolomatic/issue-1" })),
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
		postComment: vi.fn(async () => 1),
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
		closeIssue: vi.fn(async () => {}),
		updateIssueBody: vi.fn(async () => {}),
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
		githubUsername: "yolomatic-bot",
		selfReportEnabled: false,
		executor: {
			llm: {} as any,
			toolProvider: {} as any,
			sessions: sessions as any,
			workspaces: workspaces as any,
			github: github as any,
			tasks: tasks as any,
			clock: { now: () => new Date() } as any,
			githubUsername: "yolomatic-bot",
			defaultBranch: "main",
			selfReportEnabled: false,
			executor: {
				execute: vi.fn(async () => ({
					status: "complete" as const,
					summary: "Done.",
					rawResponse: "YOLO_STATUS: complete\nDone.",
				})),
				executePRReview: vi.fn(async () => ({
					status: "complete" as const,
					summary: "Done.",
					rawResponse: "YOLO_STATUS: complete\nDone.",
				})),
			} as any,
		},
		adminBaseUrl: undefined as string | undefined,
		issueAdminLinkInCommentsEnabled: undefined as boolean | undefined,
		resolveAdminBaseUrl: undefined as (() => string | undefined) | undefined,
		resolveIssueAdminLinkInCommentsEnabled: undefined as (() => boolean | undefined) | undefined,
	};
}

describe("HandleIssueEvent", () => {
	it("ignores events sent by the bot itself", async () => {
		const deps = createDeps();
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload({ sender: { login: "yolomatic-bot" } });

		await handler.execute(payload);

		expect(deps.workspaces.createOrGetWorktree).not.toHaveBeenCalled();
	});

	it("reports in-flight status correctly", () => {
		const deps = createDeps();
		const inFlight = new Set(["mbrooks/yolomatic#1"]);
		const handler = new HandleIssueEvent({ ...(deps as any), inFlight });

		expect(handler.isInFlight("mbrooks", "yolomatic", 1)).toBe(true);
		expect(handler.isInFlight("mbrooks", "yolomatic", 2)).toBe(false);
	});

	it("reports refinement work as in flight", () => {
		const deps = createDeps();
		const refinement = { isInFlight: vi.fn(() => true), postInstructions: vi.fn() };
		const handler = new HandleIssueEvent({ ...(deps as any), refinement });

		expect(handler.isInFlight("mbrooks", "yolomatic", 1)).toBe(true);
		expect(refinement.isInFlight).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
	});

	it("posts refinement instructions for newly opened issues", async () => {
		const deps = createDeps();
		const refinement = { isInFlight: vi.fn(() => false), postInstructions: vi.fn(async () => undefined) };
		const handler = new HandleIssueEvent({ ...(deps as any), refinement });
		const payload = createPayload({
			issue: { ...createPayload().issue, assignee: null, assignees: [] },
		});

		await handler.execute(payload);

		expect(refinement.postInstructions).toHaveBeenCalledWith(payload);
		expect(deps.workspaces.createOrGetWorktree).not.toHaveBeenCalled();
	});

	it("ignores unassigned events when Yolomatic is still assigned", async () => {
		const deps = createDeps();
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload({ action: "unassigned" });

		await handler.execute(payload);

		expect(deps.workspaces.createOrGetWorktree).not.toHaveBeenCalled();
	});

	it("handles unassigned events by pausing work when Yolomatic is unassigned", async () => {
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

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "pending");
		expect(deps.github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "Yolomatic unassigned. Pausing work.");
	});

	it("pauses waiting-feedback sessions when Yolomatic is unassigned", async () => {
		const deps = createDeps();
		deps.sessions.get = vi.fn(async () => ({ status: "waiting-feedback" }) as any);
		const handler = new HandleIssueEvent(deps as any);

		await handler.execute(createPayload({
			action: "unassigned",
			issue: { ...createPayload().issue, assignee: null, assignees: [] },
		}));

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "pending");
	});

	it("steers active execution on edited events", async () => {
		const deps = createDeps();
		deps.sessions.get = vi.fn(async () => ({ status: "working" } as any));
		deps.tasks.isActive = vi.fn(() => true);
		deps.tasks.steer = vi.fn(async () => true);
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload({ action: "edited", issue: { ...createPayload().issue, labels: [{ name: "yolomatic" }] } });

		await handler.execute(payload);

		expect(deps.tasks.steer).toHaveBeenCalled();
		expect(deps.github.postComment).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "Issue description updated. Steering to Yolomatic.");
	});

	it("reports when an edited issue cannot be steered", async () => {
		const deps = createDeps();
		deps.sessions.get = vi.fn(async () => ({ status: "working" }) as any);
		deps.tasks.isActive = vi.fn(() => true);
		deps.tasks.steer = vi.fn(async () => false);
		const handler = new HandleIssueEvent(deps as any);

		await handler.execute(createPayload({ action: "edited", issue: { ...createPayload().issue, labels: [{ name: "yolomatic" }] } }));

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			"Issue description updated but could not be steered.",
		);
	});

	it("ignores edited events when not a Yolomatic issue and no session", async () => {
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
			issue: { ...createPayload().issue, labels: [{ name: "yolomatic" }] },
		});

		await handler.execute(payload);

		expect(deps.sessions.get).toHaveBeenCalled();
		expect(deps.github.postComment).not.toHaveBeenCalled();
	});

	it("ignores a polling issues.edited event that matches an applied refinement body", async () => {
		const deps = createDeps();
		const refinement = {
			isInFlight: vi.fn(() => false),
			postInstructions: vi.fn(),
			isAppliedBodyEdit: vi.fn(() => true),
		};
		const handler = new HandleIssueEvent({ ...(deps as any), refinement });
		const payload = createPayload({
			action: "edited",
			source: "polling",
			issue: { ...createPayload().issue, labels: [{ name: "yolomatic" }], body: "Refined body" },
		});

		await handler.execute(payload);

		expect(refinement.isAppliedBodyEdit).toHaveBeenCalledWith(payload);
		expect(deps.sessions.get).not.toHaveBeenCalled();
		expect(deps.tasks.steer).not.toHaveBeenCalled();
		expect(deps.sessions.updateStatus).not.toHaveBeenCalled();
		expect(deps.github.postComment).not.toHaveBeenCalled();
	});

	it("updates session body/title on edited events when not active", async () => {
		const deps = createDeps();
		deps.sessions.get = vi.fn(async () => ({ status: "working" } as any));
		deps.tasks.isActive = vi.fn(() => false);
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload({
			action: "edited",
			issue: { ...createPayload().issue, labels: [{ name: "yolomatic" }] },
		});

		await handler.execute(payload);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "working", {
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
		const inFlight = new Set(["mbrooks/yolomatic#1"]);
		const handler = new HandleIssueEvent({ ...(deps as any), inFlight });
		const payload = createPayload();

		await handler.execute(payload);

		expect(deps.workspaces.createOrGetWorktree).not.toHaveBeenCalled();
	});

	it("creates worktree and session for new issues", async () => {
		const deps = createDeps();
		(deps.sessions.get as any)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValue({
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 1,
				status: "pending",
				title: "Test issue",
				body: "Issue body",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
				labels: [],
			});
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload();

		await handler.execute(payload);

		expect(deps.workspaces.createOrGetWorktree).toHaveBeenCalledWith("mbrooks", "yolomatic", 1);
		expect(deps.sessions.createSession).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			"Test issue",
			"Issue body",
			"/tmp/worktree",
			"implementation",
			[],
		);
	});

	it("ignores when session status is not pending", async () => {
		const deps = createDeps();
		(deps.sessions.createSession as any) = vi.fn(async () => ({
			owner: "mbrooks",
			repo: "yolomatic",
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
			"yolomatic",
			1,
			"Deploy in progress. Task will resume after restart.",
		);
		expect(deps.sessions.updateStatus).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "pending", { resumeOnBoot: true }, "implementation");
	});

	it("auto-starts execution for accepted issues", async () => {
		const deps = createDeps();
		let getCallCount = 0;
		deps.sessions.get = vi.fn(async () => {
			getCallCount++;
			if (getCallCount <= 2) return null;
			return {
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 1,
				status: "working",
				seeded: true,
				title: "Test issue",
				body: "Issue body",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
				labels: [],
			};
		}) as any;
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload();

		await handler.execute(payload);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			1,
			"Picked up by Yolomatic. Working on it...",
		);
	});

	it("appends an admin session link to the pickup comment when enabled", async () => {
		const deps = createDeps();
		let getCallCount = 0;
		deps.sessions.get = vi.fn(async () => {
			getCallCount++;
			if (getCallCount <= 2) return null;
			return {
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 1,
				status: "working",
				seeded: true,
				title: "Test issue",
				body: "Issue body",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
				labels: [],
			};
		}) as any;
		deps.adminBaseUrl = "http://host:6767/yolomatic/admin";
		deps.issueAdminLinkInCommentsEnabled = true;
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload();

		await handler.execute(payload);

		const expectedUrl = "http://host:6767/yolomatic/admin#/repos/mbrooks/yolomatic/1/implementation";
		const pickupCall = (deps.github.postComment.mock.calls as unknown as Array<[string, string, number, string]>).find(
			(c) => c[3].startsWith("Picked up by Yolomatic. Working on it..."),
		)!;
		expect(pickupCall).toBeDefined();
		expect(pickupCall[3]).toContain(`Track status: ${expectedUrl}`);
		expect(pickupCall[3]).not.toContain("#/repos/mbrooks/yolomatic/issues/1");
	});

	it("omits the admin session link from the pickup comment when the toggle is disabled", async () => {
		const deps = createDeps();
		let getCallCount = 0;
		deps.sessions.get = vi.fn(async () => {
			getCallCount++;
			if (getCallCount <= 2) return null;
			return {
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 1,
				status: "working",
				seeded: true,
				title: "Test issue",
				body: "Issue body",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
				labels: [],
			};
		}) as any;
		deps.adminBaseUrl = "http://host:6767/yolomatic/admin";
		deps.issueAdminLinkInCommentsEnabled = false;
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload();

		await handler.execute(payload);

		const pickupCall = (deps.github.postComment.mock.calls as unknown as Array<[string, string, number, string]>).find(
			(c) => c[3].startsWith("Picked up by Yolomatic. Working on it..."),
		)!;
		expect(pickupCall[3]).toBe("Picked up by Yolomatic. Working on it...");
		expect(pickupCall[3]).not.toContain("Track status:");
	});

	it("initializes empty repo and retries when createOrGetWorktree throws EmptyRepositoryError", async () => {
		let callCount = 0;
		const createOrGetWorktree = vi.fn(async () => {
			callCount++;
			if (callCount === 1) {
				throw new EmptyRepositoryError("/tmp/workspaces/mbrooks-yolomatic");
			}
			return { path: "/tmp/worktree", branch: "yolomatic/issue-1" };
		});
		const initializeEmptyRepo = vi.fn(async () => {});
		const deps = createDeps({ createOrGetWorktree, initializeEmptyRepo });
		(deps.sessions.get as any)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValue({
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 1,
				status: "pending",
				title: "Test issue",
				body: "Issue body",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
				labels: [],
			});
		const handler = new HandleIssueEvent(deps as any);
		const payload = createPayload();

		await handler.execute(payload);

		expect(initializeEmptyRepo).toHaveBeenCalledWith("mbrooks", "yolomatic", "main");
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
