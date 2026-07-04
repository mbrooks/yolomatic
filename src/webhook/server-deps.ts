import { resolve } from "node:path";

import { systemClock } from "../ports/clock.js";
import { SessionStoreRepositoryAdapter } from "../adapters/persistence/session-store-repository-adapter.js";
import { GetAdminStatus } from "../app/queries/get-admin-status.js";
import { GetSession } from "../app/queries/get-session.js";
import { GetSessionLog } from "../app/queries/get-session-log.js";
import { RunSessionCommand } from "../app/commands/run-session-command.js";
import { createStartIssueSession, StartIssueSession } from "../app/commands/start-issue-session.js";
import type { TaskControlService } from "../ports/task-control-service.js";
import type { SessionStore } from "../session/store.js";
import type { TaskController } from "../task-controller.js";
import type { StaleSessionDetector } from "../session/stale-detector.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { GitHubService } from "../ports/github-service.js";
import type { AdminRouterDeps } from "../adapters/http/admin-router.js";
import type { SettingsStore } from "../settings/store.js";
import { CleanupOldSessions } from "../app/commands/cleanup-old-sessions.js";
import type { ExecutionService } from "../ports/execution-service.js";
import { parseConfiguredRepositories, resolveConfiguredRepoDefaultBranch } from "../repos/configured-repositories.js";

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
	adminAssetsDir = resolve(process.cwd(), "dist/admin"),
	githubService?: GitHubService,
	settingsStore?: SettingsStore,
	executor?: ExecutionService,
	prebuiltStartIssueSession?: StartIssueSession,
): AdminRouterDeps & {
	cleanupCommand: CleanupOldSessions;
} {
	const sessionRepo = new SessionStoreRepositoryAdapter(sessionStore);
	const workspaceService = workspaceManager ?? fallbackWorkspaceService;
	const taskService = taskController ?? fallbackTaskController;
	const staleService = staleDetector ?? { detectStaleSessions: async () => [] };

	let startIssueSession = prebuiltStartIssueSession;
	if (!startIssueSession && githubService && settingsStore && executor) {
		const defaultBranch = settingsStore.getString("default_branch", "main");
		const githubUsername = settingsStore.get("github_username") ?? "";
		const selfReportEnabled = settingsStore.getBoolean("self_report_enabled", true);
		const resolveDefaultBranch = (owner: string, repo: string) =>
			resolveConfiguredRepoDefaultBranch(
				parseConfiguredRepositories(settingsStore.get("configured_repositories")),
				owner,
				repo,
				defaultBranch,
			);
		if (githubUsername) {
			startIssueSession = createStartIssueSession({
				sessions: sessionRepo,
				workspaces: workspaceService,
				github: githubService,
				tasks: taskService,
				executor,
				clock: systemClock,
				defaultBranch,
				resolveDefaultBranch,
				githubUsername,
				selfReportEnabled,
			});
		}
	}

	return {
		getAdminStatus: new GetAdminStatus(sessionRepo, staleService, systemClock, taskService, settingsStore),
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
