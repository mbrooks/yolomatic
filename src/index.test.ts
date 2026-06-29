import { describe, expect, it, vi, beforeEach } from "vitest";

// dotenv/config side effect must be suppressed before index.ts is loaded
vi.mock("dotenv/config", () => ({}));

vi.mock("./config.js", () => ({
	getConfig: vi.fn(() => ({
		port: 6767,
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
		piAgentModel: undefined,
		piAgentProvider: undefined,
		logLevel: "info",
		logPrompts: true,
		logThoughts: true,
		logTools: true,
		logResponses: true,
		githubEventMode: "webhook",
		githubPollIntervalMs: 60000,
	})),
	isBootstrapComplete: vi.fn(() => true),
}));

vi.mock("./settings/store.js", () => ({
	SettingsStore: vi.fn(() => ({
		get: vi.fn(() => undefined),
		seedFromEnv: vi.fn(),
		applyDefaults: vi.fn(),
		onChange: vi.fn(() => () => {}),
	})),
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


vi.mock("./github-events/polling.js", () => ({
	startGitHubPolling: vi.fn(),
}));

vi.mock("./webhook/handlers.js", () => ({
	GitHubIssueHandlers: vi.fn(() => ({
		handleGitHubEvent: vi.fn(),
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
		close: vi.fn((cb?: (error?: Error) => void) => cb?.()),
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
import { PiAgentExecutor } from "./executor/index.js";
import { main, noOpHandlers } from "./index.js";
import { GitHubIssueHandlers } from "./webhook/handlers.js";
import { SessionStore } from "./session/store.js";
import { SettingsStore } from "./settings/store.js";
import { isBootstrapComplete, getConfig } from "./config.js";
import { StaleSessionDetector } from "./session/stale-detector.js";
import { startGitHubPolling } from "./github-events/polling.js";
import { cleanupOldSessions } from "./webhook/server.js";

describe("main", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isBootstrapComplete).mockReturnValue(true);
		(GitHubIssueHandlers as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
			handleGitHubEvent: vi.fn(),
			isInFlight: vi.fn(() => false),
			resumeInterruptedSession: vi.fn(),
		}));
	});

	it("enters onboarding mode when bootstrap incomplete", async () => {
		vi.mocked(isBootstrapComplete).mockReturnValueOnce(false);
		await main();
		expect(createWebhookServer).toHaveBeenCalled();
		const server = (createWebhookServer as ReturnType<typeof vi.fn>).mock.results[0]?.value;
		expect(server.listen).toHaveBeenCalledWith(6767, expect.any(Function));
	});

	it("uses a dummy onboarding secret when bootstrap is incomplete and no secret is configured", async () => {
		vi.mocked(getConfig).mockReturnValueOnce({
			port: 6767,
			webhookSecret: "",
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
			piAgentModel: undefined,
			piAgentProvider: undefined,
			logLevel: "info",
			logPrompts: true,
			logThoughts: true,
			logTools: true,
			logResponses: true,
			githubEventMode: "webhook",
			githubPollIntervalMs: 60000,
		});
		vi.mocked(isBootstrapComplete).mockReturnValueOnce(false);

		await main();

		expect(createWebhookServer).toHaveBeenCalledWith(
			"dummy-onboarding-secret",
			noOpHandlers,
			expect.any(Object),
			undefined,
			undefined,
			expect.any(Object),
			undefined,
			undefined,
			undefined,
			expect.any(Object),
			undefined,
			expect.any(Object),
		);
	});

	it("starts the full runtime once onboarding completes and only activates once", async () => {
		vi.mocked(isBootstrapComplete).mockReturnValueOnce(false).mockReturnValue(true);

		await main();
		const onboardingOptions = vi.mocked(createWebhookServer).mock.calls[0]?.[9] as {
			onOnboardingComplete: () => Promise<void>;
		};
		const onboardingServer = vi.mocked(createWebhookServer).mock.results[0]?.value;

		await onboardingOptions.onOnboardingComplete();
		expect(onboardingServer.close).toHaveBeenCalledTimes(1);
		expect(createWebhookServer).toHaveBeenCalledTimes(2);

		await onboardingOptions.onOnboardingComplete();
		expect(createWebhookServer).toHaveBeenCalledTimes(2);
	});

	it("keeps onboarding mode active when bootstrap is still incomplete after a settings refresh", async () => {
		vi.mocked(isBootstrapComplete).mockReturnValue(false);

		await main();
		const onboardingOptions = vi.mocked(createWebhookServer).mock.calls[0]?.[9] as {
			onOnboardingComplete: () => Promise<void>;
		};

		await onboardingOptions.onOnboardingComplete();
		expect(createWebhookServer).toHaveBeenCalledTimes(1);
	});

	it("surfaces onboarding server close errors when activation begins", async () => {
		const closeError = new Error("close failed");
		vi.mocked(isBootstrapComplete).mockReturnValueOnce(false).mockReturnValue(true);
		vi.mocked(createWebhookServer).mockImplementationOnce(() => ({
			listen: vi.fn((port, cb) => {
				if (typeof cb === "function") cb();
			}),
			close: vi.fn((cb?: (error?: Error) => void) => cb?.(closeError)),
		}) as never);

		await main();
		const onboardingOptions = vi.mocked(createWebhookServer).mock.calls[0]?.[9] as {
			onOnboardingComplete: () => Promise<void>;
		};

		await expect(onboardingOptions.onOnboardingComplete()).rejects.toThrow("close failed");
		expect(createWebhookServer).toHaveBeenCalledTimes(1);
	});

	it("creates webhook server and listens on configured port", async () => {
		await main();
		expect(createWebhookServer).toHaveBeenCalledWith(
			"secret",
			expect.objectContaining({
				handleGitHubEvent: expect.any(Function),
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
			undefined,
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.objectContaining({
				execute: expect.any(Function),
			}),
		);
		const server = (createWebhookServer as ReturnType<typeof vi.fn>).mock.results[0]?.value;
		expect(server.listen).toHaveBeenCalledWith(6767, expect.any(Function));
	});

	it("starts GitHub polling when event mode is polling", async () => {
		const { getConfig } = await import("./config.js");
		vi.mocked(getConfig).mockReturnValueOnce({
			port: 6767,
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
			piAgentModel: undefined,
			piAgentProvider: undefined,
			logLevel: "info",
			logPrompts: true,
			logThoughts: true,
			logTools: true,
			logResponses: true,
			githubEventMode: "polling",
			githubPollIntervalMs: 30000,
		});

		await main();

		expect(startGitHubPolling).toHaveBeenCalledWith(expect.objectContaining({
			intervalMs: 30000,
			githubUsername: "tars-bot",
			dispatch: expect.any(Function),
		}));
		const pollingDeps = vi.mocked(startGitHubPolling).mock.calls[0][0] as { dispatch: (event: unknown) => Promise<void> };
		await pollingDeps.dispatch({ id: "e1" });
		const mockFn = GitHubIssueHandlers as unknown as ReturnType<typeof vi.fn>;
		const handlersInstance = mockFn.mock.results[mockFn.mock.results.length - 1]?.value;
		expect(handlersInstance.handleGitHubEvent).toHaveBeenCalledWith({ id: "e1" });
		expect(createWebhookServer).toHaveBeenCalledWith(
			"secret",
			noOpHandlers,
			expect.any(Object),
			expect.anything(),
			expect.anything(),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(String),
			undefined,
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.objectContaining({
				execute: expect.any(Function),
			}),
		);
	});

	it("starts polling when a configured repository overrides webhook mode to polling", async () => {
		(SettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
			get: vi.fn((key: string) => {
				if (key === "configured_repositories") {
					return JSON.stringify([{ owner: "mbrooks", repo: "tars", settings: { github_event_mode: "polling" } }]);
				}
				return undefined;
			}),
			seedFromEnv: vi.fn(),
			applyDefaults: vi.fn(),
			onChange: vi.fn(() => () => {}),
		}));

		await main();

		expect(startGitHubPolling).toHaveBeenCalledWith(expect.objectContaining({
			shouldPollRepo: expect.any(Function),
		}));
		const pollingDeps = vi.mocked(startGitHubPolling).mock.calls.at(-1)?.[0] as { shouldPollRepo: (owner: string, repo: string) => boolean };
		expect(pollingDeps.shouldPollRepo("mbrooks", "tars")).toBe(true);
		expect(pollingDeps.shouldPollRepo("mbrooks", "case")).toBe(false);
	});

	it("keeps webhook handlers active and starts polling when event mode is both", async () => {
		const { getConfig } = await import("./config.js");
		vi.mocked(getConfig).mockReturnValueOnce({
			port: 6767,
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
			piAgentModel: undefined,
			piAgentProvider: undefined,
			logLevel: "info",
			logPrompts: true,
			logThoughts: true,
			logTools: true,
			logResponses: true,
			githubEventMode: "both",
			githubPollIntervalMs: 45000,
		});

		await main();

		expect(startGitHubPolling).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: 45000 }));
		expect(createWebhookServer).toHaveBeenCalledWith(
			"secret",
			expect.objectContaining({ handleGitHubEvent: expect.any(Function) }),
			expect.any(Object),
			expect.anything(),
			expect.anything(),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(String),
			undefined,
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.objectContaining({
				execute: expect.any(Function),
			}),
		);
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

	it("logs string resume errors from interrupted sessions", async () => {
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
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const mockFn = GitHubIssueHandlers as unknown as ReturnType<typeof vi.fn>;
		mockFn.mockImplementation(() => ({
			resumeInterruptedSession: vi.fn(async () => { throw "resume string"; }),
			isInFlight: vi.fn(() => false),
		}));

		await main();

		expect(stdout).toHaveBeenCalledWith("[startup] failed to resume mbrooks/tars#1: resume string\n");
	});

	it("runs cleanup when retention is configured", async () => {
		const originalSetInterval = global.setInterval;
		const unref = vi.fn();
		const setIntervalMock = vi.fn((callback: () => void) => {
			callback();
			return { unref } as never;
		});
		global.setInterval = setIntervalMock as unknown as typeof setInterval;
		const { getConfig } = await import("./config.js");
		vi.mocked(getConfig).mockReturnValueOnce({
			port: 6767,
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
			githubEventMode: "webhook",
			githubPollIntervalMs: 60000,
		});
		try {
			await main();
			expect(createWebhookServer).toHaveBeenCalled();
			expect(cleanupOldSessions).toHaveBeenCalledTimes(2);
			expect(unref).toHaveBeenCalledTimes(1);
		} finally {
			global.setInterval = originalSetInterval;
		}
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

	it("logs string resume outer errors", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		(SessionStore as any).mockImplementation(() => ({
			get: vi.fn(),
			set: vi.fn(),
			getAll: vi.fn(async () => { throw "resume outer string"; }),
		}));

		await main();

		expect(stdout).toHaveBeenCalledWith("[startup] resume error: resume outer string\n");
	});

	it("passes a live model config getter into the executor", async () => {
		vi.mocked(getConfig)
			.mockReturnValueOnce({
				port: 6767,
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
				piAgentModel: "initial-model",
				piAgentProvider: "ollama",
				logLevel: "info",
				logPrompts: true,
				logThoughts: true,
				logTools: true,
				logResponses: true,
				githubEventMode: "webhook",
				githubPollIntervalMs: 60000,
			})
			.mockReturnValue({
				port: 6767,
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
				piAgentModel: "updated-model",
				piAgentProvider: "github-copilot",
				logLevel: "info",
				logPrompts: true,
				logThoughts: true,
				logTools: true,
				logResponses: true,
				githubEventMode: "webhook",
				githubPollIntervalMs: 60000,
			});

		await main();
		const executorOptions = vi.mocked(PiAgentExecutor).mock.calls[0]?.[0] as {
			modelConfig: () => { model?: string; provider?: string };
		};

		expect(executorOptions.modelConfig()).toEqual({
			model: "updated-model",
			provider: "github-copilot",
		});
	});

	it("re-reads config when settings change", async () => {
		await main();
		const settingsStoreMock = (SettingsStore as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
		expect(settingsStoreMock.onChange).toHaveBeenCalledWith(expect.any(Function));
		const listener = settingsStoreMock.onChange.mock.calls[0][0];
		listener();
		expect(getConfig).toHaveBeenCalledTimes(2);
	});

	it("logs settings refresh failures from the change listener", async () => {
		await main();
		const settingsStoreMock = (SettingsStore as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
		const listener = settingsStoreMock.onChange.mock.calls[0][0];
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.mocked(getConfig).mockImplementationOnce(() => {
			throw "boom";
		});

		listener();

		expect(stdout).toHaveBeenCalledWith("[settings] failed to sync env after change: boom\n");
	});
});

describe("noOpHandlers", () => {
	it("handleGitHubEvent does nothing", async () => {
		await expect(noOpHandlers.handleGitHubEvent?.({} as never)).resolves.toBeUndefined();
	});

	it("isInFlight returns false", () => {
		expect(noOpHandlers.isInFlight("mbrooks", "tars", 1)).toBe(false);
	});
});
