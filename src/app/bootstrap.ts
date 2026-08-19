import path from "node:path";

import type { AppConfig } from "../config.js";
import { SessionStore } from "../session/store.js";
import { SessionManager } from "../session/manager.js";
import { StaleSessionDetector } from "../session/stale-detector.js";
import { TaskController } from "../task-controller.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { DockerWorkerExecutor } from "../executor/docker-worker.js";
import { WorkerRpcServer } from "../worker/rpc-server.js";
import { WorkerGitHubGateway } from "../worker/github-gateway.js";
import { GitHubIssueHandlers, type WebhookHandlers } from "../webhook/handlers.js";
import { createGitHubEventApplication } from "./github-event-application.js";
import { cleanupOldSessions, createWebhookServer } from "../webhook/server.js";
import { SkillStore } from "../skills/store.js";
import { RepoSkillService } from "../skills/repo-skill-service.js";
import { RepositoryStore } from "../repos/repository-store.js";
import { RefinementStore } from "../refinement/store.js";
import {
	repoKey,
	repoModeIncludesPolling,
	repoModeIncludesWebhook,
	resolveRepoDefaultBranch,
	resolveRepoGitHubEventMode,
	resolveRepoWorkerTemplate,
	type RepoGitHubEventMode,
	type Repository,
} from "../repos/repository.js";
import { GitHubPollingAdapter } from "../adapters/github/github-polling-adapter.js";
import { GitHubServiceAdapter } from "../adapters/github/github-service-adapter.js";
import { GitHubEventStore } from "../github-events/store.js";
import { startGitHubPolling } from "../github-events/polling.js";
import { SessionStoreRepositoryAdapter } from "../adapters/persistence/session-store-repository-adapter.js";
import { systemClock } from "../ports/clock.js";
import { DatabaseSync } from "node:sqlite";
import { MetricsStore } from "../metrics/store.js";
import { createStartIssueSession, type StartIssueSession } from "./commands/start-issue-session.js";
import type { SettingsStore } from "../settings/store.js";
import { UserStore } from "../users/store.js";
import { AdminSessionAuth } from "../adapters/http/admin-auth.js";
import { DEFAULT_WORKER_TEMPLATE } from "../worker/templates.js";
import { getConfig } from "../config.js";
import { getRuntimeSettings, type RuntimeSettingsProvider } from "../runtime-settings.js";

export const noOpHandlers: WebhookHandlers = {
	async handleGitHubEvent() {},
	isInFlight() {
		return false;
	},
};

export interface RuntimeDeps {
	settingsStore: SettingsStore;
	sessionStore: SessionStore;
	taskController: TaskController;
	repositoryStore: RepositoryStore;
	userStore?: UserStore;
}

export interface RuntimeGraph {
	server: ReturnType<typeof createWebhookServer>;
	handlers: GitHubIssueHandlers;
	sessionManager: SessionManager;
	workspaceManager: WorkspaceManager;
	staleDetector: StaleSessionDetector;
	executor: DockerWorkerExecutor;
	startIssueSession: StartIssueSession;
	eventStore: GitHubEventStore;
	githubPolling: GitHubPollingAdapter;
	githubEventsEnabled: boolean;
	pollingEnabled: boolean;
}

/**
 * Pure startup decision helpers. Exported so startup tests can exercise the
 * onboarding/full-runtime branching logic directly without reconstructing the
 * runtime graph through module mocks.
 */

/**
 * Resolve the effective GitHub event mode for a single managed repository,
 * falling back to the process-wide default when no per-repo override exists.
 */
export function resolveManagedGitHubEventMode(
	config: AppConfig,
	managed: Repository | null,
): RepoGitHubEventMode {
	return resolveRepoGitHubEventMode(managed, config.githubEventMode);
}

/**
 * Compute whether webhook handling and/or polling are active given the
 * process-wide mode and the per-repo overrides snapshot at startup.
 */
export function computeEventModeFlags(
	config: AppConfig,
	managedRepositories: Repository[],
): { githubEventsEnabled: boolean; pollingEnabled: boolean } {
	const repoModes = managedRepositories.map((repo) =>
		resolveRepoGitHubEventMode(repo, config.githubEventMode),
	);
	const githubEventsEnabled =
		repoModeIncludesWebhook(config.githubEventMode) ||
		repoModes.some((mode) => repoModeIncludesWebhook(mode));
	const pollingEnabled =
		repoModeIncludesPolling(config.githubEventMode) ||
		repoModes.some((mode) => repoModeIncludesPolling(mode));
	return { githubEventsEnabled, pollingEnabled };
}

