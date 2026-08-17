import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	buildRuntimeGraph,
	computeEventModeFlags,
	createRuntimeSettingsProvider,
	defaultRuntimeFactory,
	noOpHandlers,
	resolveManagedGitHubEventMode,
	startRuntime,
	type RuntimeBuildContext,
	type RuntimeCollaborators,
	type RuntimeDeps,
	type RuntimeServices,
} from "./bootstrap.js";
import { DEFAULT_WORKER_TEMPLATE } from "../worker/templates.js";
import type { AppConfig } from "../config.js";
import type { RepoGitHubEventMode, Repository } from "../repos/repository.js";
import type { SessionState } from "../session/store.js";

// A fixed AppConfig literal. The old test mocked the config module to return a
// canned object; the literal avoids that module mock entirely.
const baseConfig: AppConfig = {
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
	piAgentModel: "kimi",
	piAgentProvider: "ollama",
	logLevel: "debug",
	logPrompts: true,
	logThoughts: true,
	logTools: true,
	logResponses: true,
	githubEventMode: "webhook",
	githubPollIntervalMs: 60000,
	workerWorkspaceMountSource: "/tmp/workspaces",
	workerControlBaseUrl: "http://host.docker.internal:6767",
	openaiApiKey: "sk-test",
	adminPath: "/yolomatic/admin",
	adminDefaultPage: "#/dashboard",
	issueNewCommentEnabled: true,
	issueAdminLinkInCommentsEnabled: true,
	adminBaseUrl: undefined,
};

function makeManagedRepo(overrides: Partial<Repository> = {}): Repository {
	return {
		id: "mbrooks/yolomatic",
		owner: "mbrooks",
		repo: "yolomatic",
		fullName: null,
		visibility: null,
		githubEventMode: null,
		defaultBranch: null,
		createdAt: "",
		updatedAt: "",
		...overrides,
	};
}

function makeDeps(overrides: Partial<RuntimeDeps> = {}): RuntimeDeps {
	return {
		settingsStore: {
			get: vi.fn(() => undefined),
			getBoolean: vi.fn((_k: string, d?: boolean) => d ?? false),
		} as never,
		sessionStore: {
			get: vi.fn(async () => null),
			set: vi.fn(),
			getAll: vi.fn(async () => []),
		} as never,
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
		...overrides,
	};
}

// A fake runtime factory that returns doubles. This replaces the old test's
// broad constructor module mocks (SessionManager, WorkspaceManager,
// DockerWorkerExecutor, GitHubIssueHandlers, StaleSessionDetector, SkillStore,
// RepoSkillService, WorkerRpcServer, ...) with a single injected collaborator.
function makeFakeFactory(services: Partial<RuntimeServices> = {}) {
	const full: RuntimeServices = {
		sessionAuth: { isAdminAuthorized: vi.fn(() => true) } as never,
		sessionManager: {
			markFailed: vi.fn(async () => undefined),
			updateStatus: vi.fn(async () => undefined),
		} as never,
		workspaceManager: {} as never,
		workerRpcServer: { attach: vi.fn(), close: vi.fn(async () => undefined) } as never,
		github: {} as never,
		githubGateway: {} as never,
		executor: {
			prebuildWorkerImage: vi.fn(async () => undefined),
		} as never,
		eventStore: {} as never,
		refinementStore: {} as never,
		handlers: {
			handleGitHubEvent: vi.fn(async () => undefined),
			isInFlight: vi.fn(() => false),
			resumeInterruptedSession: vi.fn(async () => undefined),
		} as never,
		staleDetector: {
			detectStaleSessions: vi.fn(async () => []),
		} as never,
		skillStore: {} as never,
		repoSkillService: {} as never,
		githubPolling: {} as never,
		startIssueSession: vi.fn(async () => undefined) as never,
		metricsStore: {} as never,
		...services,
	};
	return vi.fn((_ctx: RuntimeBuildContext) => full);
}

