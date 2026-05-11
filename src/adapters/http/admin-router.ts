import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readBody } from "../../webhook/server.js";
import { sendHtml, sendJson, sendText } from "./response-helpers.js";
import type { GetAdminStatus } from "../../app/queries/get-admin-status.js";
import type { GetSession } from "../../app/queries/get-session.js";
import type { GetSessionLog } from "../../app/queries/get-session-log.js";
import type { RunSessionCommand, SessionCommand } from "../../app/commands/run-session-command.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import { adminHtml, serveAdminAsset } from "./asset-server.js";

export interface AdminRouterDeps {
	getAdminStatus: GetAdminStatus;
	getSession: GetSession;
	getSessionLog: GetSessionLog;
	runSessionCommand: RunSessionCommand;
	taskController: TaskControlService;
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
			try {
				const result = await deps.getSessionLog.execute(owner, repo, issueNumber);
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

	return false;
}
