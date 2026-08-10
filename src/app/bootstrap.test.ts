import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
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
		adminUsername: "admin",
		adminPassword: "secret",
		adminGithubUsername: "admin",
		cleanupRetentionDays: undefined,
		staleThresholdMs: 14400000,
		maxWorktrees: 10,
		evictionStrategy: "lru",
		piAgentModel: "kimi",
		piAgentProvider: "ollama",
		logLevel: "debug",
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
		openaiApiKey: "sk-test",
	})),
	isBootstrapComplete: vi.fn(() => true),
}));

const sessionStoreMock = vi.hoisted(() => ({
	get: vi.fn(async () => null),
	getAll: vi.fn(async () => []),
	set: vi.fn(),
}));

vi.mock("../session/store.js", () => ({
	SessionStore: vi.fn(() => sessionStoreMock),
}));

vi.mock("../session/manager.js", () => ({
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

vi.mock("../workspace/manager.js", () => ({
	WorkspaceManager: vi.fn(() => ({
		createOrGetWorktree: vi.fn(),
		commitAndPush: vi.fn(async () => true),
		commitAndPushPath: vi.fn(async () => true),
		removeWorktree: vi.fn(),
	})),
}));

vi.mock("../executor/docker-worker.js", () => ({
	DockerWorkerExecutor: vi.fn(() => ({ execute: vi.fn() })),
}));

vi.mock("../worker/rpc-server.js", () => ({
	WorkerRpcServer: vi.fn(() => ({ attach: vi.fn(), close: vi.fn(async () => undefined) })),
}));

vi.mock("../github-events/polling.js", () => ({
	startGitHubPolling: vi.fn(),
}));

vi.mock("../webhook/handlers.js", () => ({
	GitHubIssueHandlers: vi.fn(() => ({
		handleGitHubEvent: vi.fn(),
		isInFlight: vi.fn(() => false),
		resumeInterruptedSession: vi.fn(),
	})),
}));

const serverMockFns = vi.hoisted(() => ({
	createWebhookServer: vi.fn(() => ({
		listen: vi.fn((_port: number, cb?: () => void) => {
			if (typeof cb === "function") cb();
			return undefined;
		}),
		close: vi.fn(),
	})),
	cleanupOldSessions: vi.fn(async () => ({ deleted: 0, failed: 0 })),
}));

vi.mock("../webhook/server.js", () => serverMockFns);

vi.mock("../session/stale-detector.js", () => ({
	StaleSessionDetector: vi.fn(() => ({
		detectStaleSessions: vi.fn(async () => []),
	})),
}));

vi.mock("../skills/store.js", () => ({
	SkillStore: vi.fn(() => ({})),
}));

vi.mock("../skills/repo-skill-service.js", () => ({
	RepoSkillService: vi.fn(() => ({})),
}));

import { buildRuntimeGraph, noOpHandlers, startRuntime, syncConfigToEnv } from "./bootstrap.js";
import { GitHubIssueHandlers } from "../webhook/handlers.js";
import { getConfig } from "../config.js";
import { startGitHubPolling } from "../github-events/polling.js";
import { StaleSessionDetector } from "../session/stale-detector.js";
import type { AppConfig } from "../config.js";
import type { RuntimeDeps } from "./bootstrap.js";

const createWebhookServerMock = serverMockFns.createWebhookServer;
const cleanupOldSessionsMock = serverMockFns.cleanupOldSessions;

const baseConfig: AppConfig = getConfig({} as never);

function makeDeps(): RuntimeDeps {
	return {
		settingsStore: {
			get: vi.fn(() => undefined),
			getAll: vi.fn(async () => []),
		} as never,
		sessionStore: sessionStoreMock as never,
		taskController: {
			cancel: vi.fn(() => false),
			isActive: vi.fn(() => false),
			steer: vi.fn(async () => false),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		} as never,
		repositoryStore: {
			list: vi.fn(async () => []),
			listSync: vi.fn(() => []),
			get: vi.fn(async () => null),
			getSync: vi.fn(() => null),
			upsert: vi.fn(async () => ({})),
			upsertSync: vi.fn(() => ({})),
			remove: vi.fn(async () => false),
			removeSync: vi.fn(() => false),
			listForPolling: vi.fn(async () => []),
			close: vi.fn(),
		} as never,
	};
}

describe("noOpHandlers", () => {
	it("handleGitHubEvent resolves to undefined", async () => {
		await expect(noOpHandlers.handleGitHubEvent?.({} as never)).resolves.toBeUndefined();
	});

	it("isInFlight returns false", () => {
		expect(noOpHandlers.isInFlight("mbrooks", "yolomatic", 1)).toBe(false);
	});
});

describe("syncConfigToEnv", () => {
	afterEach(() => {
		process.env.PI_AGENT_MODEL = "";
		process.env.PI_AGENT_PROVIDER = "";
		process.env.OPENAI_API_KEY = "";
		process.env.LOG_LEVEL = "";
		process.env.LOG_PROMPTS = "";
		process.env.LOG_THOUGHTS = "";
		process.env.LOG_TOOLS = "";
		process.env.LOG_RESPONSES = "";
	});

	it("writes configured values into process.env", () => {
		syncConfigToEnv(baseConfig);
		expect(process.env.PI_AGENT_MODEL).toBe("kimi");
		expect(process.env.PI_AGENT_PROVIDER).toBe("ollama");
		expect(process.env.OPENAI_API_KEY).toBe("sk-test");
		expect(process.env.LOG_LEVEL).toBe("debug");
		expect(process.env.LOG_PROMPTS).toBe("true");
		expect(process.env.LOG_TOOLS).toBe("true");
	});

	it("clears env vars when flags are disabled", () => {
		syncConfigToEnv({ ...baseConfig, logPrompts: false, logThoughts: false, logTools: false, logResponses: false });
		expect(process.env.LOG_PROMPTS).toBe("");
		expect(process.env.LOG_TOOLS).toBe("");
	});
});

describe("buildRuntimeGraph", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("constructs a runtime graph with webhook handlers enabled in webhook mode", () => {
		const graph = buildRuntimeGraph(baseConfig, makeDeps());
		expect(graph.server).toBeDefined();
		expect(graph.handlers).toBeDefined();
		expect(graph.sessionManager).toBeDefined();
		expect(graph.workspaceManager).toBeDefined();
		expect(graph.staleDetector).toBeDefined();
		expect(graph.executor).toBeDefined();
		expect(graph.startIssueSession).toBeDefined();
		expect(graph.githubEventsEnabled).toBe(true);
		expect(graph.pollingEnabled).toBe(false);
		expect(createWebhookServerMock).toHaveBeenCalledTimes(1);
		expect(graph.server.listen).not.toHaveBeenCalled();
	});

	it("passes session start and restart dispatchers through webhook server options", async () => {
		const graph = buildRuntimeGraph(baseConfig, makeDeps());
		const callArgs = (createWebhookServerMock as ReturnType<typeof vi.fn>).mock.calls[0];
		const options = callArgs?.[7] as {
			prebuiltStartIssueSession: typeof graph.startIssueSession;
			repositoryStore: unknown;
			restartSession: (owner: string, repo: string, issueNumber: number) => Promise<void>;
		};
		expect(options).toEqual(
			expect.objectContaining({
				prebuiltStartIssueSession: graph.startIssueSession,
				repositoryStore: expect.anything(),
				restartSession: expect.any(Function),
			}),
		);

		await options.restartSession("mbrooks", "yolomatic", 513);
		expect(graph.handlers.resumeInterruptedSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 513);
	});

	it("resolve helpers passed to handlers resolve default branch and event mode", () => {
		const deps = makeDeps();
		const managedRepo = {
			owner: "mbrooks",
			repo: "yolomatic",
			githubEventMode: "polling" as const,
			defaultBranch: "develop",
		};
		(deps.repositoryStore.listSync as ReturnType<typeof vi.fn>).mockReturnValue([managedRepo]);
		(deps.repositoryStore.getSync as ReturnType<typeof vi.fn>).mockImplementation(
			(owner: string, repo: string) => (owner === "mbrooks" && repo === "yolomatic" ? managedRepo : null),
		);
		buildRuntimeGraph(baseConfig, deps);
		const handlerDeps = (GitHubIssueHandlers as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
			resolveDefaultBranch: (owner: string, repo: string) => string;
			resolveGitHubEventMode: (owner: string, repo: string) => string;
		};
		expect(handlerDeps.resolveDefaultBranch("mbrooks", "yolomatic")).toBe("develop");
		expect(handlerDeps.resolveDefaultBranch("other", "repo")).toBe("main");
		expect(handlerDeps.resolveGitHubEventMode("mbrooks", "yolomatic")).toBe("polling");
		expect(handlerDeps.resolveGitHubEventMode("other", "repo")).toBe("webhook");
	});

	it("passes admin-link resolvers that read live from the SettingsStore", () => {
		const deps = makeDeps();
		const settingsValues: Record<string, string> = {
			admin_base_url: "http://host:6767/old/admin",
			issue_admin_link_in_comments_enabled: "true",
		};
		(deps.settingsStore as { get: (k: string) => string | undefined }).get = vi.fn((k: string) => settingsValues[k]);
		(deps.settingsStore as { getBoolean: (k: string, d?: boolean) => boolean }).getBoolean = vi.fn(
			(k: string, d?: boolean) => (settingsValues[k] === undefined ? (d ?? false) : settingsValues[k] === "true"),
		);
		buildRuntimeGraph(baseConfig, deps);
		const handlerDeps = (GitHubIssueHandlers as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
			resolveAdminBaseUrl: () => string | undefined;
			resolveIssueAdminLinkInCommentsEnabled: () => boolean | undefined;
		};
		expect(handlerDeps.resolveAdminBaseUrl()).toBe("http://host:6767/old/admin");
		expect(handlerDeps.resolveIssueAdminLinkInCommentsEnabled()).toBe(true);

		// Operator changes the settings in the admin UI without a restart.
		settingsValues.admin_base_url = "http://host:6767/new/admin";
		settingsValues.issue_admin_link_in_comments_enabled = "false";
		expect(handlerDeps.resolveAdminBaseUrl()).toBe("http://host:6767/new/admin");
		expect(handlerDeps.resolveIssueAdminLinkInCommentsEnabled()).toBe(false);

		// Empty/whitespace base URL resolves to undefined (link omitted).
		settingsValues.admin_base_url = "   ";
		expect(handlerDeps.resolveAdminBaseUrl()).toBeUndefined();
	});
});

describe("startRuntime", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("listens on the configured port and returns the runtime graph", async () => {
		const deps = makeDeps();
		const graph = await startRuntime(baseConfig, deps);
		expect(graph.server.listen).toHaveBeenCalledWith(6767, expect.any(Function));
		expect(startGitHubPolling).not.toHaveBeenCalled();
	});

	it("starts GitHub polling when polling is enabled", async () => {
		const pollingConfig = { ...baseConfig, githubEventMode: "polling" as const, githubPollIntervalMs: 30000 };
		await startRuntime(pollingConfig, makeDeps());
		expect(startGitHubPolling).toHaveBeenCalledWith(
			expect.objectContaining({ intervalMs: 30000, githubUsername: "yolomatic-bot" }),
		);
	});

	it("exposes resolveGitHubEventMode and shouldPollRepo to the polling loop", async () => {
		const deps = makeDeps();
		const managedRepo = {
			owner: "mbrooks",
			repo: "yolomatic",
			githubEventMode: "polling" as const,
			defaultBranch: null,
		};
		(deps.repositoryStore.listSync as ReturnType<typeof vi.fn>).mockReturnValue([managedRepo]);
		(deps.repositoryStore.getSync as ReturnType<typeof vi.fn>).mockImplementation(
			(owner: string, repo: string) => (owner === "mbrooks" && repo === "yolomatic" ? managedRepo : null),
		);
		const pollingConfig = { ...baseConfig, githubEventMode: "webhook" as const };
		await startRuntime(pollingConfig, deps);
		const pollingDeps = vi.mocked(startGitHubPolling).mock.calls.at(-1)?.[0] as {
			resolveGitHubEventMode: (owner: string, repo: string) => string;
			shouldPollRepo: (owner: string, repo: string) => boolean;
		};
		expect(pollingDeps.resolveGitHubEventMode("mbrooks", "yolomatic")).toBe("polling");
		expect(pollingDeps.resolveGitHubEventMode("other", "repo")).toBe("webhook");
		expect(pollingDeps.shouldPollRepo("mbrooks", "yolomatic")).toBe(true);
		expect(pollingDeps.shouldPollRepo("other", "repo")).toBe(false);
	});

	it("uses noOpHandlers for the webhook server in pure polling mode", async () => {
		const pollingConfig = { ...baseConfig, githubEventMode: "polling" as const };
		await startRuntime(pollingConfig, makeDeps());
		const serverCallHandlers = (createWebhookServerMock as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
		expect(serverCallHandlers).toBe(noOpHandlers);
	});

	it("runs stale detection and marks very old sessions as failed", async () => {
		vi.mocked(StaleSessionDetector).mockImplementationOnce(
			() =>
				({
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
				}) as never,
		);
		const { SessionManager } = await import("../session/manager.js");
		const mockMarkFailed = vi.fn();
		vi.mocked(SessionManager).mockImplementationOnce(
			() =>
				({
					markFailed: mockMarkFailed,
				}) as never,
		);
		await startRuntime(baseConfig, makeDeps());
		expect(mockMarkFailed).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, "interrupted_or_abandoned");
	});

	it("swallows stale detection errors", async () => {
		vi.mocked(StaleSessionDetector).mockImplementationOnce(
			() =>
				({
					detectStaleSessions: vi.fn(async () => {
						throw new Error("stale error");
					}),
				}) as never,
		);
		await expect(startRuntime(baseConfig, makeDeps())).resolves.toBeDefined();
	});

	it("resumes interrupted working sessions on startup", async () => {
		sessionStoreMock.getAll.mockImplementationOnce(async () => [
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
		] as never);
		await startRuntime(baseConfig, makeDeps());
		const handlersInstance = (GitHubIssueHandlers as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
		expect(handlersInstance.resumeInterruptedSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 42);
	});

	it("marks interrupted refinement sessions failed without resuming them", async () => {
		sessionStoreMock.getAll.mockImplementationOnce(async () => [
			{
				kind: "refinement",
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 517,
				status: "working",
				workspacePath: "/tmp/refinement",
				title: "Title",
				body: "Body",
				lastActivity: new Date().toISOString(),
				seeded: false,
			},
		] as never);

		await startRuntime(baseConfig, makeDeps());

		const { SessionManager } = await import("../session/manager.js");
		const sessionManager = vi.mocked(SessionManager).mock.results.at(-1)?.value;
		expect(sessionManager.updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			517,
			"failed",
			expect.objectContaining({ summary: "interrupted by restart", resumeOnBoot: undefined }),
			"refinement",
		);
		const handlersInstance = (GitHubIssueHandlers as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
		expect(handlersInstance.resumeInterruptedSession).not.toHaveBeenCalled();
	});

	it("swallows resume errors per session and outer resume errors", async () => {
		sessionStoreMock.getAll.mockImplementationOnce(async () => {
			throw new Error("resume outer");
		});
		await expect(startRuntime(baseConfig, makeDeps())).resolves.toBeDefined();
	});

	it("runs cleanup on startup and arms the interval when retention is configured", async () => {
		const cleanupConfig = { ...baseConfig, cleanupRetentionDays: 7 };
		await startRuntime(cleanupConfig, makeDeps());
		expect(cleanupOldSessionsMock).toHaveBeenCalledTimes(1);
	});
});