function makeFakeServer() {
	return {
		listen: vi.fn((_port: number, cb?: () => void) => {
			if (typeof cb === "function") cb();
			return undefined;
		}),
		close: vi.fn((cb?: (err?: Error) => void) => {
			if (typeof cb === "function") cb();
			return undefined;
		}),
	};
}

function captureServer(): {
	create: RuntimeCollaborators["createWebhookServer"];
	instances: ReturnType<typeof makeFakeServer>[];
	options: Record<string, unknown>[];
} {
	const instances: ReturnType<typeof makeFakeServer>[] = [];
	const options: Record<string, unknown>[] = [];
	const create = vi.fn((opts: Record<string, unknown>) => {
		options.push(opts);
		const server = makeFakeServer();
		instances.push(server);
		return server;
	}) as never;
	return { create, instances, options };
}

describe("noOpHandlers", () => {
	it("handleGitHubEvent resolves to undefined", async () => {
		await expect(noOpHandlers.handleGitHubEvent?.({} as never)).resolves.toBeUndefined();
	});

	it("isInFlight returns false", () => {
		expect(noOpHandlers.isInFlight("mbrooks", "yolomatic", 1)).toBe(false);
	});
});

describe("resolveManagedGitHubEventMode", () => {
	it("falls back to the process-wide mode when no managed repo is present", () => {
		expect(resolveManagedGitHubEventMode(baseConfig, null)).toBe("webhook");
		const pollingConfig = { ...baseConfig, githubEventMode: "polling" as const };
		expect(resolveManagedGitHubEventMode(pollingConfig, null)).toBe("polling");
	});

	it("honors a per-repo override above the process-wide mode", () => {
		const managed = makeManagedRepo({ githubEventMode: "polling" });
		expect(resolveManagedGitHubEventMode(baseConfig, managed)).toBe("polling");
	});
});

describe("computeEventModeFlags", () => {
	it("enables webhook and disables polling in pure webhook mode with no overrides", () => {
		expect(computeEventModeFlags(baseConfig, [])).toEqual({
			githubEventsEnabled: true,
			pollingEnabled: false,
		});
	});

	it("enables polling and disables webhook in pure polling mode", () => {
		const pollingConfig = { ...baseConfig, githubEventMode: "polling" as const };
		expect(computeEventModeFlags(pollingConfig, [])).toEqual({
			githubEventsEnabled: false,
			pollingEnabled: true,
		});
	});

	it("enables both when event mode is both", () => {
		const bothConfig = { ...baseConfig, githubEventMode: "both" as const };
		expect(computeEventModeFlags(bothConfig, [])).toEqual({
			githubEventsEnabled: true,
			pollingEnabled: true,
		});
	});

	it("enables polling when a managed repo overrides webhook mode to polling", () => {
		const managed = makeManagedRepo({ githubEventMode: "polling" });
		expect(computeEventModeFlags(baseConfig, [managed])).toEqual({
			githubEventsEnabled: true,
			pollingEnabled: true,
		});
	});
});

describe("createRuntimeSettingsProvider", () => {
	it("reads a fresh runtime settings snapshot from the config boundary on each call", () => {
		const getConfigFn = vi.fn();
		getConfigFn.mockReturnValueOnce(baseConfig);
		getConfigFn.mockReturnValueOnce({ ...baseConfig, piAgentModel: "glm-5.2:cloud", logLevel: "info" });

		const settingsStore = {} as never;
		const provider = createRuntimeSettingsProvider(settingsStore, getConfigFn);

		const first = provider.get();
		expect(first.model.piAgentModel).toBe("kimi");
		expect(first.logging.logLevel).toBe("debug");

		const next = provider.get();
		expect(next.model.piAgentModel).toBe("glm-5.2:cloud");
		expect(next.logging.logLevel).toBe("info");

		// The provider re-reads config on every call so live DB updates flow
		// through without reconstructing the executor.
		expect(getConfigFn).toHaveBeenCalledTimes(2);
		expect(getConfigFn).toHaveBeenNthCalledWith(1, settingsStore);
		expect(getConfigFn).toHaveBeenNthCalledWith(2, settingsStore);
	});

	it("defaults to the real getConfig when no function is injected", () => {
		const provider = createRuntimeSettingsProvider({} as never);
		expect(typeof provider.get).toBe("function");
	});
});

