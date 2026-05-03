import "dotenv/config";

import { getConfig } from "./config.js";
import { PiAgentExecutor } from "./executor/index.js";
import { SessionManager } from "./session/manager.js";
import { SessionStore } from "./session/store.js";
import { GitHubIssueHandlers } from "./webhook/handlers.js";
import { createWebhookServer } from "./webhook/server.js";
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
	});
	const executor = new PiAgentExecutor({ soulPath: config.soulPath });
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
	});

	const server = createWebhookServer(config.webhookSecret, handlers, sessionStore, config.adminUsername, config.adminPassword);
	server.listen(config.port, () => {
		process.stdout.write(`Webhook receiver listening on port ${config.port}\n`);
	});
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
