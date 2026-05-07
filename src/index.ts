import "dotenv/config";

import { getConfig } from "./config.js";
import { PiAgentExecutor } from "./executor/index.js";
import { SessionManager } from "./session/manager.js";
import { SessionStore } from "./session/store.js";
import { TaskController } from "./task-controller.js";
import { GitHubIssueHandlers } from "./webhook/handlers.js";
import { cleanupOldSessions, createWebhookServer } from "./webhook/server.js";
import { WorkspaceManager } from "./workspace/manager.js";

export async function main(): Promise<void> {
	const config = getConfig();
	const sessionStore = new SessionStore(config.sessionsDir);
	const sessionManager = new SessionManager(config.sessionsDir, sessionStore);
	const workspaceManager = new WorkspaceManager({
		workspacesDir: config.workspacesDir,
		githubUsername: config.githubUsername,
		githubToken: config.githubToken,
		defaultBranch: config.defaultBranch,
		maxWorktrees: config.maxWorktrees,
		evictionStrategy: config.evictionStrategy,
	});
	const executor = new PiAgentExecutor({ soulPath: config.soulPath });
	const taskController = new TaskController();
	const handlers = new GitHubIssueHandlers({
		sessionManager,
		workspaceManager,
		executor,
		githubToken: config.githubToken,
		githubUsername: config.githubUsername,
		autoStart: config.autoStart,
		defaultBranch: config.defaultBranch,
		selfReportEnabled: config.selfReportEnabled,
		maxIterations: config.maxIterations,
		taskController,
		adminGithubUsername: config.adminGithubUsername,
	});

	const server = createWebhookServer(
		config.webhookSecret,
		handlers,
		sessionStore,
		config.adminUsername,
		config.adminPassword,
		taskController,
		workspaceManager,
	);
	server.listen(config.port, () => {
		process.stdout.write(`Webhook receiver listening on port ${config.port}\n`);
	});

	if (config.cleanupRetentionDays) {
		process.stdout.write(`[cleanup] auto-cleanup enabled: ${config.cleanupRetentionDays} days\n`);
		await cleanupOldSessions(sessionStore, workspaceManager, config.cleanupRetentionDays);
		const cleanupIntervalMs = 24 * 60 * 60 * 1000;
		setInterval(() => {
			void cleanupOldSessions(sessionStore, workspaceManager, config.cleanupRetentionDays!);
		}, cleanupIntervalMs);
	}
}

/* c8 ignore start */
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		const message = error instanceof Error ? error.stack ?? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	});
}
/* c8 ignore stop */