describe("defaultRuntimeFactory", () => {
	it("constructs the real runtime services from a temp memory dir and wires resolvers through", async () => {
		const memoryDir = await mkdtemp(join(tmpdir(), "yolomatic-bootstrap-factory-"));
		try {
			const config = { ...baseConfig, memoryDir };
			const resolvers = {
				resolveDefaultBranch: vi.fn(() => "main"),
				resolveGitHubEventMode: vi.fn(() => "webhook" as RepoGitHubEventMode),
				resolveWorkerTemplate: vi.fn(() => DEFAULT_WORKER_TEMPLATE),
				resolveAdminBaseUrl: vi.fn(() => undefined),
				resolveIssueAdminLinkInCommentsEnabled: vi.fn(() => true),
			};
			const deps = makeDeps();
			const ctx: RuntimeBuildContext = {
				config,
				settingsStore: deps.settingsStore,
				sessionStore: deps.sessionStore,
				taskController: deps.taskController,
				repositoryStore: deps.repositoryStore,
				userStore: { hasAnySync: vi.fn(() => true) } as never,
				resolvers,
				findManaged: vi.fn(() => null),
			};

			const services = defaultRuntimeFactory(ctx);

			expect(services.sessionAuth).toBeDefined();
			expect(services.sessionManager).toBeDefined();
			expect(services.workspaceManager).toBeDefined();
			expect(services.workerRpcServer).toBeDefined();
			expect(services.github).toBeDefined();
			expect(services.githubGateway).toBeDefined();
			expect(services.executor).toBeDefined();
			expect(services.eventStore).toBeDefined();
			expect(services.refinementStore).toBeDefined();
			expect(services.handlers).toBeDefined();
			expect(services.staleDetector).toBeDefined();
			expect(services.skillStore).toBeDefined();
			expect(services.repoSkillService).toBeDefined();
			expect(services.githubPolling).toBeDefined();
			expect(services.startIssueSession).toBeDefined();
		} finally {
			await rm(memoryDir, { recursive: true, force: true });
		}
	});
});

