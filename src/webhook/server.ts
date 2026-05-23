import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { resolve } from "node:path";

import type { WebhookHandlers } from "./handlers.js";
import type { SessionStore } from "../session/store.js";
import type { TaskController } from "../task-controller.js";
import type { StaleSessionDetector } from "../session/stale-detector.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { CronStore } from "../cron/store.js";
import type { GitHubService } from "../ports/github-service.js";

import { systemClock } from "../ports/clock.js";
import { SessionStoreRepositoryAdapter } from "../adapters/persistence/session-store-repository-adapter.js";
import { WorkspaceServiceAdapter } from "../adapters/persistence/workspace-service-adapter.js";
import { TaskControlServiceAdapter } from "../adapters/persistence/task-control-service-adapter.js";
import { StaleSessionServiceAdapter } from "../adapters/persistence/stale-session-service-adapter.js";
import { GetAdminStatus } from "../app/queries/get-admin-status.js";
import { GetSession } from "../app/queries/get-session.js";
import { GetSessionLog } from "../app/queries/get-session-log.js";
import { RunSessionCommand } from "../app/commands/run-session-command.js";
import { CleanupOldSessions } from "../app/commands/cleanup-old-sessions.js";
import { handleAdminRoute } from "../adapters/http/admin-router.js";
import { sendText } from "../adapters/http/response-helpers.js";

type WebhookServerOptions = {
	adminAssetsDir?: string;
};

export async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

export function verifySignature(secret: string, payload: Buffer, signatureHeader: string | undefined): boolean {
	if (!signatureHeader) {
		return false;
	}
	const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
	const actual = Buffer.from(signatureHeader);
	const target = Buffer.from(expected);
	if (actual.length !== target.length) {
		return false;
	}
	return timingSafeEqual(actual, target);
}

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
) {
	const adminAssetsDir = options.adminAssetsDir ?? resolve(process.cwd(), "dist/admin");

	// Wire ports behind the new admin router
	const sessionRepo = new SessionStoreRepositoryAdapter(sessionStore);
	const workspaceService = workspaceManager ? new WorkspaceServiceAdapter(workspaceManager) : undefined;
	const taskService = taskController ? new TaskControlServiceAdapter(taskController) : undefined;
	const staleService = staleDetector ? new StaleSessionServiceAdapter(staleDetector) : undefined;

	const getAdminStatus = new GetAdminStatus(sessionRepo, staleService ?? { detectStaleSessions: async () => [] }, systemClock, taskService ?? {
		cancel: () => false,
		isActive: () => false,
		steer: async () => false,
		register: () => undefined,
		unregister: () => undefined,
		isDraining: () => false,
		setDraining: () => undefined,
	});
	const getSession = new GetSession(sessionRepo);
	const getSessionLog = new GetSessionLog(sessionRepo);
	const runSessionCommand = new RunSessionCommand(
		sessionRepo,
		workspaceService ?? {
			createOrGetWorktree: async () => ({ path: "", branch: "" }),
			removeWorktree: async () => undefined,
			commitAndPush: async () => false,
			hasChanges: async () => false,
			getWorktreePath: () => "",
		},
		taskService ?? {
			cancel: () => false,
			isActive: () => false,
			steer: async () => false,
			register: () => undefined,
			unregister: () => undefined,
			isDraining: () => false,
			setDraining: () => undefined,
		},
		systemClock,
		archiveDir,
	);

	return createServer(async (request, response) => {
		process.stdout.write(
			`[webhook] ${new Date().toISOString()} ${request.method ?? "UNKNOWN"} ${request.url ?? ""}\n`,
		);

		// Admin routes handled by the thin HTTP adapter
		const adminHandled = await handleAdminRoute(request, response, {
			cronStore,
			getAdminStatus,
			getSession,
			getSessionLog,
			runSessionCommand,
			taskController: taskService ?? {
				cancel: () => false,
				isActive: () => false,
				steer: async () => false,
				register: () => undefined,
				unregister: () => undefined,
				isDraining: () => false,
				setDraining: () => undefined,
			},
			githubService,
			adminUsername,
			adminPassword,
			adminAssetsDir,
		});
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
}

export async function cleanupOldSessions(
	sessionStore: SessionStore,
	workspaceManager: WorkspaceManager | undefined,
	retentionDays: number,
): Promise<{ deleted: number; failed: number }> {
	const repo = new SessionStoreRepositoryAdapter(sessionStore);
	const workspaces = workspaceManager ? new WorkspaceServiceAdapter(workspaceManager) : undefined;
	const command = new CleanupOldSessions(repo, workspaces ?? {
		createOrGetWorktree: async () => ({ path: "", branch: "" }),
		removeWorktree: async () => undefined,
		commitAndPush: async () => false,
		hasChanges: async () => false,
		getWorktreePath: () => "",
	});
	return command.execute(retentionDays);
}
