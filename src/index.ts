import "dotenv/config";

import path from "node:path";
import { getConfig, isBootstrapComplete } from "./config.js";
import { SettingsStore } from "./settings/store.js";
import { SessionStore } from "./session/store.js";
import { RepositoryStore } from "./repos/repository-store.js";
import { UserStore } from "./users/store.js";
import { AdminSessionAuth } from "./adapters/http/admin-auth.js";
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
	// The file-backed compatibility importer is no longer run automatically at
	// boot. Run a read-only preflight audit instead so operators can see whether
	// legacy state files or unnormalized session kinds remain before the
	// separate explicit legacy-file deletion step.
	await logLegacyStateAudit(sessionStore);
	configureSessionLogPersistence(new SessionLogStore(path.join(memoryDir, "bot-state.sqlite")));
	loadPersistedSessionLogs();
	const taskController = new TaskController();
	const repositoryStore = new RepositoryStore(path.join(memoryDir, "bot-state.sqlite"));
	const userStore = new UserStore(path.join(memoryDir, "bot-state.sqlite"));
	const hasAdminUser = userStore.hasAnySync();

	if (!isBootstrapComplete(config) || !hasAdminUser) {
		process.stdout.write("[onboarding] Required settings missing or no admin user. Starting in onboarding mode.\n");

		let onboardingServer: ReturnType<typeof createWebhookServer> | undefined;
		let activated = false;

		onboardingServer = createWebhookServer(
			config.webhookSecret || "dummy-onboarding-secret",
			noOpHandlers,
			sessionStore,
			taskController,
			undefined,
			undefined,
			undefined,
			{
				onOnboardingComplete: async () => {
					if (activated) return;
					const nextConfig = getConfig(settingsStore);
					if (!isBootstrapComplete(nextConfig) || !userStore.hasAnySync()) return;
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
					await startRuntime(nextConfig, { settingsStore, sessionStore, taskController, repositoryStore, userStore });
				},
				repositoryStore,
				adminPath: config.adminPath,
				adminDefaultPage: config.adminDefaultPage,
				userStore,
				sessionAuth: new AdminSessionAuth(userStore),
			},
			undefined,
			settingsStore,
		);

		onboardingServer.listen(config.port, () => {
			process.stdout.write(`[onboarding] Server listening on port ${config.port}\n`);
		});
		return;
	}

	await startRuntime(config, { settingsStore, sessionStore, taskController, repositoryStore, userStore });
}

/**
 * Read-only boot preflight: reports whether legacy file-backed session data
 * or unnormalized session kinds still exist. Never mutates files or rows.
 * Operators use this output to decide when to run the explicit legacy-file
 * deletion step described in `design/session-migration.md`.
 */
async function logLegacyStateAudit(sessionStore: SessionStore): Promise<void> {
	if (typeof sessionStore.auditLegacyState !== "function") return;
	let audit;
	try {
		audit = await sessionStore.auditLegacyState();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stdout.write(`[session-store] legacy audit failed: ${message}\n`);
		return;
	}
	if (audit.clean) return;
	const parts: string[] = [];
	if (audit.legacyStateFiles.length > 0) {
		parts.push(`${audit.legacyStateFiles.length} legacy state file(s)`);
	}
	if (audit.sessionsMissingKind.length > 0) {
		parts.push(`${audit.sessionsMissingKind.length} session(s) missing kind`);
	}
	if (audit.malformedStateFiles.length > 0) {
		parts.push(`${audit.malformedStateFiles.length} malformed legacy file(s)`);
	}
	process.stdout.write(
		`[session-store] legacy audit: ${parts.join(", ")} remain. Run the explicit legacy-file deletion step from design/session-migration.md once clean.\n`,
	);
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