describe("buildRuntimeGraph", () => {
	it("constructs a graph with webhook handlers enabled in webhook mode and does not listen", () => {
		const factory = makeFakeFactory();
		const { create, instances } = captureServer();
		const graph = buildRuntimeGraph(baseConfig, makeDeps(), { factory, createWebhookServer: create });

		expect(graph.server).toBe(instances[0]);
		expect(graph.handlers).toBeDefined();
		expect(graph.githubEventsEnabled).toBe(true);
		expect(graph.pollingEnabled).toBe(false);
		expect(factory).toHaveBeenCalledTimes(1);
		// Construction only — the server must not listen until startRuntime.
		expect(instances[0].listen).not.toHaveBeenCalled();
	});

	it("uses noOpHandlers for the webhook server in pure polling mode", () => {
		const factory = makeFakeFactory();
		const { create, options } = captureServer();
		const pollingConfig = { ...baseConfig, githubEventMode: "polling" as const };
		buildRuntimeGraph(pollingConfig, makeDeps(), { factory, createWebhookServer: create });

		expect(options[0].handlers).toBe(noOpHandlers);
	});

	it("wires the prebuilt start-issue session and restart dispatchers into the server options", async () => {
		const services: Partial<RuntimeServices> = {
			startIssueSession: vi.fn(async () => undefined) as never,
			handlers: {
				handleGitHubEvent: vi.fn(async () => undefined),
					isInFlight: vi.fn(() => false),
					resumeInterruptedSession: vi.fn(async () => undefined),
					restartRefinement: vi.fn(async () => undefined),
			} as never,
		};
		const factory = makeFakeFactory(services);
		const { create, options } = captureServer();
		const graph = buildRuntimeGraph(baseConfig, makeDeps(), { factory, createWebhookServer: create });

		expect(options[0].prebuiltStartIssueSession).toBe(graph.startIssueSession);

		const restartSession = options[0].restartSession as (owner: string, repo: string, n: number) => Promise<void>;
		await restartSession("mbrooks", "yolomatic", 513);
		expect(graph.handlers.resumeInterruptedSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 513);

		const restartRefinement = options[0].restartRefinement as (owner: string, repo: string, n: number) => Promise<void>;
		await restartRefinement("mbrooks", "yolomatic", 670);
		expect(graph.handlers.restartRefinement).toHaveBeenCalledWith("mbrooks", "yolomatic", 670);
	});

	it("passes repository resolvers derived from the startup snapshot into the factory context", () => {
		const managedRepo = makeManagedRepo({ githubEventMode: "polling", defaultBranch: "develop" });
		const deps = makeDeps({
			repositoryStore: {
				...makeDeps().repositoryStore,
				listSync: vi.fn(() => [managedRepo]),
				getSync: vi.fn((owner: string, repo: string) =>
					owner === "mbrooks" && repo === "yolomatic" ? managedRepo : null,
				),
			} as never,
		});
		const factory = vi.fn((ctx: RuntimeBuildContext) => makeFakeFactory()(ctx));
		buildRuntimeGraph(baseConfig, deps, { factory, createWebhookServer: captureServer().create });

		const { resolvers, findManaged } = factory.mock.calls[0][0];
		expect(resolvers.resolveDefaultBranch("mbrooks", "yolomatic")).toBe("develop");
		expect(resolvers.resolveDefaultBranch("other", "repo")).toBe("main");
		expect(resolvers.resolveGitHubEventMode("mbrooks", "yolomatic")).toBe("polling");
		expect(resolvers.resolveGitHubEventMode("other", "repo")).toBe("webhook");
		expect(findManaged("mbrooks", "yolomatic")).toBe(managedRepo);
		expect(findManaged("other", "repo")).toBeNull();
	});

	it("passes admin-link resolvers that read live from the SettingsStore", () => {
		const settingsValues: Record<string, string> = {
			admin_base_url: "http://host:6767/old/admin",
			issue_admin_link_in_comments_enabled: "true",
		};
		const settingsStore = {
			get: vi.fn((k: string) => settingsValues[k]),
			getBoolean: vi.fn((k: string, d?: boolean) =>
				settingsValues[k] === undefined ? (d ?? false) : settingsValues[k] === "true",
			),
		} as never;
		const deps = makeDeps({ settingsStore });
		const factory = vi.fn((ctx: RuntimeBuildContext) => makeFakeFactory()(ctx));
		buildRuntimeGraph(baseConfig, deps, { factory, createWebhookServer: captureServer().create });

		const { resolvers } = factory.mock.calls[0][0];
		expect(resolvers.resolveAdminBaseUrl()).toBe("http://host:6767/old/admin");
		expect(resolvers.resolveIssueAdminLinkInCommentsEnabled()).toBe(true);

		// Operator changes the settings in the admin UI without a restart.
		settingsValues.admin_base_url = "http://host:6767/new/admin";
		settingsValues.issue_admin_link_in_comments_enabled = "false";
		expect(resolvers.resolveAdminBaseUrl()).toBe("http://host:6767/new/admin");
		expect(resolvers.resolveIssueAdminLinkInCommentsEnabled()).toBe(false);

		// Empty/whitespace base URL resolves to undefined (link omitted).
		settingsValues.admin_base_url = "   ";
		expect(resolvers.resolveAdminBaseUrl()).toBeUndefined();
	});

	it("threads the session auth provider from the factory into the server options", () => {
		const sessionAuth = { isAdminAuthorized: vi.fn(() => true) } as never;
		const factory = makeFakeFactory({ sessionAuth });
		const { create, options } = captureServer();
		buildRuntimeGraph(baseConfig, makeDeps(), { factory, createWebhookServer: create });

		expect(options[0].sessionAuth).toBe(sessionAuth);
	});
});

