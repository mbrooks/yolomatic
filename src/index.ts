import "dotenv/config";

import path from "node:path";
import { getConfig, isBootstrapComplete } from "./config.js";
import { SettingsStore } from "./settings/store.js";
import { SessionStore } from "./session/store.js";
import { RepositoryStore } from "./repos/repository-store.js";
import { SessionLogStore, configureSessionLogPersistence, loadPersistedSessionLogs } from "./logging/session-log-store.js";
import { TaskController } from "./task-controller.js";
import { createWebhookServer } from "./webhook/server.js";
import {
	noOpHandlers,
	startRuntime,
	syncConfigToEnv,
	type RuntimeGraph,
} from "./app/bootstrap.js";

export { noOpHandlers } from "./app/bootstrap.js";
export type { RuntimeGraph } from "./app/bootstrap.js";

export async function main(): Promise<void> {
	const memoryDir = path.resolve(process.env.MEMORY_DIR?.trim() || path.join(process.cwd(), "memory"));
	const settingsStore = new SettingsStore(path.join(memoryDir, "bot-state.sqlite"));
	settingsStore.seedFromEnv();
	settingsStore.applyDefaults();

	settingsStore.onChange(() => {
		try {
			syncConfigToEnv(getConfig(settingsStore));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[settings] failed to sync env after change: ${message}\n`);
		}
	});

	const config = getConfig(settingsStore);

	const sessionStore = new SessionStore(path.join(memoryDir, "bot-state.sqlite"), config.sessionsDir);
	await sessionStore.migrateFromFileStoreIfNeeded();
	configureSessionLogPersistence(new SessionLogStore(path.join(memoryDir, "bot-state.sqlite")));
	loadPersistedSessionLogs();
	const taskController = new TaskController();
	const repositoryStore = new RepositoryStore(path.join(memoryDir, "bot-state.sqlite"));

	if (!isBootstrapComplete(config)) {
		process.stdout.write("[onboarding] Required settings missing. Starting in onboarding mode.\n");

		let onboardingServer: ReturnType<typeof createWebhookServer> | undefined;
		let activated = false;

		onboardingServer = createWebhookServer(
			config.webhookSecret || "dummy-onboarding-secret",
			noOpHandlers,
			sessionStore,
			undefined,
			undefined,
			taskController,
			undefined,
			undefined,
			undefined,
			{
				onOnboardingComplete: async () => {
					if (activated) return;
					const nextConfig = getConfig(settingsStore);
					if (!isBootstrapComplete(nextConfig)) return;
					activated = true;
					if (onboardingServer) {
						await new Promise<void>((resolve, reject) => {
							onboardingServer!.close((error) => {
								if (error) reject(error);
								else resolve();
							});
						});
					}
					process.stdout.write("[onboarding] Settings loaded. Starting full runtime.\n");
					await startRuntime(nextConfig, { settingsStore, sessionStore, taskController, repositoryStore });
				},
				repositoryStore,
				adminPath: config.adminPath,
				adminDefaultPage: config.adminDefaultPage,
			},
			undefined,
			settingsStore,
		);

		onboardingServer.listen(config.port, () => {
			process.stdout.write(`[onboarding] Server listening on port ${config.port}\n`);
		});
		return;
	}

	await startRuntime(config, { settingsStore, sessionStore, taskController, repositoryStore });
}

/* v8 ignore start */
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		const message = error instanceof Error ? error.stack ?? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	});
}
/* v8 ignore stop */