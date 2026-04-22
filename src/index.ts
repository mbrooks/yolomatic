import "dotenv/config";

import { getConfig } from "./config.js";
import { PiAgentExecutor } from "./executor/index.js";
import { SessionManager } from "./session/manager.js";
import { SessionStore } from "./session/store.js";
import { GitHubIssueHandlers } from "./webhook/handlers.js";
import { createWebhookServer } from "./webhook/server.js";
import { WorkspaceManager } from "./workspace/manager.js";

async function main(): Promise<void> {
	const config = getConfig();
	const sessionStore = new SessionStore(config.sessionsDir);
	const sessionManager = new SessionManager(config.sessionsDir, sessionStore);
	const workspaceManager = new WorkspaceManager({
		workspacesDir: config.workspacesDir,
		githubUsername: config.githubUsername,
		githubToken: config.githubToken,
		defaultBranch: config.defaultBranch,
	});
	const executor = new PiAgentExecutor();
	const handlers = new GitHubIssueHandlers({
		sessionManager,
		workspaceManager,
		executor,
		githubToken: config.githubToken,
		githubUsername: config.githubUsername,
		autoStart: config.autoStart,
	});

	const server = createWebhookServer(config.webhookSecret, handlers);
	server.listen(config.port, () => {
		process.stdout.write(`Webhook receiver listening on port ${config.port}\n`);
	});
}

main().catch((error) => {
	const message = error instanceof Error ? error.stack ?? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
});