/**
 * Build a live runtime-settings provider that reads fresh from the
 * configuration boundary on each call. The `getConfig` function is injectable
 * so the provider can be unit-tested without mocking the config module.
 */
export function createRuntimeSettingsProvider(
	settingsStore: SettingsStore,
	getConfigFn: (store: SettingsStore) => AppConfig = getConfig,
): RuntimeSettingsProvider {
	return {
		get() {
			return getRuntimeSettings(getConfigFn(settingsStore));
		},
	};
}

/**
 * Resolvers derived from the startup repository snapshot and the live settings
 * store. Passed into the runtime factory so it can wire per-repo decisions
 * into the constructed services without re-reading the repository table.
 */
export interface RuntimeResolvers {
	resolveDefaultBranch: (owner: string, repo: string) => string;
	resolveGitHubEventMode: (owner: string, repo: string) => RepoGitHubEventMode;
	resolveWorkerTemplate: (owner: string, repo: string) => string;
	resolveAdminBaseUrl: () => string | undefined;
	resolveIssueAdminLinkInCommentsEnabled: () => boolean;
}

export interface RuntimeBuildContext {
	config: AppConfig;
	settingsStore: SettingsStore;
	sessionStore: SessionStore;
	taskController: TaskController;
	repositoryStore: RepositoryStore;
	userStore: UserStore;
	resolvers: RuntimeResolvers;
	findManaged: (owner: string, repo: string) => Repository | null;
}

/**
 * The set of runtime services constructed at the composition boundary. The
 * default factory builds the real first-party objects; tests inject a fake
 * factory returning doubles so construction can be observed without mocking
 * broad first-party modules.
 */
export interface RuntimeServices {
	sessionAuth: AdminSessionAuth;
	sessionManager: SessionManager;
	workspaceManager: WorkspaceManager;
	workerRpcServer: WorkerRpcServer;
	github: GitHubServiceAdapter;
	githubGateway: WorkerGitHubGateway;
	executor: DockerWorkerExecutor;
	eventStore: GitHubEventStore;
	refinementStore: RefinementStore;
	handlers: GitHubIssueHandlers;
	staleDetector: StaleSessionDetector;
	skillStore: SkillStore;
	repoSkillService: RepoSkillService;
	githubPolling: GitHubPollingAdapter;
	startIssueSession: StartIssueSession;
	metricsStore: MetricsStore;
}

export type RuntimeFactory = (ctx: RuntimeBuildContext) => RuntimeServices;

/**
 * Default {@link RuntimeFactory} that constructs the real runtime services.
 * Kept as a named export so the production wiring is observable and so tests
 * can assert the default collaborator wiring without module mocks.
 */
