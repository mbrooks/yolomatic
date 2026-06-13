import { resolve } from "node:path";

import { systemClock } from "../ports/clock.js";
import { SessionStoreRepositoryAdapter } from "../adapters/persistence/session-store-repository-adapter.js";
import { WorkspaceServiceAdapter } from "../adapters/persistence/workspace-service-adapter.js";
import { TaskControlServiceAdapter } from "../adapters/persistence/task-control-service-adapter.js";
import { StaleSessionServiceAdapter } from "../adapters/persistence/stale-session-service-adapter.js";
import { ExecutionServiceAdapter } from "../adapters/persistence/execution-service-adapter.js";
import { GetAdminStatus } from "../app/queries/get-admin-status.js";
import { GetSession } from "../app/queries/get-session.js";
import { GetSessionLog } from "../app/queries/get-session-log.js";
import { RunSessionCommand } from "../app/commands/run-session-command.js";
import { StartIssueSession } from "../app/commands/start-issue-session.js";
import type { TaskControlService } from "../ports/task-control-service.js";
import type { CronStore } from "../cron/store.js";
import type { SessionStore } from "../session/store.js";
import type { TaskController } from "../task-controller.js";
import type { StaleSessionDetector } from "../session/stale-detector.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { GitHubService } from "../ports/github-service.js";
import type { AdminRouterDeps } from "../adapters/http/admin-router.js";
import type { SettingsStore } from "../settings/store.js";
import { CleanupOldSessions } from "../app/commands/cleanup-old-sessions.js";
import type { PiAgentExecutor } from "../executor/index.js";

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
	commitAndPushPath: async () => false,
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
	settingsStore?: SettingsStore,
	executor?: PiAgentExecutor,
): AdminRouterDeps & {
	cleanupCommand: CleanupOldSessions;
} {
	const sessionRepo = new SessionStoreRepositoryAdapter(sessionStore);
	const workspaceService = workspaceManager ? new WorkspaceServiceAdapter(workspaceManager) : fallbackWorkspaceService;
	const taskService = taskController ? new TaskControlServiceAdapter(taskController) : fallbackTaskController;
	const staleService = staleDetector ? new StaleSessionServiceAdapter(staleDetector) : { detectStaleSessions: async () => [] };

	let startIssueSession: StartIssueSession | undefined;
	if (githubService && settingsStore && executor) {
		const defaultBranch = settingsStore.getString("default_branch", "main");
		const githubUsername = settingsStore.get("github_username") ?? "";
		const selfReportEnabled = settingsStore.getBoolean("self_report_enabled", true);
		if (githubUsername) {
			startIssueSession = new StartIssueSession(
				sessionRepo,
				workspaceService,
				githubService,
				taskService,
				new ExecutionServiceAdapter(executor),
				systemClock,
				defaultBranch,
				githubUsername,
				selfReportEnabled,
			);
		}
	}

	return {
		cronStore,
		getAdminStatus: new GetAdminStatus(sessionRepo, staleService, systemClock, taskService, cronStore, settingsStore),
		getSession: new GetSession(sessionRepo),
		getSessionLog: new GetSessionLog(sessionRepo),
		runSessionCommand: new RunSessionCommand(sessionRepo, workspaceService, taskService, systemClock, archiveDir),
		startIssueSession,
		taskController: taskService,
		githubService,
		adminUsername,
		adminPassword,
		adminAssetsDir,
		settingsStore,
		cleanupCommand: new CleanupOldSessions(sessionRepo, workspaceService),
	};
}
