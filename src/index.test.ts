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
		githubUsername: "yolomatic-bot",
		workspacesDir: "/tmp/workspaces",
		soulPath: "/tmp/SOUL.md",
		selfReportEnabled: true,
		onboardingComplete: true,
		adminGithubUsername: "admin",
		cleanupRetentionDays: undefined,
		staleThresholdMs: 14400000,
		maxWorktrees: 10,
		evictionStrategy: "lru",
		githubEventMode: "webhook",
		githubPollIntervalMs: 60000,
		workerImage: "yolomatic-worker:latest",
		workerWorkspaceMountSource: "/tmp/workspaces",
		workerControlBaseUrl: "http://host.docker.internal:6767",
		workerDockerNetworkMode: undefined,
		workerOllamaHost: undefined,
		adminPath: "/yolomatic/admin",
		adminDefaultPage: "#/dashboard",
		issueNewCommentEnabled: true,
		issueAdminLinkInCommentsEnabled: true,
		adminBaseUrl: undefined,
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

const repositoryStoreMock = vi.hoisted(() => ({
	list: vi.fn(async () => [] as unknown[]),
	listSync: vi.fn(() => [] as unknown[]),
	get: vi.fn(async (_owner?: string, _repo?: string) => null as unknown),
	getSync: vi.fn((_owner?: string, _repo?: string) => null as unknown),
	upsert: vi.fn(async () => ({} as unknown)),
	upsertSync: vi.fn(() => ({} as unknown)),
	remove: vi.fn(async () => false),
	removeSync: vi.fn(() => false),
	listForPolling: vi.fn(async () => [] as unknown[]),
	close: vi.fn(),
}));

vi.mock("./repos/repository-store.js", () => ({
	RepositoryStore: vi.fn(() => repositoryStoreMock),
}));

const userStoreMock = vi.hoisted(() => ({
	hasAnySync: vi.fn(() => true),
	createSync: vi.fn(),
	firstSync: vi.fn(() => null),
	listSync: vi.fn(() => []),
	getByUsernameSync: vi.fn(() => null),
	getByIdSync: vi.fn(() => null),
}));

vi.mock("./users/store.js", () => ({
	UserStore: vi.fn(() => userStoreMock),
}));


vi.mock("./session/store.js", () => ({
	SessionStore: vi.fn(() => ({
		get: vi.fn(),
		set: vi.fn(),
		getAll: vi.fn(async () => []),
		exists: vi.fn(async () => false),
		delete: vi.fn(async () => {}),
		archive: vi.fn(async () => {}),
		migrateFromFileStoreIfNeeded: vi.fn(async () => 0),
		getSessionPath: vi.fn(() => "/tmp/session.jsonl"),
		getStatePath: vi.fn(() => "/tmp/state.json"),
		getArchivePath: vi.fn(() => "/tmp/archive.json"),
		getSessionArchivePath: vi.fn(() => "/tmp/archive.jsonl"),
		getSessionKey: vi.fn((owner, repo, n) => `github-${owner}-${repo}-issue-${n}`),
	})),
}));