export const defaultRuntimeFactory: RuntimeFactory = (ctx) => {
	const { config, settingsStore, sessionStore, taskController, repositoryStore, userStore, resolvers } = ctx;
	const {
		resolveDefaultBranch,
		resolveGitHubEventMode,
		resolveWorkerTemplate,
		resolveAdminBaseUrl,
		resolveIssueAdminLinkInCommentsEnabled,
	} = resolvers;

	const sessionAuth = new AdminSessionAuth(userStore);

	const sessionManager = new SessionManager(config.sessionsDir, sessionStore);
	const workspaceManager = new WorkspaceManager({
		workspacesDir: config.workspacesDir,
		githubUsername: config.githubUsername,
		githubToken: config.githubToken,
		defaultBranch: config.defaultBranch,
		resolveDefaultBranch,
		maxWorktrees: config.maxWorktrees,
		evictionStrategy: config.evictionStrategy,
	});
	const workerRpcServer = new WorkerRpcServer();
	const github = new GitHubServiceAdapter({ githubToken: config.githubToken });
	const githubGateway = new WorkerGitHubGateway(github, workspaceManager);
	// Live model settings: read fresh from the SettingsStore on each launch so
	// database-setting updates affect subsequent worker sessions without
	// mutating process.env. The provider is the replacement for the old
	// syncConfigToEnv() live-sync path.
	const runtimeSettingsProvider: RuntimeSettingsProvider = createRuntimeSettingsProvider(settingsStore);
	const executor = new DockerWorkerExecutor({
		projectRoot: process.cwd(),
		workspacesDir: config.workspacesDir,
		defaultWorkerTemplate: config.defaultWorkerTemplate ?? DEFAULT_WORKER_TEMPLATE,
		resolveWorkerTemplate,
		workerWorkspaceMountSource: config.workerWorkspaceMountSource,
		workerControlBaseUrl: config.workerControlBaseUrl,
		workerDockerNetworkMode: config.workerDockerNetworkMode,
		workerRpcServer,
		workerOllamaHost: config.workerOllamaHost,
		soulPath: config.soulPath,
		githubGateway,
		runtimeSettings: runtimeSettingsProvider,
	});
	const eventStore = new GitHubEventStore(path.join(config.memoryDir, "bot-state.sqlite"));
	const metricsStore = new MetricsStore(new DatabaseSync(path.join(config.memoryDir, "bot-state.sqlite")));
	const refinementStore = new RefinementStore(path.join(config.memoryDir, "bot-state.sqlite"));
	const handlers = createGitHubEventApplication({
		sessions: sessionManager,
		workspaces: workspaceManager,
		executor,
		github,
		tasks: taskController,
		githubUsername: config.githubUsername,
		adminGithubUsername: config.adminGithubUsername,
		resolveDefaultBranch,
		resolveGitHubEventMode,
		selfReportEnabled: config.selfReportEnabled,
		eventStore,
		refinementStore,
		repositoryStore,
		issueNewCommentEnabled: config.issueNewCommentEnabled,
		issueAdminLinkInCommentsEnabled: config.issueAdminLinkInCommentsEnabled,
		adminBaseUrl: config.adminBaseUrl,
		resolveAdminBaseUrl,
		resolveIssueAdminLinkInCommentsEnabled,
		metrics: metricsStore,
	});

	const staleDetector = new StaleSessionDetector(
		sessionStore,
		workspaceManager,
		config.githubToken,
		(owner, repo, issueNumber) => handlers.isInFlight(owner, repo, issueNumber),
		config.staleThresholdMs,
	);

	const skillStore = new SkillStore(path.join(config.memoryDir, "bot-state.sqlite"));
	const repoSkillService = new RepoSkillService({
		workspacesDir: config.workspacesDir,
		githubUsername: config.githubUsername,
		githubToken: config.githubToken,
		defaultBranch: config.defaultBranch,
	});
	const githubPolling = new GitHubPollingAdapter({ githubToken: config.githubToken });

	const sessionRepo = new SessionStoreRepositoryAdapter(sessionStore);
	const startIssueSession = createStartIssueSession({
		sessions: sessionRepo,
		workspaces: workspaceManager,
		github,
		tasks: taskController,
		executor,
		clock: systemClock,
		defaultBranch: config.defaultBranch,
		resolveDefaultBranch,
		githubUsername: config.githubUsername,
		selfReportEnabled: config.selfReportEnabled,
		issueAdminLinkInCommentsEnabled: config.issueAdminLinkInCommentsEnabled,
		adminBaseUrl: config.adminBaseUrl,
		resolveAdminBaseUrl,
		resolveIssueAdminLinkInCommentsEnabled,
		metrics: metricsStore,
	});

	return {
		sessionAuth,
		sessionManager,
		workspaceManager,
		workerRpcServer,
		github,
		githubGateway,
		executor,
		eventStore,
		refinementStore,
		handlers,
		staleDetector,
		skillStore,
		repoSkillService,
		githubPolling,
		startIssueSession,
		metricsStore,
	};
};

/**
 * Collaborators injected at the composition boundary. Each defaults to the
 * real first-party implementation; tests pass doubles to observe construction
 * and side effects without mocking broad project modules.
 */
export interface RuntimeCollaborators {
	factory?: RuntimeFactory;
	createWebhookServer?: typeof createWebhookServer;
	startPolling?: typeof startGitHubPolling;
	cleanupSessions?: typeof cleanupOldSessions;
}

/**
 * Build the runtime graph (managers, handlers, server, polling) from a loaded
 * AppConfig and the long-lived shared services. Construction only — no startup
 * side effects are performed here. The {@link RuntimeCollaborators} parameter
 * lets tests observe the composition boundary without module mocks.
 */
