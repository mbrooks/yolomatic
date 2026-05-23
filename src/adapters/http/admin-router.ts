import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readBody } from "../../webhook/server.js";
import { sendHtml, sendJson, sendText } from "./response-helpers.js";
import type { GetAdminStatus } from "../../app/queries/get-admin-status.js";
import type { GetSession } from "../../app/queries/get-session.js";
import type { GetSessionLog } from "../../app/queries/get-session-log.js";
import type { RunSessionCommand, SessionCommand } from "../../app/commands/run-session-command.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { CronStore } from "../../cron/store.js";
import { computeNextRunAt } from "../../cron/store.js";
import { adminHtml, serveAdminAsset } from "./asset-server.js";

export interface AdminRouterDeps {
	cronStore?: CronStore;
	getAdminStatus: GetAdminStatus;
	getSession: GetSession;
	getSessionLog: GetSessionLog;
	runSessionCommand: RunSessionCommand;
	taskController: TaskControlService;
	githubService?: import("../../ports/github-service.js").GitHubService;
	adminUsername?: string;
	adminPassword?: string;
	adminAssetsDir: string;
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

function checkBasicAuth(
	request: IncomingMessage,
	response: ServerResponse,
	username: string | undefined,
	password: string | undefined,
): boolean {
	if (!username || !password) {
		return false;
	}
	const authHeader = request.headers["authorization"] as string | undefined;
	if (!authHeader || !authHeader.startsWith("Basic ")) {
		response.statusCode = 401;
		response.setHeader("WWW-Authenticate", 'Basic realm="TARS Admin"');
		response.setHeader("content-type", "text/plain; charset=utf-8");
		response.end("Unauthorized");
		return false;
	}
	const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
	const colonIndex = decoded.indexOf(":");
	const providedUser = colonIndex >= 0 ? decoded.slice(0, colonIndex) : decoded;
	const providedPass = colonIndex >= 0 ? decoded.slice(colonIndex + 1) : "";
	if (providedUser.length !== username.length || providedPass.length !== password.length) {
		response.statusCode = 401;
		response.setHeader("WWW-Authenticate", 'Basic realm="TARS Admin"');
		response.setHeader("content-type", "text/plain; charset=utf-8");
		response.end("Invalid credentials");
		return false;
	}
	const userMatch = timingSafeEqual(Buffer.from(providedUser), Buffer.from(username));
	const passMatch = timingSafeEqual(Buffer.from(providedPass), Buffer.from(password));
	if (!userMatch || !passMatch) {
		response.statusCode = 401;
		response.setHeader("WWW-Authenticate", 'Basic realm="TARS Admin"');
		response.setHeader("content-type", "text/plain; charset=utf-8");
		response.end("Invalid credentials");
		return false;
	}
	return true;
}

function mapResultToStatus(code: string): number {
	switch (code) {
		case "not_found":
			return 404;
		case "invalid_state":
			return 400;
		case "unauthorized":
			return 401;
		case "conflict":
			return 409;
		default:
			return 500;
	}
}

export async function handleAdminRoute(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
): Promise<boolean> {
	const requestUrl = new URL(request.url ?? "/", "http://localhost");
	const pathname = requestUrl.pathname;

	if (request.method === "GET" && (pathname === "/tarsadmin" || pathname === "/tarsadmin/")) {
		if (!deps.adminUsername || !deps.adminPassword) {
			sendText(response, 404, "Not found");
			return true;
		}
		if (!checkBasicAuth(request, response, deps.adminUsername, deps.adminPassword)) {
			return true;
		}
		sendHtml(response, 200, await adminHtml(deps.adminAssetsDir));
		return true;
	}

	if (request.method === "GET" && pathname.startsWith("/tarsadmin/")) {
		if (!deps.adminUsername || !deps.adminPassword) {
			sendText(response, 404, "Not found");
			return true;
		}
		if (!checkBasicAuth(request, response, deps.adminUsername, deps.adminPassword)) {
			return true;
		}
		await serveAdminAsset(response, deps.adminAssetsDir, pathname.slice("/tarsadmin/".length));
		return true;
	}

	if (request.method === "GET" && pathname === "/api/status/working") {
		if (!deps.adminUsername || !deps.adminPassword) {
			sendJson(response, 404, { error: "Not found" });
			return true;
		}
		if (!checkBasicAuth(request, response, deps.adminUsername, deps.adminPassword)) {
			return true;
		}
		try {
			const result = await deps.getAdminStatus.execute();
			if (!result.success) {
				sendJson(response, mapResultToStatus(result.code), { error: result.message });
				return true;
			}
			const workingSessions = result.data.sessions.filter((s) => s.status === "working");
			sendJson(response, 200, {
				working: workingSessions.length > 0,
				count: workingSessions.length,
				sessions: workingSessions.map((s) => ({
					owner: s.owner,
					repo: s.repo,
					issueNumber: s.issueNumber,
					status: s.status,
					lastActivity: s.lastActivity,
				})),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] status/working error: ${message}\n`);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	if (request.method === "GET" && pathname === "/api/maintenance") {
		if (!deps.adminUsername || !deps.adminPassword) {
			sendJson(response, 404, { error: "Not found" });
			return true;
		}
		if (!checkBasicAuth(request, response, deps.adminUsername, deps.adminPassword)) {
			return true;
		}
		sendJson(response, 200, { draining: deps.taskController.isDraining() });
		return true;
	}

	if (request.method === "POST" && pathname === "/api/maintenance") {
		if (!deps.adminUsername || !deps.adminPassword) {
			sendJson(response, 404, { error: "Not found" });
			return true;
		}
		if (!checkBasicAuth(request, response, deps.adminUsername, deps.adminPassword)) {
			return true;
		}
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as { enabled?: boolean };
			const enabled = body.enabled === true;
			deps.taskController.setDraining(enabled);
			process.stdout.write(`[webhook] maintenance mode ${enabled ? "enabled" : "disabled"}\n`);
			sendJson(response, 200, { draining: enabled });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] maintenance error: ${message}\n`);
			sendJson(response, 400, { error: message });
		}
		return true;
	}

	if (request.method === "GET" && pathname === "/api/status") {
		if (!deps.adminUsername || !deps.adminPassword) {
			sendJson(response, 404, { error: "Not found" });
			return true;
		}
		if (!checkBasicAuth(request, response, deps.adminUsername, deps.adminPassword)) {
			return true;
		}
		try {
			const result = await deps.getAdminStatus.execute();
			if (!result.success) {
				sendJson(response, mapResultToStatus(result.code), { error: result.message });
				return true;
			}
			sendJson(response, 200, result.data);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] status error: ${message}\n`);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	if (request.method === "GET" && pathname.startsWith("/api/sessions/")) {
		if (!deps.adminUsername || !deps.adminPassword) {
			sendJson(response, 404, { error: "Not found" });
			return true;
		}
		if (!checkBasicAuth(request, response, deps.adminUsername, deps.adminPassword)) {
			return true;
		}

		const logMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)\/(\d+)\/log$/u.exec(pathname);
		if (logMatch) {
			const [, owner, repo, issueNumberStr] = logMatch;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			if (Number.isNaN(issueNumber)) {
				sendJson(response, 400, { error: "Invalid issue number" });
				return true;
			}
			const since = requestUrl.searchParams.get("since") ?? undefined;
			try {
				const result = await deps.getSessionLog.execute(owner, repo, issueNumber, since ?? undefined);
				if (!result.success) {
					sendJson(response, mapResultToStatus(result.code), { error: result.message });
					return true;
				}
				sendJson(response, 200, result.data);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				process.stdout.write(`[webhook] log error: ${message}\n`);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		sendJson(response, 404, { error: "Not found" });
		return true;
	}

	if (request.method === "POST" && pathname.startsWith("/api/sessions/")) {
		if (!deps.adminUsername || !deps.adminPassword) {
			sendJson(response, 404, { error: "Not found" });
			return true;
		}
		if (!checkBasicAuth(request, response, deps.adminUsername, deps.adminPassword)) {
			return true;
		}

		const commandMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)\/(\d+)\/commands$/u.exec(pathname);
		if (commandMatch) {
			const [, owner, repo, issueNumberStr] = commandMatch;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			if (Number.isNaN(issueNumber)) {
				sendJson(response, 400, { error: "Invalid issue number" });
				return true;
			}
			try {
				const body = JSON.parse((await readBody(request)).toString("utf8")) as { command?: SessionCommand; payload?: Record<string, unknown> };
				if (!body.command) {
					sendJson(response, 400, { error: "Missing command" });
					return true;
				}
				const result = await deps.runSessionCommand.execute(owner, repo, issueNumber, body.command, body.payload);
				if (!result.success) {
					sendJson(response, mapResultToStatus(result.code), { error: result.message });
					return true;
				}
				sendJson(response, 200, result.data);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				process.stdout.write(`[webhook] command error: ${message}\n`);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		// Legacy per-action endpoints mapped to commands for backward compat during transition
		const legacyMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)\/(\d+)\/(\w[\w-]*)$/u.exec(pathname);
		if (legacyMatch) {
			const [, owner, repo, issueNumberStr, action] = legacyMatch;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			if (Number.isNaN(issueNumber)) {
				sendJson(response, 400, { error: "Invalid issue number" });
				return true;
			}
			const commandMap: Record<string, SessionCommand> = {
				cancel: "cancel",
				restart: "restart",
				pause: "pause",
				resume: "resume",
				delete: "delete",
				"mark-failed": "mark-failed",
				"mark-complete": "mark-complete",
				archive: "archive",
				"prune-worktree": "prune-worktree",
			};
			const command = commandMap[action];
			if (!command) {
				sendJson(response, 404, { error: "Not found" });
				return true;
			}
			try {
				let payload: Record<string, unknown> | undefined;
				if (action === "prune-worktree") {
					const body = JSON.parse((await readBody(request)).toString("utf8")) as { confirmDirty?: boolean };
					payload = body;
				}
				const result = await deps.runSessionCommand.execute(owner, repo, issueNumber, command, payload);
				if (!result.success) {
					sendJson(response, mapResultToStatus(result.code), { error: result.message });
					return true;
				}
				sendJson(response, 200, result.data);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				process.stdout.write(`[webhook] ${action} error: ${message}\n`);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		sendJson(response, 404, { error: "Not found" });
		return true;
	}

	// Cron routes
	if (pathname.startsWith("/api/crons/")) {
		if (!deps.adminUsername || !deps.adminPassword) {
			sendJson(response, 404, { error: "Not found" });
			return true;
		}
		if (!checkBasicAuth(request, response, deps.adminUsername, deps.adminPassword)) {
			return true;
		}
		if (!deps.cronStore) {
			sendJson(response, 500, { error: "Cron store not configured" });
			return true;
		}

		// GET /api/crons/:owner/:repo
		const listMatch = /^\/api\/crons\/([^/]+)\/([^/]+)$/u.exec(pathname);
		if (listMatch && request.method === "GET") {
			const [, owner, repo] = listMatch;
			try {
				const jobs = await deps.cronStore.listForRepo(owner, repo);
				sendJson(response, 200, { crons: jobs });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		// POST /api/crons/:owner/:repo
		if (listMatch && request.method === "POST") {
			const [, owner, repo] = listMatch;
			try {
				const body = JSON.parse((await readBody(request)).toString("utf8")) as {
					name?: string;
					description?: string;
					prompt?: string;
					scheduleType?: string;
					scheduleValue?: string;
					branch?: string;
					notificationChannel?: string;
				};
				if (!body.name || !body.prompt || !body.scheduleType || !body.scheduleValue) {
					sendJson(response, 400, { error: "Missing required fields: name, prompt, scheduleType, scheduleValue" });
					return true;
				}
				const job = await deps.cronStore.createJob(
					owner,
					repo,
					body.name,
					body.description || "",
					body.prompt,
					body.scheduleType as import("../../cron/store.js").CronScheduleType,
					body.scheduleValue,
					body.branch || "main",
					body.notificationChannel || null,
				);
				sendJson(response, 201, job);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 400, { error: message });
			}
			return true;
		}

		// GET /api/crons/:owner/:repo/:id
		const detailMatch = /^\/api\/crons\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(pathname);
		if (detailMatch && request.method === "GET") {
			const [, owner, repo, id] = detailMatch;
			try {
				const job = await deps.cronStore.get(owner, repo, id);
				if (!job) {
					sendJson(response, 404, { error: "Cron job not found" });
					return true;
				}
				sendJson(response, 200, job);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		// PATCH /api/crons/:owner/:repo/:id
		if (detailMatch && request.method === "PATCH") {
			const [, owner, repo, id] = detailMatch;
			try {
				const existing = await deps.cronStore.get(owner, repo, id);
				if (!existing) {
					sendJson(response, 404, { error: "Cron job not found" });
					return true;
				}
				const body = JSON.parse((await readBody(request)).toString("utf8")) as Partial<{
					name: string;
					description: string;
					prompt: string;
					scheduleType: string;
					scheduleValue: string;
					branch: string;
					notificationChannel: string;
					enabled: boolean;
				}>;
				let shouldRecompute = false;
				if (body.name !== undefined) existing.name = body.name;
				if (body.description !== undefined) existing.description = body.description;
				if (body.prompt !== undefined) existing.prompt = body.prompt;
				if (body.branch !== undefined) existing.branch = body.branch;
				if (body.notificationChannel !== undefined) existing.notificationChannel = body.notificationChannel;
				if (body.scheduleType !== undefined) {
					existing.scheduleType = body.scheduleType as import("../../cron/store.js").CronScheduleType;
					shouldRecompute = true;
				}
				if (body.scheduleValue !== undefined) {
					existing.scheduleValue = body.scheduleValue;
					shouldRecompute = true;
				}
				if (body.enabled !== undefined) {
					if (body.enabled && !existing.enabled) {
						shouldRecompute = true;
					}
					existing.enabled = body.enabled;
				}
				if (shouldRecompute) {
					existing.nextRunAt = computeNextRunAt(existing.scheduleType, existing.scheduleValue);
				}
				await deps.cronStore.set(existing);
				sendJson(response, 200, existing);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 400, { error: message });
			}
			return true;
		}

		// DELETE /api/crons/:owner/:repo/:id
		if (detailMatch && request.method === "DELETE") {
			const [, owner, repo, id] = detailMatch;
			try {
				await deps.cronStore.delete(owner, repo, id);
				sendJson(response, 200, { deleted: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		// GET /api/crons/:owner/:repo/:id/runs
		const runsMatch = /^\/api\/crons\/([^/]+)\/([^/]+)\/([^/]+)\/runs$/u.exec(pathname);
		if (runsMatch && request.method === "GET") {
			const [, owner, repo, id] = runsMatch;
			try {
				const runs = await deps.cronStore.getRuns(owner, repo, id);
				sendJson(response, 200, { runs });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		// POST /api/crons/:owner/:repo/:id/run
		const runMatch = /^\/api\/crons\/([^/]+)\/([^/]+)\/([^/]+)\/run$/u.exec(pathname);
		if (runMatch && request.method === "POST") {
			const [, owner, repo, id] = runMatch;
			try {
				const job = await deps.cronStore.get(owner, repo, id);
				if (!job) {
					sendJson(response, 404, { error: "Cron job not found" });
					return true;
				}
				job.nextRunAt = new Date().toISOString();
				await deps.cronStore.set(job);
				sendJson(response, 200, { queued: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return true;
		}
	}

	// POST /api/issues
	if (request.method === "POST" && pathname === "/api/issues") {
		if (!deps.adminUsername || !deps.adminPassword) {
			sendJson(response, 404, { error: "Not found" });
			return true;
		}
		if (!checkBasicAuth(request, response, deps.adminUsername, deps.adminPassword)) {
			return true;
		}
		if (!deps.githubService) {
			sendJson(response, 500, { error: "GitHub service not configured" });
			return true;
		}
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as {
				owner?: string;
				repo?: string;
				title?: string;
				body?: string;
				labels?: string[];
				assignees?: string[];
			};
			if (!body.owner || !body.repo || !body.title) {
				sendJson(response, 400, { error: "Missing required fields: owner, repo, title" });
				return true;
			}
			const issue = await deps.githubService.createIssue(
				body.owner,
				body.repo,
				body.title,
				body.body || "",
				body.labels,
				body.assignees,
			);
			sendJson(response, 201, issue);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	return false;
}
