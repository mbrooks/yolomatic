import { createServer } from "node:http";

import type { WebhookHandlers } from "./handlers.js";
import type { SessionStore } from "../session/store.js";
import type { TaskController } from "../task-controller.js";
import type { StaleSessionDetector } from "../session/stale-detector.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { CronStore } from "../cron/store.js";
import type { GitHubService } from "../ports/github-service.js";

import { handleAdminRoute } from "../adapters/http/admin-router.js";
import { sendText } from "../adapters/http/response-helpers.js";
import { createWebhookServerDeps } from "./server-deps.js";
import { readBody, verifySignature } from "./http-utils.js";

type WebhookServerOptions = {
	adminAssetsDir?: string;
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
	);

	return createServer(async (request, response) => {
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
}

export async function cleanupOldSessions(
	sessionStore: SessionStore,
	workspaceManager: WorkspaceManager | undefined,
	retentionDays: number,
): Promise<{ deleted: number; failed: number }> {
	return createWebhookServerDeps(sessionStore, undefined, undefined, undefined, workspaceManager).cleanupCommand.execute(retentionDays);
}