export function buildRuntimeGraph(
	config: AppConfig,
	deps: RuntimeDeps,
	collaborators: RuntimeCollaborators = {},
): RuntimeGraph {
	const { settingsStore, sessionStore, taskController, repositoryStore } = deps;
	const factory = collaborators.factory ?? defaultRuntimeFactory;
	const createServer = collaborators.createWebhookServer ?? createWebhookServer;

	const userStore = deps.userStore ?? new UserStore(path.join(config.memoryDir, "bot-state.sqlite"));

	// Load managed repositories once at construction time. Per-repo overrides
	// (github_event_mode, default_branch) require a restart to take effect, so
	// snapshotting the table here matches the existing restart-required contract.
	const managedRepositories = repositoryStore.listSync();
	const managedRepoIndex = new Map<string, Repository>(
		managedRepositories.map((repo) => [repoKey(repo.owner, repo.repo), repo]),
	);
	const findManaged = (owner: string, repo: string) =>
		managedRepoIndex.get(repoKey(owner, repo)) ?? null;
	const resolveDefaultBranch = (owner: string, repo: string) =>
		resolveRepoDefaultBranch(findManaged(owner, repo), config.defaultBranch);
	const resolveGitHubEventMode = (owner: string, repo: string) =>
		resolveManagedGitHubEventMode(config, findManaged(owner, repo));
	const resolveWorkerTemplate = (owner: string, repo: string) =>
		resolveRepoWorkerTemplate(findManaged(owner, repo), config.defaultWorkerTemplate ?? DEFAULT_WORKER_TEMPLATE);
	// Admin-link settings advertise requiresRestart: false, so read them live
	// from the SettingsStore at comment-post time instead of snapshotting the
	// bootstrap-time config value. This lets operators toggle
	// issue_admin_link_in_comments_enabled / admin_base_url in the admin UI
	// and see the Track status footer update on subsequently posted comments
	// without restarting the process.
	const resolveAdminBaseUrl = () => {
		const raw = settingsStore.get("admin_base_url")?.trim();
		return raw || undefined;
	};
	const resolveIssueAdminLinkInCommentsEnabled = () =>
		settingsStore.getBoolean("issue_admin_link_in_comments_enabled", true);

	const services = factory({
		config,
		settingsStore,
		sessionStore,
		taskController,
		repositoryStore,
		userStore,
		resolvers: {
			resolveDefaultBranch,
			resolveGitHubEventMode,
			resolveWorkerTemplate,
			resolveAdminBaseUrl,
			resolveIssueAdminLinkInCommentsEnabled,
		},
		findManaged,
	});

	const { githubEventsEnabled, pollingEnabled } = computeEventModeFlags(config, managedRepositories);
	const activeHandlers: WebhookHandlers = githubEventsEnabled ? services.handlers : noOpHandlers;

	const server = createServer({
		secret: config.webhookSecret,
		handlers: activeHandlers,
		sessionStore,
		taskController,
		workspaceManager: services.workspaceManager,
		staleDetector: services.staleDetector,
		archiveDir: config.archiveDir,
		prebuiltStartIssueSession: services.startIssueSession,
		repositoryStore: deps.repositoryStore,
		adminPath: config.adminPath,
		adminDefaultPage: config.adminDefaultPage,
		restartSession: (owner, repo, issueNumber) =>
			services.handlers.resumeInterruptedSession(owner, repo, issueNumber),
		restartRefinement: (owner, repo, issueNumber) =>
			services.handlers.restartRefinement(owner, repo, issueNumber),
		userStore,
		sessionAuth: services.sessionAuth,
		githubService: services.github,
		settingsStore,
		skillStore: services.skillStore,
		repoSkillService: services.repoSkillService,
		executor: services.executor,
		workerRpcServer: services.workerRpcServer,
		refinementStore: services.refinementStore,
		metricsStore: services.metricsStore,
	});

	return {
		server,
		handlers: services.handlers,
		sessionManager: services.sessionManager,
		workspaceManager: services.workspaceManager,
		staleDetector: services.staleDetector,
		executor: services.executor,
		startIssueSession: services.startIssueSession,
		eventStore: services.eventStore,
		githubPolling: services.githubPolling,
		githubEventsEnabled,
		pollingEnabled,
	};
}

/**
 * Build the runtime graph and perform all startup side effects: start the
 * webhook server, optionally start GitHub polling, run startup stale
 * detection, resume interrupted sessions, and arm the cleanup interval.
 */
