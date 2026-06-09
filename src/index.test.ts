import { describe, expect, it, vi, beforeEach } from "vitest";

// dotenv/config side effect must be suppressed before index.ts is loaded
vi.mock("dotenv/config", () => ({}));

vi.mock("./config.js", () => ({
	getConfig: vi.fn(() => ({
		port: 6767,
		autoStart: true,
		webhookSecret: "secret",
		sessionsDir: "/tmp/sessions",
		archiveDir: "/tmp/sessions/archive",
		memoryDir: "/tmp/memory",
		defaultBranch: "main",
		githubToken: "token",
		githubUsername: "tars-bot",
		workspacesDir: "/tmp/workspaces",
		soulPath: "/tmp/SOUL.md",
		selfReportEnabled: true,
		adminUsername: "admin",
		adminPassword: "secret",
		adminGithubUsername: "admin",
		cleanupRetentionDays: undefined,
		staleThresholdMs: 14400000,
		maxWorktrees: 10,
		evictionStrategy: "lru",
	})),
	isBootstrapComplete: vi.fn(() => true),
}));

vi.mock("./settings/store.js", () => ({
	SettingsStore: vi.fn(() => ({
		seedFromEnv: vi.fn(),
		applyDefaults: vi.fn(),
	})),
}));

vi.mock("./cron/store.js", () => ({
	CronStore: vi.fn(() => ({})),
}));

vi.mock("./session/store.js", () => ({
	SessionStore: vi.fn(() => ({
		get: vi.fn(),
		set: vi.fn(),
		getAll: vi.fn(async () => []),
	})),
}));

vi.mock("./session/manager.js", () => ({
	SessionManager: vi.fn(() => ({
		getSessionKey: vi.fn(),
		getSessionPath: vi.fn(),
		createSession: vi.fn(),
		getSession: vi.fn(),
		resumeSession: vi.fn(),
		updateStatus: vi.fn(),
		markSeeded: vi.fn(),
		markFailed: vi.fn(),
	})),
}));

vi.mock("./workspace/manager.js", () => ({
	WorkspaceManager: vi.fn(() => ({
		createOrGetWorktree: vi.fn(),
		commitAndPush: vi.fn(async () => true),
		commitAndPushPath: vi.fn(async () => true),
		removeWorktree: vi.fn(),
	})),
}));

vi.mock("./executor/index.js", () => ({
	PiAgentExecutor: vi.fn(() => ({
		execute: vi.fn(),
	})),
}));

vi.mock("./cron/scheduler.js", () => ({
	startCronScheduler: vi.fn(),
}));

vi.mock("./webhook/handlers.js", () => ({
	GitHubIssueHandlers: vi.fn(() => ({
		handleIssueEvent: vi.fn(),
		handleCommentEvent: vi.fn(),
		handlePullRequestReviewCommentEvent: vi.fn(),
		handlePullRequestReviewEvent: vi.fn(),
		isInFlight: vi.fn(() => false),
		resumeInterruptedSession: vi.fn(),
	})),
}));

vi.mock("./webhook/server.js", () => ({
	createWebhookServer: vi.fn(() => ({
		listen: vi.fn((port, cb) => {
			if (typeof cb === "function") cb();
			return { close: vi.fn() };
		}),
	})),
	cleanupOldSessions: vi.fn(),
}));

vi.mock("./session/stale-detector.js", () => ({
	StaleSessionDetector: vi.fn(() => ({
		detectStaleSessions: vi.fn(async () => []),
	})),
}));

vi.mock("./skills/store.js", () => ({
	SkillStore: vi.fn(() => ({})),
}));

vi.mock("./skills/repo-skill-service.js", () => ({
	RepoSkillService: vi.fn(() => ({})),
}));

import { createWebhookServer } from "./webhook/server.js";
import { main, noOpHandlers } from "./index.js";
import { GitHubIssueHandlers } from "./webhook/handlers.js";
import { SessionStore } from "./session/store.js";
import { isBootstrapComplete } from "./config.js";
import { StaleSessionDetector } from "./session/stale-detector.js";