describe("startRuntime", () => {
	it("listens on the configured port and returns the runtime graph", async () => {
		const factory = makeFakeFactory();
		const { create, instances } = captureServer();
		const startPolling = vi.fn();
		const graph = await startRuntime(baseConfig, makeDeps(), {
			factory,
			createWebhookServer: create,
			startPolling,
		});
		expect(instances[0].listen).toHaveBeenCalledWith(6767, expect.any(Function));
		expect(graph.server).toBe(instances[0]);
		expect(startPolling).not.toHaveBeenCalled();
	});

	it("does not mutate process.env migrated model/logging keys", async () => {
		const saved = {
			piAgentModel: process.env.PI_AGENT_MODEL,
			piAgentProvider: process.env.PI_AGENT_PROVIDER,
			openaiApiKey: process.env.OPENAI_API_KEY,
			logLevel: process.env.LOG_LEVEL,
			logPrompts: process.env.LOG_PROMPTS,
			logThoughts: process.env.LOG_THOUGHTS,
			logTools: process.env.LOG_TOOLS,
			logResponses: process.env.LOG_RESPONSES,
		};
		process.env.PI_AGENT_MODEL = "pre-existing-model";
		process.env.PI_AGENT_PROVIDER = "pre-existing-provider";
		process.env.OPENAI_API_KEY = "pre-existing-key";
		process.env.LOG_LEVEL = "warn";
		process.env.LOG_PROMPTS = "false";
		process.env.LOG_THOUGHTS = "false";
		process.env.LOG_TOOLS = "false";
		process.env.LOG_RESPONSES = "false";
		try {
			await startRuntime(baseConfig, makeDeps(), {
				factory: makeFakeFactory(),
				createWebhookServer: captureServer().create,
				startPolling: vi.fn(),
				cleanupSessions: vi.fn(async () => ({ deleted: 0, failed: 0 })),
			});
			expect(process.env.PI_AGENT_MODEL).toBe("pre-existing-model");
			expect(process.env.PI_AGENT_PROVIDER).toBe("pre-existing-provider");
			expect(process.env.OPENAI_API_KEY).toBe("pre-existing-key");
			expect(process.env.LOG_LEVEL).toBe("warn");
			expect(process.env.LOG_PROMPTS).toBe("false");
			expect(process.env.LOG_TOOLS).toBe("false");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else (process.env as Record<string, string | undefined>)[key] = value;
			}
		}
	});

	it("starts GitHub polling with the configured interval and dispatch wiring when polling is enabled", async () => {
		const factory = makeFakeFactory();
		const startPolling = vi.fn();
		const pollingConfig = { ...baseConfig, githubEventMode: "polling" as const, githubPollIntervalMs: 30000 };
		const deps = makeDeps();
		await startRuntime(pollingConfig, deps, {
			factory,
			createWebhookServer: captureServer().create,
			startPolling,
		});

		expect(startPolling).toHaveBeenCalledWith(
			expect.objectContaining({ intervalMs: 30000, githubUsername: "yolomatic-bot" }),
		);
		const pollingDeps = startPolling.mock.calls.at(-1)?.[0] as {
			dispatch: (event: unknown) => Promise<void>;
			github: unknown;
			eventStore: unknown;
		};
		expect(pollingDeps.github).toBeDefined();
		expect(pollingDeps.eventStore).toBeDefined();

		// The dispatch wiring forwards events to the real handlers.
		const handlers = factory.mock.results[0].value.handlers as { handleGitHubEvent: (e: unknown) => Promise<void> };
		await pollingDeps.dispatch({ id: "e1" });
		expect(handlers.handleGitHubEvent).toHaveBeenCalledWith({ id: "e1" });
	});

	it("exposes resolveGitHubEventMode and shouldPollRepo that honor per-repo overrides", async () => {
		const managedRepo = makeManagedRepo({ githubEventMode: "polling" });
		const deps = makeDeps({
			repositoryStore: {
				...makeDeps().repositoryStore,
				listSync: vi.fn(() => [managedRepo]),
				getSync: vi.fn((owner: string, repo: string) =>
					owner === "mbrooks" && repo === "yolomatic" ? managedRepo : null,
				),
				listForPolling: vi.fn(async () => [{ owner: "mbrooks", repo: "yolomatic" }]),
			} as never,
		});
		const startPolling = vi.fn();
		// Process mode webhook, but a managed repo overrides to polling.
		await startRuntime(baseConfig, deps, {
			factory: makeFakeFactory(),
			createWebhookServer: captureServer().create,
			startPolling,
		});

		const pollingDeps = startPolling.mock.calls.at(-1)?.[0] as {
			resolveGitHubEventMode: (owner: string, repo: string) => RepoGitHubEventMode;
			shouldPollRepo: (owner: string, repo: string) => boolean;
			resolveDefaultBranch: (owner: string, repo: string) => string;
			listManagedRepos: () => Promise<Array<{ owner: string; repo: string }>>;
		};
		expect(pollingDeps.resolveGitHubEventMode("mbrooks", "yolomatic")).toBe("polling");
		expect(pollingDeps.resolveGitHubEventMode("other", "repo")).toBe("webhook");
		expect(pollingDeps.shouldPollRepo("mbrooks", "yolomatic")).toBe(true);
		expect(pollingDeps.shouldPollRepo("other", "repo")).toBe(false);
		expect(pollingDeps.resolveDefaultBranch("mbrooks", "yolomatic")).toBe("main");
		expect(pollingDeps.resolveDefaultBranch("other", "repo")).toBe("main");
		expect(await pollingDeps.listManagedRepos()).toEqual([{ owner: "mbrooks", repo: "yolomatic" }]);
	});

	it("prebuilds the worker image asynchronously during startup", async () => {
		const prebuildWorkerImage = vi.fn(async () => undefined);
		const factory = makeFakeFactory({
			executor: { prebuildWorkerImage } as never,
		});
		const graph = await startRuntime(baseConfig, makeDeps(), {
			factory,
			createWebhookServer: captureServer().create,
			startPolling: vi.fn(),
		});
		expect(prebuildWorkerImage).toHaveBeenCalledTimes(1);
		expect(graph.executor.prebuildWorkerImage).toBe(prebuildWorkerImage);
	});

	it("does not block startup when the worker image prebuild fails", async () => {
		const factory = makeFakeFactory({
			executor: {
				prebuildWorkerImage: vi.fn(async () => {
					throw new Error("prebuild failed");
				}),
			} as never,
		});
		await expect(
			startRuntime(baseConfig, makeDeps(), {
				factory,
				createWebhookServer: captureServer().create,
				startPolling: vi.fn(),
			}),
		).resolves.toBeDefined();
	});

	it("runs stale detection and marks very old sessions as failed", async () => {
		const markFailed = vi.fn(async () => undefined);
		const factory = makeFakeFactory({
			sessionManager: { markFailed } as never,
			staleDetector: {
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
			} as never,
		});
		await startRuntime(baseConfig, makeDeps(), {
			factory,
			createWebhookServer: captureServer().create,
			startPolling: vi.fn(),
		});
		expect(markFailed).toHaveBeenCalledWith("mbrooks", "yolomatic", 99, "interrupted_or_abandoned");
	});

	it("swallows stale detection errors so startup always succeeds", async () => {
		const factory = makeFakeFactory({
			staleDetector: {
				detectStaleSessions: vi.fn(async () => {
					throw new Error("stale error");
				}),
			} as never,
		});
		await expect(
			startRuntime(baseConfig, makeDeps(), {
				factory,
				createWebhookServer: captureServer().create,
				startPolling: vi.fn(),
			}),
		).resolves.toBeDefined();
	});

	it("resumes interrupted working sessions on startup", async () => {
		const resumeInterruptedSession = vi.fn(async () => undefined);
		const factory = makeFakeFactory({
			handlers: {
				handleGitHubEvent: vi.fn(async () => undefined),
				isInFlight: vi.fn(() => false),
				resumeInterruptedSession,
			} as never,
		});
		const deps = makeDeps({
			sessionStore: {
				...makeDeps().sessionStore,
				getAll: vi.fn(async () => [
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
				] as SessionState[]),
			} as never,
		});
		await startRuntime(baseConfig, deps, {
			factory,
			createWebhookServer: captureServer().create,
			startPolling: vi.fn(),
		});
		expect(resumeInterruptedSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 42);
	});

	it("marks interrupted refinement sessions failed without resuming them", async () => {
		const resumeInterruptedSession = vi.fn(async () => undefined);
		const updateStatus = vi.fn(async () => undefined);
		const factory = makeFakeFactory({
			sessionManager: { updateStatus, markFailed: vi.fn(async () => undefined) } as never,
			handlers: {
				handleGitHubEvent: vi.fn(async () => undefined),
				isInFlight: vi.fn(() => false),
				resumeInterruptedSession,
			} as never,
		});
		const deps = makeDeps({
			sessionStore: {
				...makeDeps().sessionStore,
				getAll: vi.fn(async () => [
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
				] as SessionState[]),
			} as never,
		});
		await startRuntime(baseConfig, deps, {
			factory,
			createWebhookServer: captureServer().create,
			startPolling: vi.fn(),
		});

		expect(updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			517,
			"failed",
			expect.objectContaining({ summary: "interrupted by restart", resumeOnBoot: undefined }),
			"refinement",
		);
		expect(resumeInterruptedSession).not.toHaveBeenCalled();
	});

	it("resumes checkpointed pending sessions flagged with resumeOnBoot on startup", async () => {
		const resumeInterruptedSession = vi.fn(async () => undefined);
		const factory = makeFakeFactory({
			handlers: {
				handleGitHubEvent: vi.fn(async () => undefined),
				isInFlight: vi.fn(() => false),
				resumeInterruptedSession,
			} as never,
		});
		const deps = makeDeps({
			sessionStore: {
				...makeDeps().sessionStore,
				getAll: vi.fn(async () => [
					{
						owner: "mbrooks",
						repo: "yolomatic",
						issueNumber: 43,
						status: "pending",
						resumeOnBoot: true,
						workspacePath: "/tmp/ws",
						title: "Title",
						body: "Body",
						lastActivity: new Date().toISOString(),
						seeded: false,
					},
				] as SessionState[]),
			} as never,
		});
		await startRuntime(baseConfig, deps, {
			factory,
			createWebhookServer: captureServer().create,
			startPolling: vi.fn(),
		});
		expect(resumeInterruptedSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 43);
	});

	it("swallows per-session resume errors and outer resume errors", async () => {
		const factory = makeFakeFactory({
			handlers: {
				handleGitHubEvent: vi.fn(async () => undefined),
				isInFlight: vi.fn(() => false),
				resumeInterruptedSession: vi.fn(async () => {
					throw new Error("resume inner");
				}),
			} as never,
		});
		const deps = makeDeps({
			sessionStore: {
				...makeDeps().sessionStore,
				getAll: vi.fn(async () => [
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
				] as SessionState[]),
			} as never,
		});
		await expect(
			startRuntime(baseConfig, deps, {
				factory,
				createWebhookServer: captureServer().create,
				startPolling: vi.fn(),
			}),
		).resolves.toBeDefined();

		// Outer resume error path: getAll throws.
		const deps2 = makeDeps({
			sessionStore: {
				...makeDeps().sessionStore,
				getAll: vi.fn(async () => {
					throw new Error("resume outer");
				}),
			} as never,
		});
		await expect(
			startRuntime(baseConfig, deps2, {
				factory,
				createWebhookServer: captureServer().create,
				startPolling: vi.fn(),
			}),
		).resolves.toBeDefined();
	});

	it("runs cleanup on startup and arms the interval when retention is configured", async () => {
		const cleanupSessions = vi.fn(async () => ({ deleted: 3, failed: 0 }));
		const cleanupConfig = { ...baseConfig, cleanupRetentionDays: 7 };
		await startRuntime(cleanupConfig, makeDeps(), {
			factory: makeFakeFactory(),
			createWebhookServer: captureServer().create,
			startPolling: vi.fn(),
			cleanupSessions,
		});
		expect(cleanupSessions).toHaveBeenCalledTimes(1);
		expect(cleanupSessions).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			7,
		);
	});
});