vi.mock("./logging/session-log-store.js", () => ({
	SessionLogStore: vi.fn(() => ({})),
	configureSessionLogPersistence: vi.fn(),
	loadPersistedSessionLogs: vi.fn(),
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

vi.mock("./executor/docker-worker.js", () => ({
	DockerWorkerExecutor: vi.fn(() => ({
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
		close: vi.fn((cb) => {
			if (typeof cb === "function") cb();
			return undefined;
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
import { SettingsStore } from "./settings/store.js";
import { isBootstrapComplete, getConfig } from "./config.js";
import { StaleSessionDetector } from "./session/stale-detector.js";
import { startGitHubPolling } from "./github-events/polling.js";

describe("main", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isBootstrapComplete).mockReturnValue(true);
		repositoryStoreMock.listSync.mockReturnValue([]);
		repositoryStoreMock.getSync.mockReturnValue(null);
		repositoryStoreMock.list.mockResolvedValue([]);
		repositoryStoreMock.listForPolling.mockResolvedValue([]);
		repositoryStoreMock.get.mockResolvedValue(null);
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
			expect.any(Object),
			expect.objectContaining({
				createOrGetWorktree: expect.any(Function),
				commitAndPush: expect.any(Function),
				removeWorktree: expect.any(Function),
			}),
			expect.any(Object),
			expect.any(String),
			expect.objectContaining({ prebuiltStartIssueSession: expect.any(Object) }),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
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
			githubUsername: "yolomatic-bot",
			workspacesDir: "/tmp/workspaces",
			soulPath: "/tmp/SOUL.md",
			selfReportEnabled: true,
			onboardingComplete: true,
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
			workerImage: "yolomatic-worker:latest",
			workerWorkspaceMountSource: "/tmp/workspaces",
			workerControlBaseUrl: "http://host.docker.internal:6767",
			workerDockerNetworkMode: undefined,
			workerOllamaHost: undefined,
		adminPath: "/yolomatic/admin",
		adminDefaultPage: "#/dashboard",
		issueNewCommentEnabled: true,
		issueAdminLinkInCommentsEnabled: true,
		adminBaseUrl: undefined,
		});

		await main();

		expect(startGitHubPolling).toHaveBeenCalledWith(expect.objectContaining({
			intervalMs: 30000,
			githubUsername: "yolomatic-bot",
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
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(String),
			expect.objectContaining({ prebuiltStartIssueSession: expect.any(Object) }),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
		);
	});

	it("starts polling when a configured repository overrides webhook mode to polling", async () => {
		const managedRepo = {
			id: "mbrooks/yolomatic",
			owner: "mbrooks",
			repo: "yolomatic",
			fullName: null,
			visibility: null,
			githubEventMode: "polling" as const,
			defaultBranch: null,
			createdAt: "",
			updatedAt: "",
		};
		repositoryStoreMock.listSync.mockReturnValue([managedRepo]);
		repositoryStoreMock.getSync.mockImplementation((owner, repo) =>
			owner === "mbrooks" && repo === "yolomatic" ? managedRepo : null,
		);

		await main();

		expect(startGitHubPolling).toHaveBeenCalledWith(expect.objectContaining({
			shouldPollRepo: expect.any(Function),
		}));
		const pollingDeps = vi.mocked(startGitHubPolling).mock.calls.at(-1)?.[0] as { shouldPollRepo: (owner: string, repo: string) => boolean };
		expect(pollingDeps.shouldPollRepo("mbrooks", "yolomatic")).toBe(true);
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
			githubUsername: "yolomatic-bot",
			workspacesDir: "/tmp/workspaces",
			soulPath: "/tmp/SOUL.md",
			selfReportEnabled: true,
			onboardingComplete: true,
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
			workerImage: "yolomatic-worker:latest",
			workerWorkspaceMountSource: "/tmp/workspaces",
			workerControlBaseUrl: "http://host.docker.internal:6767",
			workerDockerNetworkMode: undefined,
			workerOllamaHost: undefined,
		adminPath: "/yolomatic/admin",
		adminDefaultPage: "#/dashboard",
		issueNewCommentEnabled: true,
		issueAdminLinkInCommentsEnabled: true,
		adminBaseUrl: undefined,
		});

		await main();

		expect(startGitHubPolling).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: 45000 }));
		expect(createWebhookServer).toHaveBeenCalledWith(
			"secret",
			expect.objectContaining({ handleGitHubEvent: expect.any(Function) }),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(String),
			expect.objectContaining({ prebuiltStartIssueSession: expect.any(Object) }),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
		);
	});

	it("resumes interrupted working sessions on startup", async () => {
		const mockGetAll = vi.fn(async () => [
			{
				owner: "mbrooks",
				repo: "yolomatic",
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
			migrateFromFileStoreIfNeeded: vi.fn(async () => 0),
		}));
		await main();
		const mockFn = GitHubIssueHandlers as unknown as ReturnType<typeof vi.fn>;
		const handlersInstance = mockFn.mock.results[mockFn.mock.results.length - 1]?.value;
		expect(handlersInstance.resumeInterruptedSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 42);
	});

	it("resumes checkpointed sessions with resumeOnBoot on startup", async () => {
		const mockGetAll = vi.fn(async () => [
			{
				owner: "mbrooks",
				repo: "yolomatic",
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
			migrateFromFileStoreIfNeeded: vi.fn(async () => 0),
		}));
		await main();
		const mockFn = GitHubIssueHandlers as unknown as ReturnType<typeof vi.fn>;
		const handlersInstance = mockFn.mock.results[mockFn.mock.results.length - 1]?.value;
		expect(handlersInstance.resumeInterruptedSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 43);
	});

	it("runs stale session detection on startup", async () => {
		vi.mocked(StaleSessionDetector).mockImplementation(() => ({
			detectStaleSessions: vi.fn(async () => [
				{
					isStale: true,
					ageMs: 99999999,
					session: {
						owner: "mbrooks",
						repo: "yolomatic",
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
		expect(mockMarkFailed).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, "interrupted_or_abandoned");
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
				repo: "yolomatic",
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
			migrateFromFileStoreIfNeeded: vi.fn(async () => 0),
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
			webhookSecret: "secret",
			sessionsDir: "/tmp/sessions",
			archiveDir: "/tmp/sessions/archive",
			memoryDir: "/tmp/memory",
			defaultBranch: "main",
			githubToken: "token",
			githubUsername: "yolomatic-bot",
			workspacesDir: "/tmp/workspaces",
			soulPath: "/tmp/SOUL.md",
			selfReportEnabled: true,
			onboardingComplete: true,
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
			workerImage: "yolomatic-worker:latest",
			workerWorkspaceMountSource: "/tmp/workspaces",
			workerControlBaseUrl: "http://host.docker.internal:6767",
			workerDockerNetworkMode: undefined,
			workerOllamaHost: undefined,
		adminPath: "/yolomatic/admin",
		adminDefaultPage: "#/dashboard",
		issueNewCommentEnabled: true,
		issueAdminLinkInCommentsEnabled: true,
		adminBaseUrl: undefined,
		});
		await main();
		expect(createWebhookServer).toHaveBeenCalled();
	});

	it("handles resume outer catch error", async () => {
		(SessionStore as any).mockImplementation(() => ({
			get: vi.fn(),
			set: vi.fn(),
			getAll: vi.fn(async () => { throw new Error("resume outer"); }),
			migrateFromFileStoreIfNeeded: vi.fn(async () => 0),
		}));
		await main();
		expect(createWebhookServer).toHaveBeenCalled();
	});

	it("re-syncs config to env when settings change", async () => {
		await main();
		const settingsStoreMock = (SettingsStore as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
		expect(settingsStoreMock.onChange).toHaveBeenCalledWith(expect.any(Function));
		const listener = settingsStoreMock.onChange.mock.calls[0][0];
		listener();
		expect(getConfig).toHaveBeenCalledTimes(2);
	});

	it("logs when settings change listener fails to sync env", async () => {
		await main();
		const settingsStoreMock = (SettingsStore as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
		const listener = settingsStoreMock.onChange.mock.calls[0][0];
		vi.mocked(getConfig).mockImplementationOnce(() => {
			throw new Error("sync fail");
		});
		expect(() => listener()).not.toThrow();
	});

	it("handles non-Error throws in the settings change listener", async () => {
		await main();
		const settingsStoreMock = (SettingsStore as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
		const listener = settingsStoreMock.onChange.mock.calls[0][0];
		vi.mocked(getConfig).mockImplementationOnce(() => {
			throw "string error";
		});
		expect(() => listener()).not.toThrow();
	});

	it("starts full runtime when onboarding completes", async () => {
		vi.mocked(isBootstrapComplete).mockReturnValueOnce(false);
		await main();

		const onboardingCall = (createWebhookServer as ReturnType<typeof vi.fn>).mock.calls[0];
		const options = onboardingCall?.[7] as { onOnboardingComplete: () => Promise<void> };
		expect(options.onOnboardingComplete).toBeTypeOf("function");

		// Completing onboarding re-reads config and must see a complete config now.
		vi.mocked(isBootstrapComplete).mockReturnValueOnce(true);
		await options.onOnboardingComplete();

		// A second createWebhookServer call comes from startRuntime after onboarding.
		expect(createWebhookServer).toHaveBeenCalledTimes(2);
		const runtimeServer = (createWebhookServer as ReturnType<typeof vi.fn>).mock.results[1]?.value;
		expect(runtimeServer.listen).toHaveBeenCalledWith(6767, expect.any(Function));
	});

	it("does not start runtime when onboarding complete fires before config is complete", async () => {
		vi.mocked(isBootstrapComplete).mockReturnValueOnce(false);
		await main();
		const options = (createWebhookServer as ReturnType<typeof vi.fn>).mock.calls[0]?.[7] as {
			onOnboardingComplete: () => Promise<void>;
		};
		const callsBefore = (createWebhookServer as ReturnType<typeof vi.fn>).mock.calls.length;
		vi.mocked(isBootstrapComplete).mockReturnValueOnce(false);
		await options.onOnboardingComplete();
		expect((createWebhookServer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
	});

	it("does not start runtime twice if onboarding complete fires again", async () => {
		vi.mocked(isBootstrapComplete).mockReturnValueOnce(false);
		await main();
		const options = (createWebhookServer as ReturnType<typeof vi.fn>).mock.calls[0]?.[7] as {
			onOnboardingComplete: () => Promise<void>;
		};
		vi.mocked(isBootstrapComplete).mockReturnValueOnce(true);
		await options.onOnboardingComplete();
		const callsAfterFirst = (createWebhookServer as ReturnType<typeof vi.fn>).mock.calls.length;
		// Second fire should be a no-op (activated guard).
		vi.mocked(isBootstrapComplete).mockReturnValueOnce(true);
		await options.onOnboardingComplete();
		expect((createWebhookServer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
	});
});

describe("noOpHandlers", () => {
	it("handleGitHubEvent does nothing", async () => {
		await expect(noOpHandlers.handleGitHubEvent?.({} as never)).resolves.toBeUndefined();
	});

	it("isInFlight returns false", () => {
		expect(noOpHandlers.isInFlight("mbrooks", "yolomatic", 1)).toBe(false);
	});
});