describe("main", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isBootstrapComplete).mockReturnValue(true);
	});

	it("enters onboarding mode when bootstrap incomplete", async () => {
		vi.mocked(isBootstrapComplete).mockReturnValueOnce(false);
		await main();
		expect(createWebhookServer).toHaveBeenCalled();
		const server = (createWebhookServer as ReturnType<typeof vi.fn>).mock.results[0]?.value;
		expect(server.listen).toHaveBeenCalledWith(6767, expect.any(Function));
	});

	it("creates webhook server and listens on configured port", async () => {
		await main();
		expect(createWebhookServer).toHaveBeenCalledWith(
			"secret",
			expect.objectContaining({
				handleIssueEvent: expect.any(Function),
				handleCommentEvent: expect.any(Function),
				handlePullRequestReviewCommentEvent: expect.any(Function),
				handlePullRequestReviewEvent: expect.any(Function),
			}),
			expect.objectContaining({
				get: expect.any(Function),
				set: expect.any(Function),
				getAll: expect.any(Function),
			}),
			"admin",
			"secret",
			expect.any(Object),
			expect.objectContaining({
				createOrGetWorktree: expect.any(Function),
				commitAndPush: expect.any(Function),
				removeWorktree: expect.any(Function),
			}),
			expect.any(Object),
			expect.any(String),
			expect.anything(),
			undefined,
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
		);
		const server = (createWebhookServer as ReturnType<typeof vi.fn>).mock.results[0]?.value;
		expect(server.listen).toHaveBeenCalledWith(6767, expect.any(Function));
	});

	it("resumes interrupted working sessions on startup", async () => {
		const mockGetAll = vi.fn(async () => [
			{
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 42,
				status: "working",
				workspacePath: "/tmp/ws",
				title: "Title",
				body: "Body",
				lastActivity: new Date().toISOString(),
				seeded: false,
			},
		]);
		(SessionStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
			get: vi.fn(),
			set: vi.fn(),
			getAll: mockGetAll,
		}));
		await main();
		const mockFn = GitHubIssueHandlers as unknown as ReturnType<typeof vi.fn>;
		const handlersInstance = mockFn.mock.results[mockFn.mock.results.length - 1]?.value;
		expect(handlersInstance.resumeInterruptedSession).toHaveBeenCalledWith("mbrooks", "tars", 42);
	});

	it("resumes checkpointed sessions with resumeOnBoot on startup", async () => {
		const mockGetAll = vi.fn(async () => [
			{
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 43,
				status: "pending",
				workspacePath: "/tmp/ws",
				title: "Title",
				body: "Body",
				lastActivity: new Date().toISOString(),
				seeded: false,
				resumeOnBoot: true,
			},
		]);
		(SessionStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
			get: vi.fn(),
			set: vi.fn(),
			getAll: mockGetAll,
		}));
		await main();
		const mockFn = GitHubIssueHandlers as unknown as ReturnType<typeof vi.fn>;
		const handlersInstance = mockFn.mock.results[mockFn.mock.results.length - 1]?.value;
		expect(handlersInstance.resumeInterruptedSession).toHaveBeenCalledWith("mbrooks", "tars", 43);
	});

	it("runs stale session detection on startup", async () => {
		vi.mocked(StaleSessionDetector).mockImplementation(() => ({
			detectStaleSessions: vi.fn(async () => [
				{
					isStale: true,
					ageMs: 99999999,
					session: {
						owner: "mbrooks",
						repo: "tars",
						issueNumber: 99,
						status: "working",
						staleDetectedAt: null,
						lastActivity: new Date().toISOString(),
						workspacePath: "/tmp/ws",
						createdAt: new Date().toISOString(),
					},
				},
			]),
		} as never));
		const { SessionManager } = await import("./session/manager.js");
		const mockMarkFailed = vi.fn();
		vi.mocked(SessionManager).mockImplementation(() => ({
			markFailed: mockMarkFailed,
		} as never));
		await main();
		expect(mockMarkFailed).toHaveBeenCalledWith("mbrooks", "tars", 99, "interrupted_or_abandoned");
	});

	it("handles stale detection errors gracefully", async () => {
		vi.mocked(StaleSessionDetector).mockImplementation(() => ({
			detectStaleSessions: vi.fn(async () => { throw new Error("stale error"); }),
		} as never));
		await main();
		expect(createWebhookServer).toHaveBeenCalled();
	});

	it("handles resume errors gracefully", async () => {
		const mockGetAll = vi.fn(async () => [
			{
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 1,
				status: "working",
				workspacePath: "/tmp/ws",
				title: "Title",
				body: "Body",
				lastActivity: new Date().toISOString(),
				seeded: false,
			},
		]);
		(SessionStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
			get: vi.fn(),
			set: vi.fn(),
			getAll: mockGetAll,
		}));
		const mockFn = GitHubIssueHandlers as unknown as ReturnType<typeof vi.fn>;
		mockFn.mockImplementation(() => ({
			resumeInterruptedSession: vi.fn(async () => { throw new Error("resume error"); }),
			isInFlight: vi.fn(() => false),
		}));
		await main();
		expect(createWebhookServer).toHaveBeenCalled();
	});

	it("runs cleanup when retention is configured", async () => {
		const { getConfig } = await import("./config.js");
		vi.mocked(getConfig).mockReturnValueOnce({
			port: 6767,
			autoStart: true,
			webhookSecret: "secret",
			sessionsDir: "/tmp/sessions",
			archiveDir: "/tmp/sessions/archive",
			memoryDir: "/tmp/memory",
			defaultBranch: "main",
			githubToken: "token",
			githubUsername: "tars-bot",
			workspacesDir: "/tmp/workspaces",
			soulPath: "/tmp/SOUL.md",
			selfReportEnabled: true,
			adminUsername: "admin",
			adminPassword: "secret",
			adminGithubUsername: "admin",
			cleanupRetentionDays: 7,
			staleThresholdMs: 14400000,
			maxWorktrees: 10,
			evictionStrategy: "lru",
			piAgentModel: undefined,
			piAgentProvider: undefined,
			logLevel: "info",
			logPrompts: true,
			logThoughts: true,
			logTools: true,
			logResponses: true,
		});
		await main();
		expect(createWebhookServer).toHaveBeenCalled();
	});

	it("handles resume outer catch error", async () => {
		(SessionStore as any).mockImplementation(() => ({
			get: vi.fn(),
			set: vi.fn(),
			getAll: vi.fn(async () => { throw new Error("resume outer"); }),
		}));
		await main();
		expect(createWebhookServer).toHaveBeenCalled();
	});
});

describe("noOpHandlers", () => {
	it("handleIssueEvent does nothing", async () => {
		await expect(noOpHandlers.handleIssueEvent({})).resolves.toBeUndefined();
	});

	it("handleCommentEvent does nothing", async () => {
		await expect(noOpHandlers.handleCommentEvent({})).resolves.toBeUndefined();
	});

	it("handlePullRequestReviewCommentEvent does nothing", async () => {
		await expect(noOpHandlers.handlePullRequestReviewCommentEvent({})).resolves.toBeUndefined();
	});

	it("handlePullRequestReviewEvent does nothing", async () => {
		await expect(noOpHandlers.handlePullRequestReviewEvent({})).resolves.toBeUndefined();
	});

	it("isInFlight returns false", () => {
		expect(noOpHandlers.isInFlight("mbrooks", "tars", 1)).toBe(false);
	});
});
