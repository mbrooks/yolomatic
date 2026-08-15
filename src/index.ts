import "dotenv/config";

import path from "node:path";
import { getConfig, isBootstrapComplete, type AppConfig } from "./config.js";
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
	type RuntimeDeps,
	type RuntimeGraph,
} from "./app/bootstrap.js";

export { noOpHandlers } from "./app/bootstrap.js";
export type { RuntimeGraph } from "./app/bootstrap.js";

export interface StartupState {
	settingsStore: SettingsStore;
	sessionStore: SessionStore;
	repositoryStore: RepositoryStore;
	userStore: UserStore;
	taskController: TaskController;
	config: AppConfig;
}

export type StartupStateFactory = (memoryDir: string) => StartupState;

/**
 * Default {@link StartupStateFactory}. Constructs the long-lived shared stores
 * and loads the initial config. Exported so the production wiring is visible
 * and so tests can inject a fake factory that returns doubles.
 */
export const defaultStartupStateFactory: StartupStateFactory = (memoryDir) => {
	const settingsStore = new SettingsStore(path.join(memoryDir, "bot-state.sqlite"));
	settingsStore.seedFromEnv();
	settingsStore.applyDefaults();

	const config = getConfig(settingsStore);
	const sessionStore = new SessionStore(path.join(memoryDir, "bot-state.sqlite"), config.sessionsDir);
	const repositoryStore = new RepositoryStore(path.join(memoryDir, "bot-state.sqlite"));
	const userStore = new UserStore(path.join(memoryDir, "bot-state.sqlite"));
	const taskController = new TaskController();

	return { settingsStore, sessionStore, repositoryStore, userStore, taskController, config };
};

function defaultConfigureLogging(memoryDir: string): void {
	configureSessionLogPersistence(new SessionLogStore(path.join(memoryDir, "bot-state.sqlite")));
	loadPersistedSessionLogs();
}

export { defaultConfigureLogging };

/**
 * Pure startup decision: enter onboarding mode when bootstrap is incomplete or
 * no admin user exists yet. Extracted from {@link main} so the branch can be
 * tested directly without constructing the runtime graph.
 */
export function shouldEnterOnboarding(bootstrapComplete: boolean, hasAdminUser: boolean): boolean {
	return !bootstrapComplete || !hasAdminUser;
}

/**
 * Read-only boot preflight: reports whether legacy file-backed session data
 * or unnormalized session kinds still exist. Never mutates files or rows.
 * Operators use this output to decide when to run the explicit legacy-file
 * deletion step described in `design/session-migration.md`.
 */
export async function logLegacyStateAudit(sessionStore: SessionStore): Promise<void> {
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

export interface OnboardingCompleteHandlerDeps {
	settingsStore: SettingsStore;
	sessionStore: SessionStore;
	taskController: TaskController;
	repositoryStore: RepositoryStore;
	userStore: UserStore;
	getConfig: (store: SettingsStore) => AppConfig;
	isBootstrapComplete: (config: AppConfig) => boolean;
	closeServer: () => Promise<void>;
	startRuntime: (config: AppConfig, deps: RuntimeDeps) => Promise<RuntimeGraph>;
}

/**
 * Build the `onOnboardingComplete` callback used by the onboarding webhook
 * server. Extracted from {@link main} so the transition logic (activated
 * guard, re-checking bootstrap after the wizard completes, closing the
 * onboarding server, and starting the full runtime) is testable without
 * recreating the runtime graph through module mocks.
 */
export function createOnboardingCompleteHandler(
	deps: OnboardingCompleteHandlerDeps,
): () => Promise<void> {
	let activated = false;
	return async () => {
		if (activated) return;
		const nextConfig = deps.getConfig(deps.settingsStore);
		if (!deps.isBootstrapComplete(nextConfig) || !deps.userStore.hasAnySync()) return;
		activated = true;
		await deps.closeServer();
		process.stdout.write("[onboarding] Settings loaded. Starting full runtime.\n");
		await deps.startRuntime(nextConfig, {
			settingsStore: deps.settingsStore,
			sessionStore: deps.sessionStore,
			taskController: deps.taskController,
			repositoryStore: deps.repositoryStore,
			userStore: deps.userStore,
		});
	};
}

export interface MainCollaborators {
	startupState?: StartupStateFactory;
	loadConfig?: (store: SettingsStore) => AppConfig;
	isBootstrapComplete?: (config: AppConfig) => boolean;
	createWebhookServer?: typeof createWebhookServer;
	startRuntime?: (config: AppConfig, deps: RuntimeDeps) => Promise<RuntimeGraph>;
	configureLogging?: (memoryDir: string) => void;
	memoryDir?: string;
}

export async function main(collaborators: MainCollaborators = {}): Promise<void> {
	const memoryDir =
		collaborators.memoryDir ??
		path.resolve(process.env.MEMORY_DIR?.trim() || path.join(process.cwd(), "memory"));
	const startupState = collaborators.startupState ?? defaultStartupStateFactory;
	const loadConfig = collaborators.loadConfig ?? getConfig;
	const isBootstrapCompleteFn = collaborators.isBootstrapComplete ?? isBootstrapComplete;
	const createServer = collaborators.createWebhookServer ?? createWebhookServer;
	const startRuntimeFn = collaborators.startRuntime ?? startRuntime;
	const configureLogging = collaborators.configureLogging ?? defaultConfigureLogging;

	const { settingsStore, sessionStore, repositoryStore, userStore, taskController, config } =
		startupState(memoryDir);

	// The file-backed compatibility importer is no longer run automatically at
	// boot. Run a read-only preflight audit instead so operators can see whether
	// legacy state files or unnormalized session kinds remain before the
	// separate explicit legacy-file deletion step.
	await logLegacyStateAudit(sessionStore);
	configureLogging(memoryDir);

	const hasAdminUser = userStore.hasAnySync();

	if (shouldEnterOnboarding(isBootstrapCompleteFn(config), hasAdminUser)) {
		process.stdout.write(
			"[onboarding] Required settings missing or no admin user. Starting in onboarding mode.\n",
		);

		let onboardingServer: ReturnType<typeof createWebhookServer> | undefined;

		const onOnboardingComplete = createOnboardingCompleteHandler({
			settingsStore,
			sessionStore,
			taskController,
			repositoryStore,
			userStore,
			getConfig: loadConfig,
			isBootstrapComplete: isBootstrapCompleteFn,
			closeServer: () =>
				new Promise<void>((resolve, reject) => {
					if (!onboardingServer) {
						resolve();
						return;
					}
					onboardingServer.close((error) => {
						if (error) reject(error);
						else resolve();
					});
				}),
			startRuntime: startRuntimeFn,
		});

		onboardingServer = createServer({
			secret: config.webhookSecret || "dummy-onboarding-secret",
			handlers: noOpHandlers,
			sessionStore,
			taskController,
			onOnboardingComplete,
			repositoryStore,
			adminPath: config.adminPath,
			adminDefaultPage: config.adminDefaultPage,
			userStore,
			sessionAuth: new AdminSessionAuth(userStore),
			settingsStore,
		});

		onboardingServer.listen(config.port, () => {
			process.stdout.write(`[onboarding] Server listening on port ${config.port}\n`);
		});
		return;
	}

	await startRuntimeFn(config, {
		settingsStore,
		sessionStore,
		taskController,
		repositoryStore,
		userStore,
	});
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