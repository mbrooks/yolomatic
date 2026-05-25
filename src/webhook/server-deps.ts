import { resolve } from "node:path";

import { systemClock } from "../ports/clock.js";
import { SessionStoreRepositoryAdapter } from "../adapters/persistence/session-store-repository-adapter.js";
import { WorkspaceServiceAdapter } from "../adapters/persistence/workspace-service-adapter.js";
import { TaskControlServiceAdapter } from "../adapters/persistence/task-control-service-adapter.js";
import { StaleSessionServiceAdapter } from "../adapters/persistence/stale-session-service-adapter.js";
import { GetAdminStatus } from "../app/queries/get-admin-status.js";
import { GetSession } from "../app/queries/get-session.js";
import { GetSessionLog } from "../app/queries/get-session-log.js";
import { RunSessionCommand } from "../app/commands/run-session-command.js";
import { CleanupOldSessions } from "../app/commands/cleanup-old-sessions.js";
import type { SessionStore } from "../session/store.js";
import type { TaskController } from "../task-controller.js";
import type { StaleSessionDetector } from "../session/stale-detector.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { CronStore } from "../cron/store.js";
import type { GitHubService } from "../ports/github-service.js";
import type { AdminRouterDeps } from "../adapters/http/admin-router.js";

const fallbackTaskController = {
	cancel: () => false,
	isActive: () => false,
	steer: async () => false,
	register: () => undefined,
	unregister: () => undefined,
	isDraining: () => false,
	setDraining: () => undefined,
};

const fallbackWorkspaceService = {
	createOrGetWorktree: async () => ({ path: "", branch: "" }),
	removeWorktree: async () => undefined,
	commitAndPush: async () => false,
	hasChanges: async () => false,
	getWorktreePath: () => "",
	getGitStatus: async () => "",
	getGitDiff: async () => "",
};

export function createWebhookServerDeps(
	sessionStore: SessionStore,
	adminUsername?: string,
	adminPassword?: string,
	taskController?: TaskController,
	workspaceManager?: WorkspaceManager,
	staleDetector?: StaleSessionDetector,
	archiveDir?: string,
	cronStore?: CronStore,
	adminAssetsDir = resolve(process.cwd(), "dist/admin"),
	githubService?: GitHubService,
): AdminRouterDeps & {
	cleanupCommand: CleanupOldSessions;
} {
	const sessionRepo = new SessionStoreRepositoryAdapter(sessionStore);
	const workspaceService = workspaceManager ? new WorkspaceServiceAdapter(workspaceManager) : fallbackWorkspaceService;
	const taskService = taskController ? new TaskControlServiceAdapter(taskController) : fallbackTaskController;
	const staleService = staleDetector ? new StaleSessionServiceAdapter(staleDetector) : { detectStaleSessions: async () => [] };

	return {
		cronStore,
		getAdminStatus: new GetAdminStatus(sessionRepo, staleService, systemClock, taskService),
		getSession: new GetSession(sessionRepo),
		getSessionLog: new GetSessionLog(sessionRepo),
		runSessionCommand: new RunSessionCommand(sessionRepo, workspaceService, taskService, systemClock, archiveDir),
		taskController: taskService,
		githubService,
		adminUsername,
		adminPassword,
		adminAssetsDir,
		cleanupCommand: new CleanupOldSessions(sessionRepo, workspaceService),
	};
}
