import { createServer } from "node:http";

import type { WebhookHandlers } from "./handlers.js";
import type { SessionStore } from "../session/store.js";
import type { TaskController } from "../task-controller.js";
import type { StaleSessionDetector } from "../session/stale-detector.js";
import type { WorkspaceService } from "../ports/workspace-service.js";
import type { GitHubService } from "../ports/github-service.js";
import type { SettingsStore } from "../settings/store.js";
import type { SkillStore } from "../skills/store.js";
import type { RepoSkillService } from "../skills/repo-skill-service.js";
import type { RepositoryStore } from "../repos/repository-store.js";
import type { RefinementStore } from "../refinement/store.js";
import type { ExecutionService } from "../ports/execution-service.js";
import type { WorkerRpcServer } from "../worker/rpc-server.js";
import type { StartIssueSession } from "../app/commands/start-issue-session.js";
import type { RestartSessionDispatcher } from "../app/commands/run-session-command.js";

import { handleAdminRoute } from "../adapters/http/admin-router.js";
import { sendText } from "../adapters/http/response-helpers.js";
import { createWebhookServerDeps, fallbackWorkspaceService } from "./server-deps.js";
import { readBody, verifySignature } from "./http-utils.js";
import { createAdminWebSocketServer, type WebSocketAuthProvider, type StatusProvider } from "./websocket-server.js";
import { DEFAULT_ADMIN_DEFAULT_PAGE, DEFAULT_ADMIN_PATH } from "../config.js";
import { onSessionLogEvent } from "../logging/log-events.js";
import { normalizeWebhookEvent } from "../adapters/github/webhook-adapter.js";
import { SessionStoreRepositoryAdapter } from "../adapters/persistence/session-store-repository-adapter.js";
import { CleanupOldSessions } from "../app/commands/cleanup-old-sessions.js";
import type { UserStore } from "../users/store.js";
import type { AdminSessionAuth } from "../adapters/http/admin-auth.js";

type WebhookServerOptions = {
	adminAssetsDir?: string;
	onOnboardingComplete?: () => void | Promise<void>;
	prebuiltStartIssueSession?: StartIssueSession;
	repositoryStore?: RepositoryStore;
	adminPath?: string;
	adminDefaultPage?: string;
	restartSession?: RestartSessionDispatcher;
	userStore?: UserStore;
	sessionAuth?: AdminSessionAuth;
};

export { readBody, verifySignature } from "./http-utils.js";

export function createWebhookServer(
	secret: string,
	handlers: WebhookHandlers,
	sessionStore: SessionStore,
	taskController?: TaskController,
	workspaceManager?: WorkspaceService,
	staleDetector?: StaleSessionDetector,
	archiveDir?: string,
	options: WebhookServerOptions = {},
	githubService?: GitHubService,
	settingsStore?: SettingsStore,
	skillStore?: SkillStore,
	repoSkillService?: RepoSkillService,
	executor?: ExecutionService,
	workerRpcServer?: WorkerRpcServer,
	refinementStore?: RefinementStore,
) {
	const adminPath = options.adminPath ?? DEFAULT_ADMIN_PATH;
	const adminDefaultPage = options.adminDefaultPage ?? DEFAULT_ADMIN_DEFAULT_PAGE;
	const serverDeps = createWebhookServerDeps(
		sessionStore,
		taskController,
		workspaceManager,
		staleDetector,
		archiveDir,
		options.adminAssetsDir,
		githubService,
		settingsStore,
		executor,
		options.prebuiltStartIssueSession,
		options.repositoryStore,
		adminPath,
		adminDefaultPage,
		refinementStore,
		options.restartSession,
		options.userStore,
		options.sessionAuth,
	);

	serverDeps.skillStore = skillStore;
	serverDeps.repoSkillService = repoSkillService;
	serverDeps.onOnboardingComplete = options.onOnboardingComplete;

	const authProvider: WebSocketAuthProvider = {
		isAuthorized: (request) => {
			const auth = serverDeps.sessionAuth;
			if (!auth) {
				// Onboarding mode: no admin users exist yet. Allow the dashboard
				// to load so the wizard can create the master admin account.
				return true;
			}
			return auth.isAdminAuthorized(request);
		},
	};

	const statusProvider: StatusProvider = {
		async getStatus(): Promise<unknown> {
			const result = await serverDeps.getAdminStatus.execute();
			return (result as { success: true; data: unknown }).data;
		},
	};

	const server = createServer(async (request, response) => {
		process.stdout.write(
			`[webhook] ${new Date().toISOString()} ${request.method ?? "UNKNOWN"} ${request.url ?? ""}\n`,
		);

		// Admin routes handled by the thin HTTP adapter
		const adminHandled = await handleAdminRoute(request, response, serverDeps);
		if (adminHandled) {
			return;
		}

		if (request.method !== "POST" || request.url !== "/webhook") {
			process.stdout.write("[webhook] rejected request: route mismatch\n");
			sendText(response, 404, "Not found");
			return;
		}

		const body = await readBody(request);
		const signature = request.headers["x-hub-signature-256"] as string | undefined;

		if (!verifySignature(secret, body, signature)) {
			process.stdout.write("[webhook] rejected request: invalid signature\n");
			sendText(response, 401, "Invalid signature");
			return;
		}

		const event = request.headers["x-github-event"] as string | undefined;
		const delivery = request.headers["x-github-delivery"] as string | undefined;

		const payload = JSON.parse(body.toString("utf8")) as unknown;
		process.stdout.write(
			`[webhook] accepted delivery=${delivery ?? "unknown"} event=${event ?? "unknown"}\n`,
		);

		try {
			const normalized = normalizeWebhookEvent(event, payload, delivery);
			if (normalized.length === 0) {
				process.stdout.write(`[webhook] ignored unsupported event=${event ?? "unknown"}\n`);
			} else if (handlers.handleGitHubEvent) {
				for (const githubEvent of normalized) {
					await handlers.handleGitHubEvent(githubEvent);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] handler error: ${message}\n`);
			sendText(response, 500, message);
			return;
		}

		process.stdout.write("[webhook] handled successfully\n");
		sendText(response, 200, "OK");
	});

	const wsServer = createAdminWebSocketServer(
		server,
		authProvider,
		statusProvider,
		serverDeps.taskController,
		adminPath,
	);
	workerRpcServer?.attach(server);

	const stopLogEvents = onSessionLogEvent((sessionKey, entry) => {
		wsServer.broadcastLog(sessionKey, entry);
	});

	const originalClose = server.close.bind(server);
	server.close = ((callback?: (err?: Error) => void) => {
		stopLogEvents();
		originalClose((err?: Error) => {
			void Promise.allSettled([
				wsServer.close(),
				workerRpcServer?.close() ?? Promise.resolve(),
			]).finally(() => {
				callback?.(err);
			});
		});
		return server;
	}) as typeof server.close;

	return server;
}

export async function cleanupOldSessions(
	sessionStore: SessionStore,
	workspaceManager: WorkspaceService | undefined,
	retentionDays: number,
): Promise<{ deleted: number; failed: number }> {
	const sessionRepo = new SessionStoreRepositoryAdapter(sessionStore);
	const workspaceService = workspaceManager ?? fallbackWorkspaceService;
	const command = new CleanupOldSessions(sessionRepo, workspaceService);
	return command.execute(retentionDays);
}