export async function startRuntime(
	config: AppConfig,
	deps: RuntimeDeps,
	collaborators: RuntimeCollaborators = {},
): Promise<RuntimeGraph> {
	const startPolling = collaborators.startPolling ?? startGitHubPolling;
	const cleanupSessions = collaborators.cleanupSessions ?? cleanupOldSessions;

	const graph = buildRuntimeGraph(config, deps, collaborators);
	const { server, handlers, workspaceManager, staleDetector } = graph;
	const { sessionStore, repositoryStore } = deps;

	server.listen(config.port, () => {
		process.stdout.write(`Webhook receiver listening on port ${config.port}\n`);
	});

	// Prebuild the worker image asynchronously so the first session does not
	// pay the Docker build cost before any agent work begins. The cached
	// promise deduplicates against any concurrent session launch, and failures
	// are swallowed so startup always succeeds.
	void graph.executor.prebuildWorkerImage();

	if (graph.pollingEnabled) {
		startPolling({
			github: graph.githubPolling,
			eventStore: graph.eventStore,
			githubUsername: config.githubUsername,
			intervalMs: config.githubPollIntervalMs,
			listManagedRepos: async () => repositoryStore.listForPolling(),
			shouldPollRepo: (owner, repo) =>
				repoModeIncludesPolling(resolveManagedGitHubEventModeFor(config, deps, owner, repo)),
			resolveGitHubEventMode: (owner, repo) =>
				resolveManagedGitHubEventModeFor(config, deps, owner, repo),
			resolveDefaultBranch: (owner, repo) =>
				resolveManagedDefaultBranchFor(config, deps, owner, repo),
			dispatch: (event) => handlers.handleGitHubEvent(event),
		});
	}

	// Startup stale detection: conservatively mark very old working sessions.
	try {
		const staleInfos = await staleDetector.detectStaleSessions();
		const veryOldThreshold = config.staleThresholdMs * 2;
		for (const info of staleInfos) {
			if (info.isStale && info.ageMs > veryOldThreshold && !info.session.staleDetectedAt) {
				process.stdout.write(
					`[startup] Marking stale session ${info.session.owner}/${info.session.repo}#${info.session.issueNumber} as interrupted_or_abandoned\n`,
				);
				await graph.sessionManager.markFailed(
					info.session.owner,
					info.session.repo,
					info.session.issueNumber,
					"interrupted_or_abandoned",
				);
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stdout.write(`[startup] stale detection error: ${message}\n`);
	}

	// Resume any sessions that were interrupted by a restart.
	try {
		const sessions = await sessionStore.getAll();
		const interruptedRefinements = sessions.filter(
			(s) => s.kind === "refinement" && s.status === "working",
		);
		for (const session of interruptedRefinements) {
			process.stdout.write(
				`[startup] Marking interrupted refinement ${session.owner}/${session.repo}#${session.issueNumber} as failed\n`,
			);
			await graph.sessionManager.updateStatus(session.owner, session.repo, session.issueNumber, "failed", {
				summary: "interrupted by restart",
				staleReason: "interrupted by restart",
				resumeOnBoot: undefined,
				queuedComments: undefined,
				taskFinishedAt: new Date().toISOString(),
			}, "refinement");
		}

		const sessionsToResume = sessions.filter(
			(s) => s.kind !== "refinement" && (s.resumeOnBoot || s.status === "working"),
		);
		if (sessionsToResume.length > 0) {
			process.stdout.write(`[startup] Found ${sessionsToResume.length} session(s) to resume after restart\n`);
			for (const session of sessionsToResume) {
				try {
					await handlers.resumeInterruptedSession(session.owner, session.repo, session.issueNumber);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(
						`[startup] failed to resume ${session.owner}/${session.repo}#${session.issueNumber}: ${message}\n`,
					);
				}
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stdout.write(`[startup] resume error: ${message}\n`);
	}

	if (config.cleanupRetentionDays) {
		process.stdout.write(`[cleanup] auto-cleanup enabled: ${config.cleanupRetentionDays} days\n`);
		await cleanupSessions(sessionStore, workspaceManager, config.cleanupRetentionDays);
		const cleanupIntervalMs = 24 * 60 * 60 * 1000;
		const cleanupInterval = setInterval(() => {
			void cleanupSessions(sessionStore, workspaceManager, config.cleanupRetentionDays!);
		}, cleanupIntervalMs);
		cleanupInterval.unref?.();
	}

	return graph;
}

function resolveManagedGitHubEventModeFor(
	config: AppConfig,
	deps: RuntimeDeps,
	owner: string,
	repo: string,
): RepoGitHubEventMode {
	const managed = deps.repositoryStore.getSync(owner, repo);
	return resolveRepoGitHubEventMode(managed, config.githubEventMode);
}

function resolveManagedDefaultBranchFor(
	config: AppConfig,
	deps: RuntimeDeps,
	owner: string,
	repo: string,
): string {
	const managed = deps.repositoryStore.getSync(owner, repo);
	return resolveRepoDefaultBranch(managed, config.defaultBranch);
}
