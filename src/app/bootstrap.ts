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
	type RepoGitHubEventMode,
	type Repository,
} from "../repos/repository.js";
import { GitHubPollingAdapter } from "../adapters/github/github-polling-adapter.js";
import { GitHubServiceAdapter } from "../adapters/github/github-service-adapter.js";
import { GitHubEventStore } from "../github-events/store.js";
import { startGitHubPolling } from "../github-events/polling.js";
import { SessionStoreRepositoryAdapter } from "../adapters/persistence/session-store-repository-adapter.js";
import { systemClock } from "../ports/clock.js";
import { createStartIssueSession, type StartIssueSession } from "./commands/start-issue-session.js";
import type { SettingsStore } from "../settings/store.js";

export const noOpHandlers: WebhookHandlers = {
	async handleGitHubEvent() {},
	isInFlight() {
		return false;
	},
};

export function syncConfigToEnv(nextConfig: AppConfig): void {
	// Sync database settings to process.env so legacy code paths pick them up.
	process.env.PI_AGENT_MODEL = nextConfig.piAgentModel ?? "";
	process.env.PI_AGENT_PROVIDER = nextConfig.piAgentProvider ?? "";
	process.env.LOG_LEVEL = nextConfig.logLevel;
	process.env.LOG_PROMPTS = nextConfig.logPrompts ? "true" : "";
	process.env.LOG_THOUGHTS = nextConfig.logThoughts ? "true" : "";
	process.env.LOG_TOOLS = nextConfig.logTools ? "true" : "";
	process.env.LOG_RESPONSES = nextConfig.logResponses ? "true" : "";
}

export interface RuntimeDeps {
	settingsStore: SettingsStore;
	sessionStore: SessionStore;
	taskController: TaskController;
	repositoryStore: RepositoryStore;
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
 * Build the full runtime graph (managers, handlers, server, polling) from a
 * loaded AppConfig and the long-lived shared services. Construction only —
 * no startup side effects are performed here.
 */
export function buildRuntimeGraph(config: AppConfig, deps: RuntimeDeps): RuntimeGraph {
	const { settingsStore, sessionStore, taskController, repositoryStore } = deps;

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
		resolveRepoGitHubEventMode(findManaged(owner, repo), config.githubEventMode);

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
	const githubGateway = new WorkerGitHubGateway(github);
	const executor = new DockerWorkerExecutor({
		projectRoot: process.cwd(),
		workspacesDir: config.workspacesDir,
		workerImage: config.workerImage,
		workerWorkspaceMountSource: config.workerWorkspaceMountSource,
		workerControlBaseUrl: config.workerControlBaseUrl,
		workerDockerNetworkMode: config.workerDockerNetworkMode,
		workerRpcServer,
		workerOllamaHost: config.workerOllamaHost,
		soulPath: config.soulPath,
		githubGateway,
	});
	const eventStore = new GitHubEventStore(path.join(config.memoryDir, "bot-state.sqlite"));
	const refinementStore = new RefinementStore(path.join(config.memoryDir, "refinement.sqlite"));
	const handlers = new GitHubIssueHandlers({
		sessionManager,
		workspaceManager,
		executor,
		githubToken: config.githubToken,
		githubUsername: config.githubUsername,
		resolveDefaultBranch,
		resolveGitHubEventMode,
		selfReportEnabled: config.selfReportEnabled,
		taskController,
		adminGithubUsername: config.adminGithubUsername,
		eventStore,
		memoryDir: config.memoryDir,
		repositoryStore,
		refinementStore,
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
	});

	const repoModes = managedRepositories.map((repo) =>
		resolveRepoGitHubEventMode(repo, config.githubEventMode),
	);
	const githubEventsEnabled =
		repoModeIncludesWebhook(config.githubEventMode) ||
		repoModes.some((mode) => repoModeIncludesWebhook(mode));
	const pollingEnabled =
		repoModeIncludesPolling(config.githubEventMode) ||
		repoModes.some((mode) => repoModeIncludesPolling(mode));
	const activeHandlers: WebhookHandlers = githubEventsEnabled ? handlers : noOpHandlers;

	const server = createWebhookServer(
		config.webhookSecret,
		activeHandlers,
		sessionStore,
		config.adminUsername,
		config.adminPassword,
		taskController,
		workspaceManager,
		staleDetector,
		config.archiveDir,
		{ prebuiltStartIssueSession: startIssueSession, repositoryStore: deps.repositoryStore, adminPath: config.adminPath, adminDefaultPage: config.adminDefaultPage },
		github,
		settingsStore,
		skillStore,
		repoSkillService,
		executor,
		workerRpcServer,
		refinementStore,
	);

	return {
		server,
		handlers,
		sessionManager,
		workspaceManager,
		staleDetector,
		executor,
		startIssueSession,
		eventStore,
		githubPolling,
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
): Promise<RuntimeGraph> {
	syncConfigToEnv(config);
	const graph = buildRuntimeGraph(config, deps);
	const { server, handlers, workspaceManager, staleDetector } = graph;
	const { sessionStore } = deps;

	server.listen(config.port, () => {
		process.stdout.write(`Webhook receiver listening on port ${config.port}\n`);
	});

	if (graph.pollingEnabled) {
		startGitHubPolling({
			github: graph.githubPolling,
			eventStore: graph.eventStore,
			githubUsername: config.githubUsername,
			intervalMs: config.githubPollIntervalMs,
			listManagedRepos: async () => deps.repositoryStore.listForPolling(),
			shouldPollRepo: (owner, repo) =>
				repoModeIncludesPolling(resolveManagedGitHubEventModeFor(config, deps, owner, repo)),
			resolveGitHubEventMode: (owner, repo) =>
				resolveManagedGitHubEventModeFor(config, deps, owner, repo),
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
		const sessionsToResume = sessions.filter((s) => s.resumeOnBoot || s.status === "working");
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
		await cleanupOldSessions(sessionStore, workspaceManager, config.cleanupRetentionDays);
		const cleanupIntervalMs = 24 * 60 * 60 * 1000;
		const cleanupInterval = setInterval(() => {
			void cleanupOldSessions(sessionStore, workspaceManager, config.cleanupRetentionDays!);
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