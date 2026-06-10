import { createServer } from "node:http";

import type { WebhookHandlers } from "./handlers.js";
import type { SessionStore } from "../session/store.js";
import type { TaskController } from "../task-controller.js";
import type { StaleSessionDetector } from "../session/stale-detector.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { CronStore } from "../cron/store.js";
import type { GitHubService } from "../ports/github-service.js";
import type { SettingsStore } from "../settings/store.js";
import type { SkillStore } from "../skills/store.js";
import type { RepoSkillService } from "../skills/repo-skill-service.js";

import { handleAdminRoute } from "../adapters/http/admin-router.js";
import { executeIssueChatRequest } from "../app/commands/issue-chat-request.js";
import { sendText } from "../adapters/http/response-helpers.js";
import { createWebhookServerDeps } from "./server-deps.js";
import { readBody, verifySignature } from "./http-utils.js";
import { createAdminWebSocketServer, type CredentialProvider, type StatusProvider } from "./websocket-server.js";
import { onSessionLogEvent } from "../logging/log-events.js";

type WebhookServerOptions = {
	adminAssetsDir?: string;
	onOnboardingComplete?: () => void | Promise<void>;
};

export { readBody, verifySignature } from "./http-utils.js";

export function createWebhookServer(
	secret: string,
	handlers: WebhookHandlers,
	sessionStore: SessionStore,
	adminUsername?: string,
	adminPassword?: string,
	taskController?: TaskController,
	workspaceManager?: WorkspaceManager,
	staleDetector?: StaleSessionDetector,
	archiveDir?: string,
	cronStore?: CronStore,
	options: WebhookServerOptions = {},
	githubService?: GitHubService,
	settingsStore?: SettingsStore,
	skillStore?: SkillStore,
	repoSkillService?: RepoSkillService,
) {
	const serverDeps = createWebhookServerDeps(
		sessionStore,
		adminUsername,
		adminPassword,
		taskController,
		workspaceManager,
		staleDetector,
		archiveDir,
		cronStore,
		options.adminAssetsDir,
		githubService,
		settingsStore,
	);

	serverDeps.skillStore = skillStore;
	serverDeps.repoSkillService = repoSkillService;
	serverDeps.onOnboardingComplete = options.onOnboardingComplete;

	const credentialProvider: CredentialProvider = {
		getCredentials(): { username?: string; password?: string } {
			if (serverDeps.adminUsername && serverDeps.adminPassword) {
				return { username: serverDeps.adminUsername, password: serverDeps.adminPassword };
			}
			const store = serverDeps.settingsStore;
			if (store) {
				const u = store.get("admin_username");
				const p = store.get("admin_password");
				if (u && p) return { username: u, password: p };
			}
			return {};
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
			if (event === "issues") {
				await handlers.handleIssueEvent(payload);
			} else if (event === "issue_comment") {
				await handlers.handleCommentEvent(payload);
			} else if (event === "pull_request_review_comment") {
				await handlers.handlePullRequestReviewCommentEvent(payload);
			} else if (event === "pull_request_review") {
				await handlers.handlePullRequestReviewEvent(payload);
			} else {
				process.stdout.write(`[webhook] ignored unsupported event=${event ?? "unknown"}\n`);
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
		credentialProvider,
		statusProvider,
		{
			runIssueChat: (payload, onProgress) => executeIssueChatRequest(serverDeps, payload, onProgress),
		},
	);

	const stopLogEvents = onSessionLogEvent((sessionKey, entry) => {
		wsServer.broadcastLog(sessionKey, entry);
	});

	const originalClose = server.close.bind(server);
	server.close = ((callback?: (err?: Error) => void) => {
		stopLogEvents();
		originalClose((err?: Error) => {
			void wsServer.close().finally(() => {
				callback?.(err);
			});
		});
		return server;
	}) as typeof server.close;

	return server;
}

export async function cleanupOldSessions(
	sessionStore: SessionStore,
	workspaceManager: WorkspaceManager | undefined,
	retentionDays: number,
): Promise<{ deleted: number; failed: number }> {
	return createWebhookServerDeps(sessionStore, undefined, undefined, undefined, workspaceManager).cleanupCommand.execute(retentionDays);
}
