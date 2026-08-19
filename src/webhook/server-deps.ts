import { resolve } from "node:path";

import { systemClock } from "../ports/clock.js";
import { DEFAULT_ADMIN_DEFAULT_PAGE, DEFAULT_ADMIN_PATH } from "../config.js";
import { SessionStoreRepositoryAdapter } from "../adapters/persistence/session-store-repository-adapter.js";
import { GetAdminStatus } from "../app/queries/get-admin-status.js";
import { GetSession } from "../app/queries/get-session.js";
import { GetSessionLog } from "../app/queries/get-session-log.js";
import { GetRefinementLog } from "../app/queries/get-refinement-log.js";
import { ListRefinementAttempts } from "../app/queries/list-refinement-attempts.js";
import { GetMetrics } from "../app/queries/get-metrics.js";
import { RunSessionCommand, type RestartSessionDispatcher } from "../app/commands/run-session-command.js";
import type { StartIssueSession } from "../app/commands/start-issue-session.js";
import type { TaskControlService } from "../ports/task-control-service.js";
import type { SessionStore } from "../session/store.js";
import type { TaskController } from "../task-controller.js";
import type { StaleSessionDetector } from "../session/stale-detector.js";
import type { WorkspaceService } from "../ports/workspace-service.js";
import type { GitHubService } from "../ports/github-service.js";
import type { AdminRouterDeps } from "../adapters/http/admin-router.js";
import type { SettingsStore } from "../settings/store.js";
import type { RepositoryStore } from "../repos/repository-store.js";
import type { RefinementStore } from "../refinement/store.js";
import { CleanupOldSessions } from "../app/commands/cleanup-old-sessions.js";
import type { ExecutionService } from "../ports/execution-service.js";
import { DefaultOllamaSignInService } from "../ollama/signin-status.js";
import type { UserStore } from "../users/store.js";
import type { AdminSessionAuth } from "../adapters/http/admin-auth.js";
import type { MetricsStore } from "../metrics/store.js";
import { GitHubServiceAdapter } from "../adapters/github/github-service-adapter.js";
import { WorkspaceManager } from "../workspace/manager.js";

const fallbackTaskController = {
	cancel: () => false,
	isActive: () => false,
	steer: async () => false,
	register: () => Symbol("fallback-task"),
	unregister: () => undefined,
	isDraining: () => false,
	setDraining: () => undefined,
};

const fallbackWorkspaceService: WorkspaceService = {
	createOrGetWorktree: async () => ({ path: "", branch: "" }),
	updateDefaultBranchFromOrigin: async () => ({ branch: "main", before: null, after: "", updated: false }),
	syncWorktree: async () => undefined,
	removeWorktree: async () => undefined,
	commitAndPush: async () => false,
	commitAndPushPath: async () => false,
	hasChanges: async () => false,
	getWorktreePath: () => "",
	getGitStatus: async () => "",
	getGitDiff: async () => "",
};

export { fallbackWorkspaceService };

export function createWebhookServerDeps(
	sessionStore: SessionStore,
	taskController?: TaskController,
	workspaceManager?: WorkspaceService,
	staleDetector?: StaleSessionDetector,
	archiveDir?: string,
	adminAssetsDir = resolve(process.cwd(), "dist/admin"),
	githubService?: GitHubService,
	settingsStore?: SettingsStore,
	executor?: ExecutionService,
	prebuiltStartIssueSession?: StartIssueSession,
	repositoryStore?: RepositoryStore,
	adminPath: string = DEFAULT_ADMIN_PATH,
	adminDefaultPage: string = DEFAULT_ADMIN_DEFAULT_PAGE,
	refinementStore?: RefinementStore,
	restartSession?: RestartSessionDispatcher,
	userStore?: UserStore,
	sessionAuth?: AdminSessionAuth,
	metricsStore?: MetricsStore,
	restartRefinement?: RestartSessionDispatcher,
	githubFactory?: (githubToken: string) => GitHubService,
	workspaceFactory?: (options: {
		workspacesDir: string;
		githubUsername: string;
		githubToken: string;
		defaultBranch: string;
	}) => { initializeRepo(owner: string, repo: string): Promise<void> },
): AdminRouterDeps & {
	cleanupCommand: CleanupOldSessions;
} {
	const sessionRepo = new SessionStoreRepositoryAdapter(sessionStore);
	const workspaceService = workspaceManager ?? fallbackWorkspaceService;
	const taskService = taskController ?? fallbackTaskController;
	const staleService = staleDetector ?? { detectStaleSessions: async () => [] };

	return {
		getAdminStatus: new GetAdminStatus(sessionRepo, staleService, systemClock, taskService, repositoryStore),
		getSession: new GetSession(sessionRepo),
		getSessionLog: new GetSessionLog(sessionRepo),
		runSessionCommand: new RunSessionCommand(
			sessionRepo,
			workspaceService,
			taskService,
			systemClock,
			archiveDir,
			restartSession,
			restartRefinement,
		),
		startIssueSession: prebuiltStartIssueSession,
		taskController: taskService,
		githubService,
		sessionAuth,
		userStore,
		adminAssetsDir,
		settingsStore,
		repositoryStore,
		refinementStore,
		getRefinementLog: refinementStore ? new GetRefinementLog(refinementStore) : undefined,
		listRefinementAttempts: refinementStore ? new ListRefinementAttempts(refinementStore) : undefined,
		cleanupCommand: new CleanupOldSessions(sessionRepo, workspaceService),
		adminPath,
		adminDefaultPage,
		ollamaSignInService: settingsStore ? new DefaultOllamaSignInService(settingsStore) : undefined,
		getMetrics: metricsStore ? new GetMetrics(metricsStore) : undefined,
		// Onboarding factories: the composition boundary owns construction of
		// the GitHub adapter and workspace manager so the onboarding routes no
		// longer build concrete implementations inline. Defaults wrap the real
		// constructors; tests inject fakes to observe the calls.
		githubFactory: githubFactory ?? ((token) => new GitHubServiceAdapter({ githubToken: token })),
		workspaceFactory:
			workspaceFactory ??
			((options) => new WorkspaceManager(options)),
	};
}
